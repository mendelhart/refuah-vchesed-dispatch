import { cleanupPersonalRetention } from '../../domain/personal-retention.service.js';
import type { JobKind } from '@rvc/shared';
import { deliverNotification } from '../../services/notification.service.js';
import { materialiseDueRides, offerDueRecurringTrips } from '../../domain/recurring.service.js';
import { scanEquipmentDue } from '../../domain/equipment.service.js';
import { deliverAnnouncement } from '../../domain/announcements.service.js';
import { runExport } from '../../domain/exports.service.js';
import { scanLicenceExpiry } from '../../domain/licences.service.js';
import { sendShiftReminders } from '../../domain/duty.service.js';
import { purgeExpiredFiles } from '../../services/files.service.js';
import { escalateUnanswered, expireOffer } from '../../domain/dispatch.service.js';
import { purgeExpiredSessions } from '../../auth/session.js';
import { db } from '../../db/client.js';
import { authTokens } from '../../db/schema.js';
import { sql as raw } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { getNumberSetting } from '../../lib/settings.js';
import { SETTING_KEYS } from '@rvc/shared';

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export const handlers: Record<JobKind, JobHandler> = {
  'notification.deliver': async (p) => { await deliverNotification(String(p.deliveryId)); },
  'notification.retry': async (p) => { await deliverNotification(String(p.deliveryId)); },
  'offer.expire': async (p) => { await expireOffer(String(p.offerId)); },
  'trip.escalate': async (p) => { await escalateUnanswered(String(p.tripId), Number(p.round ?? 1)); },
  /**
   * Nudges an unanswered offer partway through its window. Deliberately quiet:
   * it re-sends to the volunteers who already hold a live offer rather than
   * widening the broadcast, because widening is escalation and escalation is a
   * dispatcher's decision.
   */
  'trip.reminder': async (p) => {
    const { remindPendingOffers } = await import('../../domain/dispatch.service.js');
    const sent = await remindPendingOffers(String(p.tripId), Number(p.round ?? 1));
    logger.info({ tripId: p.tripId, sent }, 'offer reminders sent');
  },

  /** Turns standing rides into real trips, then offers the ones that are due. */
  'recurring.materialise': async () => {
    const result = await materialiseDueRides();
    const offered = await offerDueRecurringTrips();
    logger.info({ ...result, offeredOnSchedule: offered }, 'standing rides processed');
  },

  'equipment.due_scan': async () => { await scanEquipmentDue(); },

  'announcement.send': async (p) => { await deliverAnnouncement(String(p.announcementId)); },

  'export.run': async (p) => { await runExport(String(p.exportId)); },

  'licence.expiry_scan': async () => { await scanLicenceExpiry(); },

  'duty.reminder_scan': async () => { await sendShiftReminders(); },
  'cleanup.sessions': async () => {
    const n = await purgeExpiredSessions();
    logger.info({ purged: n }, 'expired sessions purged');
  },
  'cleanup.tokens': async () => {
    await db.execute(raw`delete from rate_limit_buckets where expires_at < now() - interval '1 day'`);
    await db.delete(authTokens).where(raw`expires_at < now() - interval '7 days'`);
  },
  /**
   * Retention. Trips and audit events are operational history and are kept;
   * the message, delivery and call traffic around them carries personal data
   * and is aged out on a configurable window (see docs/SECURITY.md).
   */
  'cleanup.retention': async () => {
    await cleanupPersonalRetention();
    const [notifDays, smsDays, callDays] = await Promise.all([
      getNumberSetting(SETTING_KEYS.notificationRetentionDays),
      getNumberSetting(SETTING_KEYS.smsEventRetentionDays),
      getNumberSetting(SETTING_KEYS.callLogRetentionDays),
    ]);
    const notifs = await db.execute(raw`
      delete from notifications where created_at < now() - (${notifDays} || ' days')::interval
    `);
    const sms = await db.execute(raw`
      delete from sms_events where created_at < now() - (${smsDays} || ' days')::interval
    `);
    // Calls keep the row (for audit counts) but shed the personal detail.
    const calls = await db.execute(raw`
      update calls set counterparty_name = null, destination_last4 = null
      where started_at < now() - (${callDays} || ' days')::interval
        and (counterparty_name is not null or destination_last4 is not null)
    `);
    // Conversation history carries the same personal data as the SMS log.
    const smsMsgDays = await getNumberSetting(SETTING_KEYS.smsMessageRetentionDays);
    await db.execute(raw`
      delete from sms_messages where created_at < now() - (${smsMsgDays} || ' days')::interval
    `);
    await db.execute(raw`
      delete from sms_threads t
       where t.status = 'closed'
         and t.last_message_at < now() - (${smsMsgDays} || ' days')::interval
         and not exists (select 1 from sms_messages m where m.thread_id = t.id)
    `);
    const files = await purgeExpiredFiles();

    logger.info({ notifDays, smsDays, callDays, smsMsgDays, files,
      notifs: (notifs as unknown as unknown[]).length,
      sms: (sms as unknown as unknown[]).length, calls: (calls as unknown as unknown[]).length },
      'retention sweep complete');
  },
};

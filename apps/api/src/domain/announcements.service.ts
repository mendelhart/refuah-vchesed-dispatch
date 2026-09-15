import { eq, sql as raw } from 'drizzle-orm';
import { NOTIFICATION_CHANNELS, SETTING_KEYS, type NotificationChannel } from '@rvc/shared';
import { db } from '../db/client.js';
import { announcements, organizationInfo, users } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from '../lib/audit.js';
import { getNumberSetting } from '../lib/settings.js';
import { pgArray } from '../lib/pg.js';
import { notify } from '../services/notification.service.js';
import { renderTemplate } from '../services/templates.service.js';
import { enqueue } from '../jobs/queue.js';
import { logger } from '../lib/logger.js';

/**
 * Broadcasts.
 *
 * Bulk messaging is the single most expensive and most dangerous thing this
 * application can do: one click reaches every volunteer, costs real money per
 * segment, and cannot be recalled. So it is deliberately not a convenience.
 *
 *  - The audience is a saved query, not a list of ids, and it is stored on the
 *    announcement so the audit shows who was targeted and why.
 *  - The recipient count is computed and returned *before* sending, and the
 *    caller must confirm that number. A broadcast that silently grew from 40
 *    people to 500 because a filter was wrong is not recoverable.
 *  - Sending goes through `notify()` per recipient, so every message gets a
 *    delivery record and failures are visible — the same path as everything
 *    else, not a shortcut around it.
 *  - There is a hard ceiling from settings.
 *
 * Snooze is respected here, unlike for offers: a broadcast is by definition not
 * urgent enough to override somebody's evening.
 */

export interface Audience {
  groupSlugs?: string[];
  serviceSlugs?: string[];
  roles?: string[];
  /** Only volunteers who have completed at least this many trips. */
  minCompletedTrips?: number;
  /** Only volunteers available right now. */
  availableNow?: boolean;
  includeSnoozed?: boolean;
}

export async function resolveAudience(audience: Audience): Promise<Array<{ id: string; fullName: string }>> {
  const rows = await resolveAudienceRows(audience);
  return rows.map((r) => ({ id: r.id, fullName: r.full_name }));
}

async function resolveAudienceRows(
  audience: Audience,
): Promise<Array<{ id: string; full_name: string }>> {
  const roles = pgArray(audience.roles?.length ? audience.roles : ['volunteer']);
  const groupSlugs = pgArray(audience.groupSlugs ?? null);
  const serviceSlugs = pgArray(audience.serviceSlugs ?? null);
  return (await db.execute(raw`
    select distinct u.id, u.full_name
      from users u
      left join user_groups ug on ug.user_id = u.id
      left join volunteer_groups g on g.id = ug.group_id
      left join volunteer_services vs on vs.user_id = u.id
      left join service_types st on st.id = vs.service_type_id
     where u.deleted_at is null
       and u.status = 'active'
       and u.role = any(${roles}::text[])
       and (${groupSlugs}::text[] is null or g.slug = any(${groupSlugs}::text[]))
       and (${serviceSlugs}::text[] is null or st.slug = any(${serviceSlugs}::text[]))
       and (${audience.includeSnoozed ?? false}
            or u.muted_until is null or u.muted_until <= now())
       and (${audience.minCompletedTrips ?? 0} = 0
            or (select count(*) from trips t
                 where t.assigned_volunteer_id = u.id and t.status = 'completed')
               >= ${audience.minCompletedTrips ?? 0})
     order by u.full_name
  `)) as unknown as Array<{ id: string; full_name: string }>;
}

export async function previewAnnouncement(audience: Audience) {
  const recipients = await resolveAudience(audience);
  const max = await getNumberSetting(SETTING_KEYS.broadcastMaxRecipients);
  return {
    count: recipients.length,
    max,
    overLimit: recipients.length > max,
    sample: recipients.slice(0, 10).map((r) => r.fullName),
  };
}

export async function createAnnouncement(
  actor: AuditActor,
  input: { title: string; body: string; audience: Audience; channels: NotificationChannel[] },
) {
  if (!input.title.trim()) throw Errors.validation('Give the announcement a title.');
  if (!input.body.trim()) throw Errors.validation('An empty announcement has nothing to say.');
  const channels = input.channels.filter((c) => NOTIFICATION_CHANNELS.includes(c));
  if (!channels.length) throw Errors.validation('Choose at least one channel.');

  const recipients = await resolveAudience(input.audience);
  const max = await getNumberSetting(SETTING_KEYS.broadcastMaxRecipients);
  if (recipients.length > max) {
    throw Errors.validation(
      `That reaches ${recipients.length} people, above the ${max} limit. Narrow the audience, or raise announcements.max_recipients deliberately.`,
    );
  }

  const [row] = await db
    .insert(announcements)
    .values({
      title: input.title.trim(),
      body: input.body.trim(),
      audience: input.audience as Record<string, unknown>,
      channels,
      status: 'draft',
      recipientCount: recipients.length,
      createdById: actor.userId!,
    })
    .returning();

  await recordAudit({
    actor,
    action: 'announcement.created',
    entityType: 'announcement',
    entityId: row!.id,
    next: { title: row!.title, channels, recipientCount: recipients.length },
  });
  return { ...row!, recipients: recipients.length };
}

/**
 * Sends a draft.
 *
 * `confirmRecipientCount` must match what the draft was created with. If the
 * roster changed between drafting and sending, the send is refused and the
 * administrator sees the new number — because "I meant to text the forty people
 * in one group" and "I texted everybody" differ by one stale filter.
 */
export async function sendAnnouncement(
  actor: AuditActor,
  id: string,
  confirmRecipientCount: number,
) {
  const [row] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
  if (!row) throw Errors.notFound('That announcement no longer exists.');
  if (row.status !== 'draft') {
    throw Errors.conflict(`That announcement is already ${row.status}.`);
  }

  const recipients = await resolveAudience(row.audience as Audience);
  if (recipients.length !== confirmRecipientCount) {
    throw Errors.conflict(
      `This now reaches ${recipients.length} people, not the ${confirmRecipientCount} you confirmed. Check the audience and send again.`,
      { current: recipients.length, confirmed: confirmRecipientCount },
    );
  }

  await db
    .update(announcements)
    .set({ status: 'sending', recipientCount: recipients.length, updatedAt: new Date() })
    .where(eq(announcements.id, id));

  await recordAudit({
    actor,
    action: 'announcement.sent',
    entityType: 'announcement',
    entityId: id,
    next: { recipientCount: recipients.length, channels: row.channels },
  });

  await enqueue('announcement.send', { announcementId: id }, { dedupeKey: `announcement:${id}` });
  return { queued: recipients.length };
}

/** Executed by the worker so a 500-person broadcast is not an HTTP request. */
export async function deliverAnnouncement(announcementId: string): Promise<void> {
  const [row] = await db
    .select()
    .from(announcements)
    .where(eq(announcements.id, announcementId))
    .limit(1);
  if (!row || row.status === 'sent') return;

  const [org] = await db.select().from(organizationInfo).limit(1);
  const recipients = await resolveAudience(row.audience as Audience);

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      const sms = await renderTemplate('announcement.broadcast', 'sms', {
        title: row.title,
        message: row.body,
        orgName: org?.name ?? "Refuah V'Chesed",
      });
      const email = await renderTemplate('announcement.broadcast', 'email', {
        title: row.title,
        message: row.body,
        orgName: org?.name ?? "Refuah V'Chesed",
      });
      await notify({
        userId: recipient.id,
        event: 'announcement.broadcast',
        title: row.title,
        body: row.channels.includes('email') && !row.channels.includes('sms') ? email.body : sms.body,
        subject: email.subject ?? row.title,
        payload: { announcementId },
        forceChannels: row.channels as NotificationChannel[],
      });
      sent++;
    } catch (err) {
      failed++;
      logger.error({ err, userId: recipient.id, announcementId }, 'announcement queueing failed');
    }
  }

  await db
    .update(announcements)
    .set({
      status: failed === recipients.length && recipients.length > 0 ? 'failed' : 'sent',
      sentAt: new Date(),
      recipientCount: sent,
      updatedAt: new Date(),
    })
    .where(eq(announcements.id, announcementId));

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: 'announcement.delivered',
    entityType: 'announcement',
    entityId: announcementId,
    metadata: { sent, failed },
  });
}

export async function listAnnouncements(limit = 50) {
  return db
    .select({
      id: announcements.id,
      title: announcements.title,
      body: announcements.body,
      status: announcements.status,
      channels: announcements.channels,
      recipientCount: announcements.recipientCount,
      sentAt: announcements.sentAt,
      createdAt: announcements.createdAt,
      createdBy: users.fullName,
    })
    .from(announcements)
    .innerJoin(users, eq(users.id, announcements.createdById))
    .orderBy(raw`${announcements.createdAt} desc`)
    .limit(limit);
}

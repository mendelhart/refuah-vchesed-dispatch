import { and, eq, inArray, isNull, ne, sql as raw } from 'drizzle-orm';
import type { NotificationChannel, NotificationEvent, NotificationPreference } from '@rvc/shared';
import { CRITICAL_NOTIFICATION_EVENTS, SETTING_KEYS } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import {
  notificationDeliveries,
  notifications,
  pushSubscriptions,
  smsEvents,
  users,
} from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { getNumberSetting } from '../lib/settings.js';
import { logger } from '../lib/logger.js';
import {
  emailProvider,
  pushProvider,
  smsProvider,
  PushSubscriptionGoneError,
} from './providers/index.js';
import { sendWhatsAppWithFallback } from './whatsapp-failover.js';
import { callingProvider } from './providers/index.js';
import {
  VOICE_ALERT_EVENTS,
  VOICE_OFFER_EVENTS,
  voiceBlockedReason,
  voicePlacementFailed,
  voiceStillWanted,
} from './voice.service.js';
import { smsMessages } from '../db/schema.js';

/**
 * The one notification path.
 *
 * Everything that reaches a volunteer goes through `notify()`. Three properties
 * the previous implementation lacked:
 *
 *  1. **It is recorded.** A `notifications` row is the event; one
 *     `notification_deliveries` row per channel is the attempt. "Did she get
 *     the offer?" is a query, not a guess.
 *  2. **It never silently succeeds.** Delivery happens in a background job. A
 *     failure sets `status='failed'` with the provider error, and the dispatcher
 *     board surfaces it.
 *  3. **It is bounded.** Each attempt has a timeout; retries use exponential
 *     backoff up to `notifications.max_attempts`, then stop and stay visible.
 */

export interface NotifyInput {
  userId: string;
  event: NotificationEvent;
  title: string;
  body: string;
  tripId?: string | null;
  offerId?: string | null;
  payload?: Record<string, unknown>;
  /** Overrides the recipient's preference — used for offers, which must land. */
  forceChannels?: NotificationChannel[];
  /**
   * Use forceChannels exactly as given: no extra SMS for critical events.
   * For invitations, where the administrator ticked the channels themselves
   * and an unrequested text would be a surprise.
   */
  exactChannels?: boolean;
  /** Subject line for the email channel; ignored by the others. */
  subject?: string;
  /** Attach outbound SMS to this conversation thread. */
  threadId?: string;
}

let SEND_TIMEOUT_MS = 10_000;
/** Tests only: shorten the provider timeout. */
export function setSendTimeoutForTests(ms: number): void { SEND_TIMEOUT_MS = ms; }

/** A provider call that did not answer in time. The request may still have gone out. */
export class SendTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SendTimeoutError(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Which channels an event uses.
 *
 * Two rules that are not obvious from the switch:
 *
 *  - 'inapp' is always included. It is free, it never fails, and it is what
 *    makes the in-app feed complete rather than a partial mirror of the SMS.
 *  - 'none' means "no push or text", not "no notification". A volunteer who
 *    turned everything off still has a record waiting in the app, and critical
 *    events still reach them by SMS — see criticalChannels below.
 */
function channelsFor(
  preference: NotificationPreference,
  force?: NotificationChannel[],
): NotificationChannel[] {
  if (force?.length) return Array.from(new Set<NotificationChannel>([...force, 'inapp']));
  switch (preference) {
    case 'sms':
      return ['sms', 'inapp'];
    case 'push':
      return ['push', 'inapp'];
    case 'whatsapp':
      // WhatsApp is never the only carrier: a paired session can drop silently
      // and we would not know the message had not arrived.
      return ['whatsapp', 'push', 'inapp'];
    case 'voice':
      // Everyday messages go by text; only offers, cancellations and
      // reassignments ring (see applyPersonalCarrier).
      return ['sms', 'push', 'inapp'];
    case 'email':
      return ['email', 'inapp'];
    case 'both':
      return ['sms', 'push', 'inapp'];
    case 'all':
      return ['sms', 'push', 'whatsapp', 'email', 'inapp'];
    case 'none':
      return ['inapp'];
    default:
      return ['sms', 'inapp'];
  }
}

/**
 * The volunteer's own carrier.
 *
 * Offers and critical events are sent "by text" so they always land. For a
 * volunteer who chose WhatsApp or voice, "by text" means their channel:
 *  - WhatsApp: the text goes on WhatsApp (it falls back to SMS by itself when
 *    WAHA is down and Twilio is configured).
 *  - Voice: offers become a call (texted instead when unanswered, in quiet
 *    hours, or past the per-round call limit); cancellations and
 *    reassignments get a call as well as the text.
 */
async function applyPersonalCarrier(
  wanted: NotificationChannel[],
  preference: string,
  input: NotifyInput,
  exec: Executor,
): Promise<NotificationChannel[]> {
  if (input.exactChannels || input.threadId || !wanted.includes('sms')) return wanted;
  if (preference === 'whatsapp') {
    return Array.from(new Set(wanted.map((c) => (c === 'sms' ? 'whatsapp' : c))));
  }
  if (preference === 'voice') {
    const offer = VOICE_OFFER_EVENTS.includes(input.event);
    const alert = VOICE_ALERT_EVENTS.includes(input.event);
    if (!offer && !alert) return wanted;
    const blocked = await voiceBlockedReason({ event: input.event, tripId: input.tripId }, exec);
    if (blocked) {
      logger.info({ userId: input.userId, event: input.event, blocked }, 'voice call not placed; texting');
      return wanted;
    }
    return offer
      ? Array.from(new Set(wanted.map((c) => (c === 'sms' ? 'voice' : c))))
      : [...wanted, 'voice'];
  }
  return wanted;
}

/**
 * Snooze and channel preference do not apply to consequences of a commitment
 * the volunteer already made.
 *
 * Muting is how somebody says "stop offering me trips this evening". It is not
 * how they say "do not tell me the trip I accepted has been cancelled" — and
 * treating those as the same thing is how a volunteer drives to a hospital for
 * a passenger who is no longer there.
 */
function isCritical(event: NotificationEvent): boolean {
  return CRITICAL_NOTIFICATION_EVENTS.includes(event);
}

/**
 * Creates the notification and its delivery rows, then schedules delivery.
 *
 * Call this inside the transaction that made the change it describes: the
 * notification is committed with the change, and the send happens afterwards in
 * a job, so a provider outage can never roll back a trip assignment.
 */
export async function notify(input: NotifyInput, exec: Executor = db): Promise<string> {
  const [recipient] = await exec
    .select({
      id: users.id,
      phone: users.phone,
      email: users.email,
      fullName: users.fullName,
      preference: users.notificationPreference,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
    .limit(1);

  if (!recipient) {
    logger.warn({ userId: input.userId, event: input.event }, 'notification for unknown user');
    throw new Error(`Cannot notify unknown user ${input.userId}`);
  }

  const [notification] = await exec
    .insert(notifications)
    .values({
      userId: recipient.id,
      event: input.event,
      title: input.title,
      body: input.body,
      payload: {
        ...(input.payload ?? {}),
        ...(input.subject ? { __subject: input.subject } : {}),
        ...(input.threadId ? { __threadId: input.threadId } : {}),
      } as never,
      tripId: input.tripId ?? null,
      offerId: input.offerId ?? null,
    })
    .returning({ id: notifications.id });

  const notificationId = notification!.id;
  const maxAttempts = await getNumberSetting(SETTING_KEYS.notificationMaxAttempts, exec);

  let wanted = channelsFor(recipient.preference as NotificationPreference, input.forceChannels);
  if (isCritical(input.event) && !wanted.includes('sms') && !(input.exactChannels && input.forceChannels?.length)) {
    // A critical event always gets a carrier that reaches a locked phone.
    wanted = [...wanted, 'sms'];
  }
  wanted = await applyPersonalCarrier(wanted, recipient.preference, input, exec);

  const subs = wanted.includes('push')
    ? await exec
        .select({ id: pushSubscriptions.id })
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, recipient.id), isNull(pushSubscriptions.disabledAt)))
    : [];

  const rows = wanted.map((channel) => {
    // A channel with nowhere to send is recorded as 'skipped', not silently dropped:
    // "this volunteer has no phone number on file" is an operational fact someone
    // needs to see.
    let status: 'queued' | 'skipped' = 'queued';
    let lastError: string | null = null;
    if ((channel === 'sms' || channel === 'whatsapp' || channel === 'voice') && !recipient.phone) {
      status = 'skipped';
      lastError = 'no phone number on file';
    }
    if (channel === 'push' && subs.length === 0) {
      status = 'skipped';
      lastError = 'no push subscription registered';
    }
    if (channel === 'email' && !recipient.email) {
      status = 'skipped';
      lastError = 'no email address on file';
    }
    const destination =
      channel === 'sms' || channel === 'whatsapp' || channel === 'voice'
        ? recipient.phone
        : channel === 'email'
          ? recipient.email
          : null;
    return {
      notificationId,
      channel,
      status,
      maxAttempts,
      destination,
      lastError,
      nextAttemptAt: status === 'queued' ? new Date() : null,
    };
  });

  const inserted = await exec
    .insert(notificationDeliveries)
    .values(rows)
    .returning({ id: notificationDeliveries.id, status: notificationDeliveries.status });

  for (const row of inserted) {
    if (row.status === 'queued') {
      await enqueue(
        'notification.deliver',
        { deliveryId: row.id },
        { dedupeKey: `delivery:${row.id}`, maxAttempts },
        exec,
      );
    }
  }

  return notificationId;
}

/** Fan-out helper. Failures for one recipient never abort the others. */
export async function notifyMany(inputs: NotifyInput[], exec: Executor = db): Promise<void> {
  for (const input of inputs) {
    try {
      await notify(input, exec);
    } catch (err) {
      logger.error({ err, userId: input.userId, event: input.event }, 'failed to queue notification');
    }
  }
}

/** Executed by the worker; see jobs/handlers/notification.ts. */
export async function deliverNotification(deliveryId: string): Promise<void> {
  const [row] = await db
    .select({
      id: notificationDeliveries.id,
      channel: notificationDeliveries.channel,
      status: notificationDeliveries.status,
      attempts: notificationDeliveries.attempts,
      maxAttempts: notificationDeliveries.maxAttempts,
      destination: notificationDeliveries.destination,
      notificationId: notificationDeliveries.notificationId,
      title: notifications.title,
      body: notifications.body,
      event: notifications.event,
      tripId: notifications.tripId,
      offerId: notifications.offerId,
      userId: notifications.userId,
      payload: notifications.payload,
    })
    .from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .where(eq(notificationDeliveries.id, deliveryId))
    .limit(1);

  if (!row) return;
  if (row.status === 'delivered' || row.status === 'failed' || row.status === 'skipped' || row.status === 'unknown') return;

  const attempts = row.attempts + 1;

  try {
    if (row.channel === 'inapp') {
      await db
        .update(notificationDeliveries)
        .set({ status: 'delivered', attempts, deliveredAt: new Date(), sentAt: new Date() })
        .where(eq(notificationDeliveries.id, deliveryId));
      return;
    }

    if (row.channel === 'sms') {
      if (!row.destination) throw new Error('no destination phone number');
      const result = await withTimeout(
        smsProvider.send(row.destination, `${row.body}`),
        SEND_TIMEOUT_MS,
        'SMS send',
      );
      // Order matters. The message has already left; the row that stops us
      // sending it again must be committed before anything else can fail.
      // Writing both in one transaction meant a duplicate-key collision on the
      // outbound log rolled the 'sent' flag back and the retry texted the
      // volunteer a second time.
      await db
        .update(notificationDeliveries)
        .set({
          status: 'sent',
          attempts,
          sentAt: new Date(),
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          lastError: null,
        })
        .where(eq(notificationDeliveries.id, deliveryId));

      // When this message is a dispatcher's reply in a conversation, record it
      // on the thread so the console shows both halves. Best effort, after the
      // send is committed, for the same reason as the log below.
      const threadId = (row.payload as Record<string, unknown> | null)?.__threadId;
      if (typeof threadId === 'string') {
        try {
          await db.insert(smsMessages).values({
            threadId,
            direction: 'outbound',
            body: row.body,
            channel: 'sms',
            providerSid: result.providerMessageId,
            deliveryId,
            status: 'sent',
          });
        } catch (err) {
          logger.warn({ err, deliveryId, threadId }, 'could not attach outbound SMS to its thread');
        }
      }

      // The outbound log is useful, not load-bearing: never let it undo a send.
      try {
        await db
          .insert(smsEvents)
          .values({
            direction: 'outbound',
            toNumber: row.destination,
            body: row.body.slice(0, 1000),
            providerSid: result.providerMessageId,
            signatureValid: true,
            matchedUserId: row.userId,
            matchedOfferId: row.offerId,
            outcome: 'sent',
          })
          .onConflictDoNothing();
      } catch (err) {
        logger.warn({ err, deliveryId }, 'could not write the outbound SMS log entry');
      }
      return;
    }

    if (row.channel === 'whatsapp') {
      if (!row.destination) throw new Error('no destination phone number');
      // Fall back to SMS only if this notification is not already going by
      // SMS; otherwise the volunteer would get the same text twice.
      const [smsSibling] = await db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(and(eq(notificationDeliveries.notificationId, row.notificationId), eq(notificationDeliveries.channel, 'sms')))
        .limit(1);
      const result = await withTimeout(
        sendWhatsAppWithFallback(row.destination, row.body, { allowSmsFallback: !smsSibling }),
        SEND_TIMEOUT_MS * 2,
        'WhatsApp send',
      );
      await db
        .update(notificationDeliveries)
        .set({
          status: 'sent',
          attempts,
          sentAt: new Date(),
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          carriedBy: result.carriedBy,
          fallbackReason: result.fallbackReason,
          lastError: null,
        })
        .where(eq(notificationDeliveries.id, deliveryId));
      return;
    }

    if (row.channel === 'voice') {
      if (!row.destination) throw new Error('no destination phone number');
      const still = await voiceStillWanted(deliveryId);
      if (!still.ok) {
        await db
          .update(notificationDeliveries)
          .set({ status: 'skipped', attempts, lastError: still.reason ?? 'not needed' })
          .where(eq(notificationDeliveries.id, deliveryId));
        return;
      }
      let placed;
      try {
        placed = await withTimeout(
          callingProvider.announce({ to: row.destination, deliveryId }),
          SEND_TIMEOUT_MS,
          'voice call',
        );
      } catch (err) {
        // A call that cannot be placed is not retried for minutes on end:
        // the offer goes by text now.
        await db.update(notificationDeliveries).set({ attempts }).where(eq(notificationDeliveries.id, deliveryId));
        await voicePlacementFailed(deliveryId, err instanceof Error ? err.message : String(err));
        return;
      }
      // 'sent' = the phone is ringing. The status callback settles it:
      // answered, retried, or texted instead.
      await db
        .update(notificationDeliveries)
        .set({
          status: 'sent',
          attempts,
          sentAt: new Date(),
          provider: placed.provider,
          providerMessageId: placed.providerCallId,
          carriedBy: 'voice',
          voiceOutcome: null,
          lastError: null,
        })
        .where(eq(notificationDeliveries.id, deliveryId));
      return;
    }

    if (row.channel === 'email') {
      if (!row.destination) throw new Error('no destination email address');
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const subject = typeof payload.__subject === 'string' ? payload.__subject : row.title;
      const result = await withTimeout(
        emailProvider.send({ to: row.destination, subject, text: row.body }),
        SEND_TIMEOUT_MS,
        'email send',
      );
      await db
        .update(notificationDeliveries)
        .set({
          status: 'sent',
          attempts,
          sentAt: new Date(),
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          lastError: null,
        })
        .where(eq(notificationDeliveries.id, deliveryId));
      return;
    }

    if (row.channel === 'push') {
      const subs = await db
        .select()
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, row.userId), isNull(pushSubscriptions.disabledAt)));

      if (subs.length === 0) throw new Error('no active push subscription');

      let anySucceeded = false;
      let lastError: string | null = null;
      const gone: string[] = [];

      for (const sub of subs) {
        try {
          await withTimeout(
            pushProvider.send(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              { title: row.title, body: row.body, data: { ...(row.payload ?? {}), tripId: row.tripId, event: row.event } },
            ),
            SEND_TIMEOUT_MS,
            'push send',
          );
          anySucceeded = true;
          void db
            .update(pushSubscriptions)
            .set({ lastUsedAt: new Date(), failureCount: 0 })
            .where(eq(pushSubscriptions.id, sub.id))
            .catch(() => {});
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (err instanceof PushSubscriptionGoneError) gone.push(sub.id);
        }
      }

      if (gone.length) {
        await db
          .update(pushSubscriptions)
          .set({ disabledAt: new Date() })
          .where(inArray(pushSubscriptions.id, gone));
      }

      if (!anySucceeded) throw new Error(lastError ?? 'push delivery failed');

      await db
        .update(notificationDeliveries)
        .set({
          status: 'delivered',
          attempts,
          sentAt: new Date(),
          deliveredAt: new Date(),
          provider: pushProvider.name,
          lastError: null,
        })
        .where(eq(notificationDeliveries.id, deliveryId));
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A timeout is not a failure we can safely retry: the provider may have
    // accepted the request and the person may already have the message. Record
    // it as 'unknown' (visible on the Notifications screen) and stop, rather
    // than risk sending the same offer twice. Push is excluded: it only
    // reaches here after every subscription failed outright.
    if (err instanceof SendTimeoutError && row.channel !== 'push') {
      await db
        .update(notificationDeliveries)
        .set({ status: 'unknown', attempts, lastError: `${message}; may have been sent, not retried`.slice(0, 1000), nextAttemptAt: null })
        .where(eq(notificationDeliveries.id, deliveryId));
      logger.warn({ deliveryId, channel: row.channel, event: row.event }, 'notification outcome unknown after provider timeout');
      return;
    }
    const exhausted = attempts >= row.maxAttempts;
    const backoff = await getNumberSetting(SETTING_KEYS.notificationRetryBackoffSeconds);
    await db
      .update(notificationDeliveries)
      .set({
        status: exhausted ? 'failed' : 'queued',
        attempts,
        lastError: message.slice(0, 1000),
        failedAt: exhausted ? new Date() : null,
        nextAttemptAt: exhausted ? null : new Date(Date.now() + backoff * 1000 * 2 ** (attempts - 1)),
      })
      .where(eq(notificationDeliveries.id, deliveryId));

    if (exhausted) {
      logger.error({ deliveryId, channel: row.channel, event: row.event, err: message },
        'notification permanently failed');
      return; // Job is done: the failure is recorded and visible, not retried forever.
    }
    throw err; // Let the job runner apply its own backoff and retry.
  }
}

/** Twilio status callbacks land here so 'sent' can become 'delivered'/'failed'. */
export async function recordSmsStatusCallback(
  providerMessageId: string,
  status: string,
  errorMessage?: string | null,
): Promise<void> {
  const delivered = ['delivered'].includes(status);
  const failed = ['failed', 'undelivered'].includes(status);
  if (!delivered && !failed) return;
  await db
    .update(notificationDeliveries)
    .set({
      status: delivered ? 'delivered' : 'failed',
      deliveredAt: delivered ? new Date() : null,
      failedAt: failed ? new Date() : null,
      lastError: failed ? (errorMessage ?? status) : null,
    })
    .where(and(
      eq(notificationDeliveries.providerMessageId, providerMessageId),
      // A late or out-of-order 'failed' must not undo a confirmed delivery.
      delivered ? raw`true` : ne(notificationDeliveries.status, 'delivered'),
    ));
}

/** Operational health used by the dispatcher board and /health. */
export async function deliveryHealth(sinceHours = 24): Promise<{
  failed: number;
  queued: number;
  skipped: number;
  delivered: number;
}> {
  const [row] = await db
    .select({
      failed: raw<number>`count(*) filter (where ${notificationDeliveries.status} = 'failed')::int`,
      queued: raw<number>`count(*) filter (where ${notificationDeliveries.status} = 'queued')::int`,
      skipped: raw<number>`count(*) filter (where ${notificationDeliveries.status} = 'skipped')::int`,
      delivered: raw<number>`count(*) filter (where ${notificationDeliveries.status} in ('delivered','sent'))::int`,
    })
    .from(notificationDeliveries)
    .where(raw`${notificationDeliveries.queuedAt} > now() - (${sinceHours} || ' hours')::interval`);
  return row ?? { failed: 0, queued: 0, skipped: 0, delivered: 0 };
}

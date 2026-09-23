/**
 * Automated voice calls to volunteers.
 *
 * A volunteer who picks "Voice call" gets ride offers as a phone call: the
 * call reads the trip, and they press 1 (or say yes) to take it, 2 (or no) to
 * pass, 9 to hear it again. Accepting goes through the same claimTrip() as the
 * app and SMS, so two people can never both get the trip.
 *
 * Rules (docs/VOICE_CALLS.md):
 *  - Only offers, cancellations and reassignments call. Everything else texts.
 *  - Quiet hours (default 22:00-07:00): no calls; offers go by text instead,
 *    except urgent and emergency trips.
 *  - An offer call that is not answered (no answer, busy, voicemail) is tried
 *    once more after a couple of minutes, then the offer goes by text. Urgent
 *    trips go to text after the first miss.
 *  - Answered but no choice made: the offer follows by text.
 *  - At most N calls per offer round; the rest get a text.
 *  - English only.
 */
import twilio from 'twilio';
import { and, eq, sql as raw } from 'drizzle-orm';
import { SETTING_KEYS, type NotificationEvent } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { addresses, notificationDeliveries, notifications, tripOffers, trips, users } from '../db/schema.js';
import { enqueue } from '../jobs/queue.js';
import { getNumberSetting } from '../lib/settings.js';
import { localParts, formatWhen } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { claimTrip } from '../domain/dispatch.service.js';
import type { AuthenticatedUser } from '../auth/session.js';

/** Events that may be carried by a call. Offers replace the text; the others add a call to it. */
export const VOICE_OFFER_EVENTS: NotificationEvent[] = ['trip.offered'];
export const VOICE_ALERT_EVENTS: NotificationEvent[] = ['trip.cancelled', 'trip.reassigned'];

const VOICE_ACTOR: AuditActor = { userId: null, name: 'Voice calls', role: 'system' };
const SAY = { voice: 'alice', language: 'en-US' } as const;

// ---------------------------------------------------------------------------
// When a call may be placed
// ---------------------------------------------------------------------------

export function isUrgent(priority: string | null | undefined): boolean {
  return priority === 'urgent' || priority === 'emergency';
}

/** True when the clock (org time) is inside quiet hours. */
export async function inQuietHours(now = new Date(), exec: Executor = db): Promise<boolean> {
  const start = await getNumberSetting(SETTING_KEYS.voiceQuietStartHour, exec);
  const end = await getNumberSetting(SETTING_KEYS.voiceQuietEndHour, exec);
  if (start === end) return false; // quiet hours switched off
  const hour = localParts(now).hour;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Decides whether this notification should ring the volunteer.
 * Returns null when it may, or the reason it may not.
 */
export async function voiceBlockedReason(
  args: { event: NotificationEvent; tripId?: string | null },
  exec: Executor = db,
): Promise<string | null> {
  let priority: string | null = null;
  if (args.tripId) {
    const [t] = await exec.select({ priority: trips.priority }).from(trips).where(eq(trips.id, args.tripId)).limit(1);
    priority = t?.priority ?? null;
  }
  if (!isUrgent(priority) && (await inQuietHours(new Date(), exec))) return 'quiet hours';

  if (VOICE_OFFER_EVENTS.includes(args.event) && args.tripId) {
    const cap = await getNumberSetting(SETTING_KEYS.voiceMaxCallsPerRound, exec);
    const rows = (await exec.execute(raw`
      select count(*)::int as n
        from notification_deliveries d
        join notifications n on n.id = d.notification_id
       where n.trip_id = ${args.tripId}
         and n.event = 'trip.offered'
         and d.channel = 'voice'
         and d.queued_at > now() - interval '15 minutes'
    `)) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) >= cap) return 'call limit for this round reached';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context for a call
// ---------------------------------------------------------------------------

interface CallContext {
  deliveryId: string;
  notificationId: string;
  event: NotificationEvent;
  body: string;
  attempts: number;
  maxAttempts: number;
  status: string;
  voiceOutcome: string | null;
  destination: string | null;
  userId: string;
  firstName: string;
  offerId: string | null;
  offerStatus: string | null;
  offerExpiresAt: Date | null;
  tripId: string | null;
  reference: string | null;
  priority: string | null;
}

async function loadContext(deliveryId: string): Promise<CallContext | null> {
  const [row] = await db
    .select({
      deliveryId: notificationDeliveries.id,
      notificationId: notificationDeliveries.notificationId,
      attempts: notificationDeliveries.attempts,
      maxAttempts: notificationDeliveries.maxAttempts,
      status: notificationDeliveries.status,
      voiceOutcome: notificationDeliveries.voiceOutcome,
      destination: notificationDeliveries.destination,
      channel: notificationDeliveries.channel,
      event: notifications.event,
      body: notifications.body,
      userId: notifications.userId,
      offerId: notifications.offerId,
      tripId: notifications.tripId,
      fullName: users.fullName,
    })
    .from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(eq(notificationDeliveries.id, deliveryId))
    .limit(1);
  if (!row || row.channel !== 'voice') return null;

  let offer: { status: string; expiresAt: Date } | undefined;
  if (row.offerId) {
    [offer] = await db.select({ status: tripOffers.status, expiresAt: tripOffers.expiresAt })
      .from(tripOffers).where(eq(tripOffers.id, row.offerId)).limit(1);
  }
  let trip: { reference: string; priority: string } | undefined;
  if (row.tripId) {
    [trip] = await db.select({ reference: trips.reference, priority: trips.priority })
      .from(trips).where(eq(trips.id, row.tripId)).limit(1);
  }
  return {
    deliveryId: row.deliveryId,
    notificationId: row.notificationId,
    event: row.event as NotificationEvent,
    body: row.body,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    status: row.status,
    voiceOutcome: row.voiceOutcome,
    destination: row.destination,
    userId: row.userId,
    firstName: row.fullName.split(/\s+/)[0] ?? '',
    offerId: row.offerId,
    offerStatus: offer?.status ?? null,
    offerExpiresAt: offer?.expiresAt ?? null,
    tripId: row.tripId,
    reference: trip?.reference ?? null,
    priority: trip?.priority ?? null,
  };
}

function offerOpen(ctx: CallContext): boolean {
  return ctx.offerStatus === 'pending' && !!ctx.offerExpiresAt && ctx.offerExpiresAt.getTime() > Date.now();
}

function isOffer(ctx: CallContext): boolean {
  return VOICE_OFFER_EVENTS.includes(ctx.event) && !!ctx.offerId;
}

/** "RVC-0042" -> "R V C, 0 0 4 2": read character by character. */
function spell(reference: string): string {
  return reference
    .split(/[-\s]+/)
    .map((part) => part.split('').join(' '))
    .join(', ');
}

function areaOf(address: { line1: string; city: string }): string {
  return `${address.line1.replace(/^\s*\d+[A-Za-z]?\s+/, '')}, ${address.city}`;
}

/** What the call says about the trip. Built at answer time so it is current. */
export async function offerScript(ctx: CallContext): Promise<string> {
  if (!ctx.tripId) return ctx.body;
  const [t] = await db
    .select({
      reference: trips.reference,
      priority: trips.priority,
      pickupAt: trips.pickupAt,
      mobilityNeeds: trips.mobilityNeeds,
      pickupAddressId: trips.pickupAddressId,
      dropoffAddressId: trips.dropoffAddressId,
    })
    .from(trips)
    .where(eq(trips.id, ctx.tripId))
    .limit(1);
  if (!t) return ctx.body;
  const [pickup] = await db.select().from(addresses).where(eq(addresses.id, t.pickupAddressId)).limit(1);
  const [dropoff] = await db.select().from(addresses).where(eq(addresses.id, t.dropoffAddressId)).limit(1);
  const needs = t.mobilityNeeds.filter((n) => n !== 'none').map((n) => n.replace(/_/g, ' '));
  return [
    `Hello ${ctx.firstName}. This is Refuah V'Chesed dispatch with a ride request.`,
    isUrgent(t.priority) ? `This one is ${t.priority}.` : '',
    `Trip ${spell(t.reference)}.`,
    pickup ? `Pickup at ${areaOf(pickup)}, ${formatWhen(t.pickupAt)}.` : `Pickup ${formatWhen(t.pickupAt)}.`,
    dropoff ? `Going to ${areaOf(dropoff)}.` : '',
    needs.length ? `The passenger needs: ${needs.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// TwiML
// ---------------------------------------------------------------------------

function answerUrl(deliveryId: string, repeats: number): string {
  return `/webhooks/twilio/voice-notify/${deliveryId}/answer?r=${repeats}`;
}

function offerTwiml(deliveryId: string, script: string, repeats: number, prefix = ''): string {
  const r = new twilio.twiml.VoiceResponse();
  const gather = r.gather({
    input: ['dtmf', 'speech'],
    numDigits: 1,
    timeout: 8,
    speechTimeout: 'auto',
    hints: 'yes, no, repeat',
    language: 'en-US',
    action: answerUrl(deliveryId, repeats),
    method: 'POST',
  });
  gather.say(SAY, `${prefix}${script} Press 1 or say yes to take it. Press 2 or say no to pass. Press 9 to hear it again.`);
  // No input: Twilio falls through to here.
  r.redirect({ method: 'POST' }, answerUrl(deliveryId, repeats + 1) + '&timeout=1');
  return r.toString();
}

function sayAndHangUp(text: string): string {
  const r = new twilio.twiml.VoiceResponse();
  r.say(SAY, text);
  r.hangup();
  return r.toString();
}

async function setOutcome(deliveryId: string, outcome: string): Promise<void> {
  await db.update(notificationDeliveries).set({ voiceOutcome: outcome }).where(eq(notificationDeliveries.id, deliveryId));
}

/** First request when the call connects. */
export async function voiceNotifyTwiml(deliveryId: string, answeredBy?: string): Promise<string> {
  const ctx = await loadContext(deliveryId);
  if (!ctx) return sayAndHangUp('Sorry, this call could not be completed. Goodbye.');

  if (answeredBy && (answeredBy.startsWith('machine') || answeredBy === 'fax')) {
    await setOutcome(deliveryId, 'voicemail');
    const r = new twilio.twiml.VoiceResponse();
    r.hangup();
    return r.toString();
  }

  if (!isOffer(ctx)) {
    const text = `Hello ${ctx.firstName}. This is Refuah V'Chesed dispatch. ${ctx.body}`;
    await setOutcome(deliveryId, 'heard');
    const r = new twilio.twiml.VoiceResponse();
    r.say(SAY, text);
    r.pause({ length: 1 });
    r.say(SAY, `Again: ${ctx.body} The details are also in your text messages. Goodbye.`);
    r.hangup();
    return r.toString();
  }

  if (!offerOpen(ctx)) {
    await setOutcome(deliveryId, 'taken');
    return sayAndHangUp(
      `Hello ${ctx.firstName}. This is Refuah V'Chesed dispatch. Trip ${spell(ctx.reference ?? '')} has already been taken. Thank you. Goodbye.`,
    );
  }
  return offerTwiml(deliveryId, await offerScript(ctx), 0);
}

function volunteerActor(ctx: CallContext, fullName: string): { user: AuthenticatedUser; audit: AuditActor } {
  return {
    user: {
      id: ctx.userId,
      sessionId: 'voice',
      email: '',
      fullName,
      role: 'volunteer',
      status: 'active',
      phone: ctx.destination,
      groups: [],
      notificationPreference: 'voice',
      mustChangePassword: false,
      navHidden: [],
    },
    audit: { userId: ctx.userId, name: fullName, role: 'volunteer' },
  };
}

export type VoiceChoice = 'accept' | 'decline' | 'repeat' | 'none';

export function parseChoice(digits?: string, speech?: string): VoiceChoice {
  const d = (digits ?? '').trim();
  if (d === '1') return 'accept';
  if (d === '2') return 'decline';
  if (d === '9') return 'repeat';
  const s = (speech ?? '').toLowerCase();
  if (/\b(no|nope|pass|decline|can't|cannot)\b/.test(s)) return 'decline';
  if (/\b(yes|yeah|yep|sure|accept|take)\b/.test(s)) return 'accept';
  if (/\b(repeat|again|what)\b/.test(s)) return 'repeat';
  return 'none';
}

/** The volunteer pressed a key or spoke (or said nothing). Returns TwiML. */
export async function voiceAnswerTwiml(
  deliveryId: string,
  input: { digits?: string; speech?: string; repeats: number; timedOut?: boolean },
): Promise<string> {
  const ctx = await loadContext(deliveryId);
  if (!ctx || !isOffer(ctx)) return sayAndHangUp('Goodbye.');

  const choice = input.timedOut ? 'none' : parseChoice(input.digits, input.speech);

  if (choice === 'accept') {
    const [u] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, ctx.userId)).limit(1);
    const outcome = await claimTrip(volunteerActor(ctx, u?.fullName ?? 'Volunteer'), { tripId: ctx.tripId!, channel: 'voice' });
    if (outcome.ok) {
      await setOutcome(deliveryId, 'accepted');
      return sayAndHangUp(`Thank you. Trip ${spell(outcome.reference ?? ctx.reference ?? '')} is yours. The full details are coming by text now. Goodbye.`);
    }
    await setOutcome(deliveryId, 'taken');
    const why = outcome.reason === 'expired' ? 'That offer has expired.' : 'Another volunteer took this trip first.';
    return sayAndHangUp(`Sorry. ${why} Thank you for answering. Goodbye.`);
  }

  if (choice === 'decline') {
    await db.update(tripOffers)
      .set({ status: 'declined', respondedAt: new Date(), responseChannel: 'voice' })
      .where(and(eq(tripOffers.id, ctx.offerId!), eq(tripOffers.status, 'pending')));
    await setOutcome(deliveryId, 'declined');
    return sayAndHangUp("OK, we'll offer it to someone else. Thank you. Goodbye.");
  }

  if (input.repeats >= 3) {
    // Heard it three times with no choice: the text will have the code.
    await setOutcome(deliveryId, 'no_choice');
    return sayAndHangUp('We will send you the details by text. You can reply there or in the app. Goodbye.');
  }
  if (!offerOpen(ctx)) {
    await setOutcome(deliveryId, 'taken');
    return sayAndHangUp('This trip has just been taken. Thank you. Goodbye.');
  }
  const prefix = choice === 'none' && !input.timedOut ? "Sorry, I didn't catch that. " : '';
  return offerTwiml(deliveryId, await offerScript(ctx), input.repeats + (choice === 'repeat' ? 1 : 0), prefix);
}

// ---------------------------------------------------------------------------
// After the call
// ---------------------------------------------------------------------------

async function queueTextInstead(ctx: CallContext, reason: string): Promise<boolean> {
  if (!ctx.destination) return false;
  const [existing] = await db.select({ id: notificationDeliveries.id }).from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.notificationId, ctx.notificationId), eq(notificationDeliveries.channel, 'sms')))
    .limit(1);
  if (!existing) {
    const [row] = await db.insert(notificationDeliveries).values({
      notificationId: ctx.notificationId,
      channel: 'sms',
      status: 'queued',
      maxAttempts: ctx.maxAttempts,
      destination: ctx.destination,
      nextAttemptAt: new Date(),
    }).returning({ id: notificationDeliveries.id });
    await enqueue('notification.deliver', { deliveryId: row!.id }, { dedupeKey: `delivery:${row!.id}`, maxAttempts: ctx.maxAttempts });
  }
  await db.update(notificationDeliveries)
    .set({ status: 'sent', carriedBy: 'sms', fallbackReason: reason.slice(0, 300) })
    .where(eq(notificationDeliveries.id, ctx.deliveryId));
  return true;
}

async function auditCall(ctx: CallContext, outcome: string, detail: string): Promise<void> {
  if (!ctx.tripId) return;
  const [u] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, ctx.userId)).limit(1);
  await recordAudit({
    actor: VOICE_ACTOR,
    action: 'trip.voice_call',
    entityType: 'trip',
    entityId: ctx.tripId,
    metadata: { volunteer: u?.fullName ?? null, volunteerId: ctx.userId, event: ctx.event, outcome, detail, deliveryId: ctx.deliveryId },
  });
}

const STATUS_OUTCOME: Record<string, string> = {
  'no-answer': 'no_answer',
  busy: 'busy',
  failed: 'failed',
  canceled: 'failed',
};

/**
 * Final call status. Decides between done, one more try, and a text.
 * `callStatus` uses Twilio's words: completed, no-answer, busy, failed, canceled.
 */
export async function voiceCallEnded(deliveryId: string, args: { callStatus: string; answeredBy?: string }): Promise<void> {
  const ctx = await loadContext(deliveryId);
  if (!ctx) return;
  if (ctx.status === 'delivered' || ctx.status === 'failed' || ctx.status === 'skipped') return;

  const machine = !!args.answeredBy && (args.answeredBy.startsWith('machine') || args.answeredBy === 'fax');
  let outcome = ctx.voiceOutcome;
  if (!outcome) outcome = machine ? 'voicemail' : STATUS_OUTCOME[args.callStatus] ?? (args.callStatus === 'completed' ? 'no_choice' : 'failed');
  await setOutcome(deliveryId, outcome);

  // Reached a person and it was settled on the call.
  if (['accepted', 'declined', 'taken', 'heard'].includes(outcome)) {
    await db.update(notificationDeliveries)
      .set({ status: 'delivered', deliveredAt: new Date(), lastError: null })
      .where(eq(notificationDeliveries.id, deliveryId));
    await auditCall(ctx, outcome, 'answered');
    return;
  }

  const labels: Record<string, string> = {
    no_choice: 'answered, no choice made',
    no_answer: 'no answer',
    busy: 'line busy',
    voicemail: 'went to voicemail',
    failed: 'call failed',
  };
  const label = labels[outcome] ?? outcome;

  if (!isOffer(ctx)) {
    // Cancellations and reassignments already went by text as well.
    await db.update(notificationDeliveries)
      .set({ status: 'sent', fallbackReason: `${label} - the text covers it` })
      .where(eq(notificationDeliveries.id, deliveryId));
    await auditCall(ctx, outcome, 'text sent as well');
    return;
  }

  if (!offerOpen(ctx)) {
    await db.update(notificationDeliveries)
      .set({ status: 'sent', fallbackReason: `${label}; offer closed before a retry` })
      .where(eq(notificationDeliveries.id, deliveryId));
    await auditCall(ctx, outcome, 'offer already closed');
    return;
  }

  const retryable = outcome !== 'no_choice' && ctx.attempts < 2 && !isUrgent(ctx.priority);
  if (retryable) {
    const minutes = await getNumberSetting(SETTING_KEYS.voiceRetryMinutes);
    const runAt = new Date(Date.now() + minutes * 60_000);
    await db.update(notificationDeliveries)
      .set({ status: 'queued', nextAttemptAt: runAt, lastError: label })
      .where(eq(notificationDeliveries.id, deliveryId));
    await enqueue('notification.deliver', { deliveryId }, { runAt, dedupeKey: `delivery:${deliveryId}:retry${ctx.attempts}` });
    await auditCall(ctx, outcome, `calling again in ${minutes} min`);
    return;
  }

  const reason = `Call: ${label}${ctx.attempts > 1 ? ` (${ctx.attempts} calls)` : ''} - texted instead`;
  const texted = await queueTextInstead(ctx, reason);
  if (!texted) {
    await db.update(notificationDeliveries)
      .set({ status: 'failed', failedAt: new Date(), lastError: `${label}; no number to text` })
      .where(eq(notificationDeliveries.id, deliveryId));
  }
  await auditCall(ctx, outcome, texted ? 'texted instead' : 'could not text');
  logger.info({ deliveryId, outcome }, 'voice offer fell back to text');
}

/** Used by the delivery worker before dialling: is there still a point? */
export async function voiceStillWanted(deliveryId: string): Promise<{ ok: boolean; reason?: string }> {
  const ctx = await loadContext(deliveryId);
  if (!ctx) return { ok: false, reason: 'not a voice delivery' };
  if (isOffer(ctx) && !offerOpen(ctx)) return { ok: false, reason: 'offer no longer open' };
  return { ok: true };
}

/** The call could not even be placed (provider error): text instead right away. */
export async function voicePlacementFailed(deliveryId: string, message: string): Promise<void> {
  const ctx = await loadContext(deliveryId);
  if (!ctx) return;
  await setOutcome(deliveryId, 'failed');
  const reason = `Call could not be placed (${message}) - texted instead`;
  if (isOffer(ctx) && !offerOpen(ctx)) {
    await db.update(notificationDeliveries)
      .set({ status: 'skipped', lastError: 'offer no longer open' })
      .where(eq(notificationDeliveries.id, deliveryId));
    return;
  }
  const texted = await queueTextInstead(ctx, reason);
  if (!texted) {
    await db.update(notificationDeliveries)
      .set({ status: 'failed', failedAt: new Date(), lastError: message.slice(0, 1000) })
      .where(eq(notificationDeliveries.id, deliveryId));
  }
  await auditCall(ctx, 'failed', texted ? 'texted instead' : 'could not text');
}

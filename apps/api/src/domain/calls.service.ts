import { and, desc, eq, isNull, sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calls, contacts, trips, users } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { last4 } from '../lib/phone.js';
import { getNumberSetting } from '../lib/settings.js';
import { SETTING_KEYS } from '@rvc/shared';
import { callingProvider } from '../services/providers/index.js';
import type { AuthenticatedUser } from '../auth/session.js';

/**
 * Masked calling — one implementation, authorised server-side.
 *
 * The legacy app had two competing implementations, both broken, and one of
 * them let any authenticated user dial any number in the world by choosing a
 * `recipientType` in the request body. Here the caller never supplies a phone
 * number at all: they name a *relationship* (the caller on trip X, the
 * volunteer on trip X, an org contact) and the server resolves the number only
 * if that relationship actually entitles them to it.
 */
export interface StartCallArgs {
  tripId?: string;
  counterparty: 'caller' | 'volunteer' | 'contact';
  contactId?: string;
}

export async function startCall(
  user: AuthenticatedUser, audit: AuditActor, args: StartCallArgs,
) {
  if (!user.phone) {
    throw Errors.validation('Add your own phone number in Settings before placing calls — the system rings you first.');
  }

  // Rate limit per user per day: a stolen session cannot run up a phone bill.
  const dailyLimit = await getNumberSetting(SETTING_KEYS.callDailyLimitPerUser);
  const todayRows = (await db.execute(raw`
    select count(*)::int as n from calls
    where initiated_by_id = ${user.id} and started_at > now() - interval '24 hours'
  `)) as unknown as Array<{ n: number }>;
  if (Number(todayRows[0]?.n ?? 0) >= dailyLimit) {
    throw Errors.rateLimited('You have reached the daily call limit. Contact an administrator.');
  }

  let destination: string | null = null;
  let counterpartyUserId: string | null = null;
  let counterpartyName: string | null = null;
  let basis = '';
  let contactId: string | null = null;

  if (args.counterparty === 'contact') {
    if (user.role === 'volunteer') throw Errors.forbidden('Only coordinators can call org contacts.');
    if (!args.contactId) throw Errors.validation('Choose a contact to call.');
    const [contact] = await db.select().from(contacts)
      .where(and(eq(contacts.id, args.contactId), isNull(contacts.deletedAt))).limit(1);
    if (!contact) throw Errors.notFound('Contact');
    destination = contact.phone; counterpartyName = contact.name; contactId = contact.id;
    basis = 'dispatcher calling org contact';
  } else {
    if (!args.tripId) throw Errors.validation('A trip is required for this kind of call.');
    const [trip] = await db.select().from(trips)
      .where(and(eq(trips.id, args.tripId), isNull(trips.deletedAt))).limit(1);
    if (!trip) throw Errors.notFound('Trip');

    const isDispatcher = user.role === 'dispatcher' || user.role === 'admin';
    const isAssignedVolunteer = trip.assignedVolunteerId === user.id;

    if (args.counterparty === 'caller') {
      // A volunteer may reach the passenger only while actually assigned to
      // that trip — not before accepting, and not after it ends.
      const engaged = ['assigned', 'accepted', 'en_route', 'in_progress'].includes(trip.status);
      if (!isDispatcher && !(isAssignedVolunteer && engaged)) {
        throw Errors.forbidden('You can only call the passenger for a trip currently assigned to you.');
      }
      if (!trip.callerPhone) throw Errors.validation('This trip has no caller phone number.');
      destination = trip.callerPhone; counterpartyName = trip.callerName;
      basis = isDispatcher ? 'dispatcher calling trip caller' : 'assigned volunteer calling trip caller';
    } else {
      if (!isDispatcher) throw Errors.forbidden('Only coordinators can call the assigned volunteer.');
      if (!trip.assignedVolunteerId) throw Errors.validation('No volunteer is assigned to this trip.');
      const [vol] = await db.select({ phone: users.phone, fullName: users.fullName })
        .from(users).where(eq(users.id, trip.assignedVolunteerId)).limit(1);
      if (!vol?.phone) throw Errors.validation('That volunteer has no phone number on file.');
      destination = vol.phone; counterpartyUserId = trip.assignedVolunteerId;
      counterpartyName = vol.fullName; basis = 'dispatcher calling assigned volunteer';
    }
  }

  const [call] = await db.insert(calls).values({
    initiatedById: user.id, tripId: args.tripId ?? null, direction: 'outbound',
    counterpartyType: args.counterparty, counterpartyUserId, counterpartyName,
    contactId, destinationLast4: last4(destination!), authorizationBasis: basis,
    status: 'requested',
    // The voice webhook resolves the destination from this row (by
    // counterparty_user_id / trip_id / contact_id); the number is never carried
    // in a URL where it could be tampered with.
  }).returning();

  await recordAudit({
    actor: audit, action: 'call.started', entityType: 'call', entityId: call!.id,
    metadata: { tripId: args.tripId ?? null, counterparty: args.counterparty, basis, destinationLast4: last4(destination!) },
  });

  try {
    const placed = await callingProvider.connect({
      initiatorNumber: user.phone, destinationNumber: destination!, callId: call!.id,
    });
    const [updated] = await db.update(calls)
      .set({ providerSid: placed.providerCallId, status: 'ringing' })
      .where(eq(calls.id, call!.id)).returning();
    return { call: updated!, counterpartyName };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(calls).set({ status: 'failed', failureReason: message.slice(0, 300), endedAt: new Date() })
      .where(eq(calls.id, call!.id));
    throw Errors.upstream('The phone system could not place this call. Try again, or dial directly.', { detail: message });
  }
}

/** Call log. Numbers are resolved to names; raw digits are never listed. */
export async function listCalls(
  user: AuthenticatedUser,
  args: { direction?: string; status?: string; limit: number },
) {
  const isDispatcher = user.role === 'dispatcher' || user.role === 'admin';
  const conditions = [];
  if (!isDispatcher) conditions.push(eq(calls.initiatedById, user.id));
  if (args.direction) conditions.push(eq(calls.direction, args.direction));
  if (args.status === 'missed') conditions.push(eq(calls.status, 'no_answer'));
  else if (args.status) conditions.push(eq(calls.status, args.status));

  const rows = await db.select({
    id: calls.id, direction: calls.direction, status: calls.status,
    durationSeconds: calls.durationSeconds, startedAt: calls.startedAt,
    counterpartyName: calls.counterpartyName, destinationLast4: calls.destinationLast4,
    failureReason: calls.failureReason, tripId: calls.tripId,
    tripReference: trips.reference, initiatedByName: users.fullName,
  }).from(calls)
    .leftJoin(trips, eq(trips.id, calls.tripId))
    .innerJoin(users, eq(users.id, calls.initiatedById))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(calls.startedAt))
    .limit(args.limit);

  return rows.map((r) => ({
    ...r,
    // "Incoming · No answer" — the failure reason belongs on the same line as
    // the state, which the benchmark got right.
    outcomeLabel: r.status === 'no_answer' ? 'No answer'
      : r.status === 'failed' ? (r.failureReason ? 'Failed' : 'Failed')
      : r.status === 'completed' ? null : r.status,
    durationLabel: formatDuration(r.durationSeconds),
    // Never the full number — the last four are enough to recognise a row.
    counterparty: r.counterpartyName ?? (r.destinationLast4 ? `••• ${r.destinationLast4}` : 'Unknown'),
  }));
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === 0) return '—'; // never connected ≠ zero seconds
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

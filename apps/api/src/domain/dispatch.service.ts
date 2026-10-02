import { assertSeats, seatsNeeded } from './seats.js';
import { and, desc, eq, inArray, isNull, ne, or, sql as raw } from 'drizzle-orm';
import {
  SETTING_KEYS,
  TRIP_STATE_MACHINE,
  canTransition,
  type AssignmentMode,
  type TripStatus,
  type TripTransition,
} from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import {
  addresses,
  callerAddresses,
  callers,
  recurringRides,
  userGroups,
  tripAssignments,
  tripOffers,
  trips,
  users,
  volunteerGroups,
} from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, tripSnapshot, type AuditActor, SYSTEM_ACTOR } from '../lib/audit.js';
import { getNumberSetting } from '../lib/settings.js';
import { hashToken } from '../lib/crypto.js';
import { generateOfferCode, formatOfferCode } from '../lib/offer-code.js';
import { normalizePhone } from '../lib/phone.js';
import { notify } from '../services/notification.service.js';
import { enqueue } from '../jobs/queue.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import type { AuthenticatedUser } from '../auth/session.js';
import { evaluateCandidates } from './targeting.js';
import { renderTemplate } from '../services/templates.service.js';
import { formatWhen, formatClock } from '../lib/time.js';

/**
 * The dispatch engine.
 *
 * Every change to a trip's state happens in one of the functions below. There
 * is no endpoint that lets a client write `status` directly, and each function
 * does the same six things, in a single transaction:
 *
 *   1. read the trip and validate the current state against the state machine
 *   2. validate the actor's permission, including object-level ownership
 *   3. validate the inputs
 *   4. perform an atomic update
 *   5. write an audit event
 *   6. queue the notifications the transition implies
 *
 * If any step throws, the whole transaction rolls back, so it is not possible
 * to end up with a state change that was neither audited nor notified.
 */

export interface TripActor {
  user: AuthenticatedUser;
  audit: AuditActor;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadTripForUpdate(exec: Executor, tripId: string) {
  const [trip] = await exec
    .select()
    .from(trips)
    .where(and(eq(trips.id, tripId), isNull(trips.deletedAt)))
    .limit(1)
    .for('update');
  if (!trip) throw Errors.notFound('Trip');
  return trip;
}

function assertTransitionAllowed(
  trip: { status: string; assignedVolunteerId: string | null },
  transition: TripTransition,
  actor: TripActor,
): void {
  const rule = TRIP_STATE_MACHINE[transition];

  if (!canTransition(trip.status as TripStatus, transition)) {
    throw Errors.staleState(
      `This trip is ${trip.status.replace('_', ' ')} — ${transition.replace('_', ' ')} is no longer possible.`,
      { status: trip.status, transition, allowedFrom: rule.from },
    );
  }

  if (!rule.roles.includes(actor.user.role)) {
    throw Errors.forbidden(`Your role cannot ${transition.replace('_', ' ')} a trip.`);
  }

  // Object-level authorization: a volunteer may only act on their own trip.
  if (rule.volunteerMustOwn && actor.user.role === 'volunteer') {
    if (trip.assignedVolunteerId !== actor.user.id) {
      throw Errors.forbidden('This trip is not assigned to you.');
    }
  }
}

async function groupBySlug(exec: Executor, slug: string) {
  const [group] = await exec
    .select()
    .from(volunteerGroups)
    .where(eq(volunteerGroups.slug, slug))
    .limit(1);
  if (!group) throw Errors.validation(`Unknown volunteer group "${slug}"`, { field: 'groupSlug' });
  return group;
}

async function insertAddress(exec: Executor, input: {
  line1: string; unit?: string | null; city?: string; province?: string;
  postalCode?: string | null; country?: string; notes?: string | null;
  latitude?: number | null; longitude?: number | null;
}) {
  const [row] = await exec
    .insert(addresses)
    .values({
      line1: input.line1,
      unit: input.unit ?? null,
      city: input.city ?? 'Montreal',
      province: input.province ?? 'QC',
      postalCode: input.postalCode ?? null,
      country: input.country ?? 'CA',
      notes: input.notes ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    })
    .returning();
  return row!;
}

function areaOf(address: { line1: string; city: string }): string {
  // What a volunteer sees before claiming: enough to judge the journey, not
  // enough to identify the household.
  const withoutNumber = address.line1.replace(/^\s*\d+[A-Za-z]?\s+/, '');
  return `${withoutNumber}, ${address.city}`;
}

/**
 * How long a volunteer has to answer.
 *
 * Three windows, because "urgent" in this organisation means two different
 * things: a hospital discharge that needs a car within the hour, and a genuine
 * emergency. A routine 30-minute window on the first wastes half the time
 * available; applying the emergency window to everything trains people to
 * ignore the word.
 */
async function offerWindowMinutes(exec: Executor, priority: string): Promise<number> {
  if (priority === 'emergency') {
    return getNumberSetting(SETTING_KEYS.emergencyOfferWindowMinutes, exec);
  }
  if (priority === 'urgent') {
    return getNumberSetting(SETTING_KEYS.urgentOfferWindowMinutes, exec);
  }
  return getNumberSetting(SETTING_KEYS.offerWindowMinutes, exec);
}

/**
 * Resolves the caller for a trip.
 *
 * A one-off caller stays a name and a number on the trip. A caller with a phone
 * number becomes a row, so the next time they ring, the dispatcher types three
 * digits instead of conducting the same interview again. Matching is on exact
 * E.164 — never on "the last ten digits", which is the comparison that let a
 * spoofed caller-ID match a volunteer in the legacy system.
 */
async function resolveCaller(
  exec: Executor,
  input: { callerId?: string | null; callerName?: string | null; callerPhone?: string | null },
  _actorUserId: string | null,
): Promise<{ callerId: string | null; callerName: string | null; callerPhone: string | null }> {
  const phone = normalizePhone(input.callerPhone ?? null);
  const name = input.callerName?.trim() || null;

  if (input.callerId) {
    const [row] = await exec
      .select()
      .from(callers)
      .where(and(eq(callers.id, input.callerId), isNull(callers.deletedAt)))
      .limit(1);
    if (!row) throw Errors.notFound('That caller is no longer on file.');
    return {
      callerId: row.id,
      callerName: name ?? row.name,
      callerPhone: phone ?? row.primaryPhone,
    };
  }

  if (!phone) return { callerId: null, callerName: name, callerPhone: null };

  const [existing] = await exec
    .select()
    .from(callers)
    .where(
      and(
        isNull(callers.deletedAt),
        or(eq(callers.primaryPhone, phone), eq(callers.alternatePhone, phone)),
      ),
    )
    .limit(1);

  if (existing) {
    return { callerId: existing.id, callerName: name ?? existing.name, callerPhone: phone };
  }

  // A number not on file stays on the trip only. Dispatch saves the caller to
  // Contacts deliberately, with the "Save to Contacts" button on the trip.
  return { callerId: null, callerName: name, callerPhone: phone };
}

/** Remembers an address against a caller so it is offered next time. */
async function rememberCallerAddress(
  exec: Executor,
  callerId: string,
  addressId: string,
  detail: { label?: string; entrance?: string | null; parking?: string | null; isPickup: boolean },
): Promise<void> {
  const [existing] = await exec
    .select()
    .from(callerAddresses)
    .where(
      and(
        eq(callerAddresses.callerId, callerId),
        eq(callerAddresses.addressId, addressId),
        isNull(callerAddresses.deletedAt),
      ),
    )
    .limit(1);

  if (existing) {
    await exec
      .update(callerAddresses)
      .set({
        useCount: existing.useCount + 1,
        lastUsedAt: new Date(),
        entrance: detail.entrance ?? existing.entrance,
        parking: detail.parking ?? existing.parking,
      })
      .where(eq(callerAddresses.id, existing.id));
    return;
  }

  await exec.insert(callerAddresses).values({
    callerId,
    addressId,
    label: detail.label ?? (detail.isPickup ? 'home' : 'clinic'),
    entrance: detail.entrance ?? null,
    parking: detail.parking ?? null,
    useCount: 1,
    lastUsedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

export interface CreateTripArgs {
  isTest?: boolean;
  /** Existing directory entry, when the dispatcher picked a repeat caller. */
  callerId?: string | null;
  callerName?: string | null;
  callerPhone?: string | null;
  /** Number to reach about this trip; often a ward desk, not the caller. */
  callbackNumber?: string | null;
  pickup: Parameters<typeof insertAddress>[1];
  dropoff: Parameters<typeof insertAddress>[1];
  pickupEntrance?: string | null;
  pickupParking?: string | null;
  dropoffEntrance?: string | null;
  dropoffParking?: string | null;
  pickupAt: Date;
  /** The appointment the ride exists for, when it differs from pickup. */
  appointmentAt?: Date | null;
  tripType: string;
  priority: string;
  groupSlug: string;
  assignmentMode: AssignmentMode;
  mobilityNeeds: string[];
  passengerNotes?: string | null;
  /** Set by the recurring-ride materialiser and by Duplicate Ride. */
  recurringRideId?: string | null;
  duplicatedFromTripId?: string | null;
  /** Skip writing the addresses back to the caller's directory entry. */
  skipRemember?: boolean;
}

export async function createTrip(actor: TripActor, args: CreateTripArgs, exec?: Executor) {
  const run = async (tx: Executor) => {
    const group = await groupBySlug(tx, args.groupSlug);
    const pickup = await insertAddress(tx, args.pickup);
    const dropoff = await insertAddress(tx, args.dropoff);
    const caller = await resolveCaller(tx, args, actor.user.id ?? null);

    const refRows = (await tx.execute(
      raw`select next_trip_reference() as reference`,
    )) as unknown as Array<{ reference: string }>;
    const reference = refRows[0]!.reference;

    const [trip] = await tx
      .insert(trips)
      .values({
        reference,
        isTest: args.isTest ?? false,
        status: 'pending',
        priority: args.priority,
        tripType: args.tripType,
        assignmentMode: args.assignmentMode,
        groupId: group.id,
        callerId: caller.callerId,
        callerName: caller.callerName,
        callerPhone: caller.callerPhone,
        callbackNumber: normalizePhone(args.callbackNumber),
        pickupAddressId: pickup.id,
        dropoffAddressId: dropoff.id,
        pickupEntrance: args.pickupEntrance ?? null,
        pickupParking: args.pickupParking ?? null,
        dropoffEntrance: args.dropoffEntrance ?? null,
        dropoffParking: args.dropoffParking ?? null,
        pickupAt: args.pickupAt,
        appointmentAt: args.appointmentAt ?? null,
        mobilityNeeds: args.mobilityNeeds,
        passengerNotes: args.passengerNotes ?? null,
        recurringRideId: args.recurringRideId ?? null,
        duplicatedFromTripId: args.duplicatedFromTripId ?? null,
        createdById: actor.user.id,
      })
      .returning();

    if (caller.callerId && !args.skipRemember) {
      await rememberCallerAddress(tx, caller.callerId, pickup.id, {
        entrance: args.pickupEntrance ?? null,
        parking: args.pickupParking ?? null,
        isPickup: true,
      });
      await rememberCallerAddress(tx, caller.callerId, dropoff.id, {
        entrance: args.dropoffEntrance ?? null,
        parking: args.dropoffParking ?? null,
        isPickup: false,
      });
    }

    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.created',
        entityType: 'trip',
        entityId: trip!.id,
        next: tripSnapshot(trip as unknown as Record<string, unknown>),
        metadata: {
          reference,
          callerId: caller.callerId,
          recurringRideId: args.recurringRideId ?? null,
          duplicatedFrom: args.duplicatedFromTripId ?? null,
        },
      },
      tx,
    );

    return trip!;
  };

  return exec ? run(exec) : db.transaction(run);
}

/**
 * Duplicate Ride.
 *
 * Copies what describes the journey and nothing that describes what happened to
 * it. The new trip is `pending` with no volunteer, no offers, no assignment
 * history, no timestamps and its own reference and audit trail; the only link
 * back is `duplicated_from_trip_id`, which is provenance, not state. Copying a
 * completed trip's `status` is exactly the bug that made the legacy "repeat"
 * button produce trips that were already finished.
 */
export async function duplicateTrip(
  actor: TripActor,
  tripId: string,
  overrides: { pickupAt?: Date; priority?: string; passengerNotes?: string | null } = {},
) {
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(trips).where(eq(trips.id, tripId)).limit(1);
    if (!source) throw Errors.notFound('That trip no longer exists.');

    const [group] = await tx
      .select()
      .from(volunteerGroups)
      .where(eq(volunteerGroups.id, source.groupId))
      .limit(1);

    const [pickup] = await tx
      .select()
      .from(addresses)
      .where(eq(addresses.id, source.pickupAddressId));
    const [dropoff] = await tx
      .select()
      .from(addresses)
      .where(eq(addresses.id, source.dropoffAddressId));

    // Default the new pickup to the same time of day, one week on: the
    // overwhelmingly common reason to duplicate is a weekly appointment the
    // dispatcher has not set up as a standing ride.
    const pickupAt = overrides.pickupAt ?? new Date(source.pickupAt.getTime() + 7 * 86_400_000);

    const created = await createTrip(
      actor,
      {
        callerId: source.callerId,
        callerName: source.callerName,
        callerPhone: source.callerPhone,
        callbackNumber: source.callbackNumber,
        pickup: {
          line1: pickup!.line1,
          unit: pickup!.unit,
          city: pickup!.city,
          province: pickup!.province,
          postalCode: pickup!.postalCode,
          country: pickup!.country,
          notes: pickup!.notes,
          latitude: pickup!.latitude,
          longitude: pickup!.longitude,
        },
        dropoff: {
          line1: dropoff!.line1,
          unit: dropoff!.unit,
          city: dropoff!.city,
          province: dropoff!.province,
          postalCode: dropoff!.postalCode,
          country: dropoff!.country,
          notes: dropoff!.notes,
          latitude: dropoff!.latitude,
          longitude: dropoff!.longitude,
        },
        pickupEntrance: source.pickupEntrance,
        pickupParking: source.pickupParking,
        dropoffEntrance: source.dropoffEntrance,
        dropoffParking: source.dropoffParking,
        pickupAt,
        appointmentAt: source.appointmentAt
          ? new Date(pickupAt.getTime() + (source.appointmentAt.getTime() - source.pickupAt.getTime()))
          : null,
        tripType: source.tripType,
        priority: overrides.priority ?? source.priority,
        groupSlug: group!.slug,
        assignmentMode: source.assignmentMode as AssignmentMode,
        mobilityNeeds: source.mobilityNeeds,
        passengerNotes:
          overrides.passengerNotes !== undefined ? overrides.passengerNotes : source.passengerNotes,
        duplicatedFromTripId: source.id,
        skipRemember: true,
      },
      tx,
    );

    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.duplicated',
        entityType: 'trip',
        entityId: created.id,
        metadata: { from: source.id, fromReference: source.reference, reference: created.reference },
      },
      tx,
    );

    return created;
  });
}

export async function updateTrip(
  actor: TripActor,
  tripId: string,
  patch: Record<string, unknown> & { version?: number },
) {
  return db.transaction(async (tx) => {
    const before = await loadTripForUpdate(tx, tripId);

    if (patch.version !== undefined && patch.version !== before.version) {
      throw Errors.staleState(
        'Someone else changed this trip while you were editing. Reload to see their changes.',
        { yourVersion: patch.version, currentVersion: before.version },
      );
    }

    const set: Record<string, unknown> = {};
    if ('callerName' in patch) set.callerName = patch.callerName ?? null;
    if ('callerPhone' in patch) set.callerPhone = normalizePhone(patch.callerPhone as string);
    if ('pickupAt' in patch && patch.pickupAt) set.pickupAt = patch.pickupAt;
    if ('tripType' in patch && patch.tripType) set.tripType = patch.tripType;
    if ('priority' in patch && patch.priority) set.priority = patch.priority;
    if ('assignmentMode' in patch && patch.assignmentMode) set.assignmentMode = patch.assignmentMode;
    if ('mobilityNeeds' in patch && patch.mobilityNeeds) set.mobilityNeeds = patch.mobilityNeeds;
    if ('passengerNotes' in patch) set.passengerNotes = patch.passengerNotes ?? null;
    if ('callbackNumber' in patch) set.callbackNumber = normalizePhone(patch.callbackNumber as string);
    if ('appointmentAt' in patch) set.appointmentAt = patch.appointmentAt ?? null;
    if ('pickupEntrance' in patch) set.pickupEntrance = patch.pickupEntrance ?? null;
    if ('pickupParking' in patch) set.pickupParking = patch.pickupParking ?? null;
    if ('dropoffEntrance' in patch) set.dropoffEntrance = patch.dropoffEntrance ?? null;
    if ('dropoffParking' in patch) set.dropoffParking = patch.dropoffParking ?? null;
    if ('callerId' in patch) set.callerId = patch.callerId ?? null;

    if (patch.groupSlug) {
      const group = await groupBySlug(tx, patch.groupSlug as string);
      set.groupId = group.id;
    }
    if (patch.pickup) {
      const a = await insertAddress(tx, patch.pickup as Parameters<typeof insertAddress>[1]);
      set.pickupAddressId = a.id;
    }
    if (patch.dropoff) {
      const a = await insertAddress(tx, patch.dropoff as Parameters<typeof insertAddress>[1]);
      set.dropoffAddressId = a.id;
    }

    if (Object.keys(set).length === 0) return before;

    const [after] = await tx.update(trips).set(set).where(eq(trips.id, tripId)).returning();

    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.updated',
        entityType: 'trip',
        entityId: tripId,
        previous: tripSnapshot(before as unknown as Record<string, unknown>),
        next: tripSnapshot(after as unknown as Record<string, unknown>),
        metadata: { fields: Object.keys(set) },
      },
      tx,
    );

    return after!;
  });
}

/** Soft delete. Operational history is never destroyed. */
export async function archiveTrip(actor: TripActor, tripId: string, reason: string) {
  return db.transaction(async (tx) => {
    const before = await loadTripForUpdate(tx, tripId);
    if (!['completed', 'cancelled'].includes(before.status)) {
      throw Errors.conflict('Cancel the trip before archiving it.', { status: before.status });
    }
    const [after] = await tx
      .update(trips)
      .set({ deletedAt: new Date() })
      .where(eq(trips.id, tripId))
      .returning();
    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.archived',
        entityType: 'trip',
        entityId: tripId,
        previous: tripSnapshot(before as unknown as Record<string, unknown>),
        metadata: { reason },
      },
      tx,
    );
    return after!;
  });
}

// ---------------------------------------------------------------------------
// Offer
// ---------------------------------------------------------------------------

export interface OfferResult {
  tripId: string;
  offered: number;
  expiresAt: Date;
  round: number;
  /** Everyone considered and not asked, with the reason. */
  skipped: { volunteerId: string; fullName: string; reason: string }[];
  relaxed: boolean;
  relaxedReason?: string;
}

/**
 * Offer a trip to the volunteers who should be asked.
 *
 * Every recipient gets a durable `trip_offers` row with its own single-use
 * code. Sending an SMS is a *consequence* of an offer existing, never the
 * definition of one — that inversion is what made the old system unable to
 * answer "who was asked, and did they reply?".
 *
 * Who gets asked is decided by domain/targeting.ts, not by group membership
 * alone. The skipped list is returned rather than discarded so the dispatcher
 * can see that four people were passed over for being unavailable and decide
 * whether to widen it.
 */
export async function offerTrip(
  actor: TripActor,
  tripId: string,
  opts: { volunteerIds?: string[]; expiresInMinutes?: number; ignoreTargeting?: boolean } = {},
): Promise<OfferResult> {
  const result = await db.transaction(async (tx) => {
    const trip = await loadTripForUpdate(tx, tripId);
    assertTransitionAllowed(trip, 'offer', actor);

    const windowMinutes =
      opts.expiresInMinutes ?? (await offerWindowMinutes(tx, trip.priority));
    const expiresAt = new Date(Date.now() + windowMinutes * 60_000);

    // A standing ride names its usual driver; that person is asked first.
    let preferredVolunteerId: string | null = null;
    if (trip.recurringRideId) {
      const [rr] = await tx
        .select({ preferred: recurringRides.preferredVolunteerId })
        .from(recurringRides)
        .where(eq(recurringRides.id, trip.recurringRideId))
        .limit(1);
      preferredVolunteerId = rr?.preferred ?? null;
    }

    const batchSize = await getNumberSetting(SETTING_KEYS.offerBatchSize, tx);

    const targeting = await evaluateCandidates(
      {
        groupId: trip.groupId,
        tripType: trip.tripType,
        // A dispatcher naming people explicitly has already made the judgement
        // the filters exist to make, so their choice is honoured directly.
        priority: opts.ignoreTargeting || opts.volunteerIds?.length ? 'emergency' : trip.priority,
        pickupAt: trip.pickupAt,
        mobilityNeeds: trip.mobilityNeeds,
        callerId: trip.callerId,
        preferredVolunteerId,
        restrictToUserIds: opts.volunteerIds?.length ? opts.volunteerIds : null,
        excludeTripId: tripId,
        seatsNeeded: await seatsNeeded(tripId, tx),
        limit: batchSize,
      },
      tx,
    );

    if (targeting.eligible.length === 0) {
      // Say which filter emptied the pool. "No volunteers available" with no
      // explanation is the message that makes a dispatcher distrust the system.
      const tally = new Map<string, number>();
      for (const e of targeting.excluded) {
        for (const r of e.reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
      }
      const breakdown = [...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => `${n} ${reason}`)
        .join('; ');
      throw Errors.conflict(
        breakdown
          ? `Nobody can be offered this trip right now — ${breakdown}. Assign someone directly, or widen the group.`
          : 'There are no active volunteers in this group to offer the trip to.',
        { groupId: trip.groupId, excluded: targeting.excluded.slice(0, 20) },
      );
    }

    // A re-broadcast is a new round; earlier pending offers are superseded so
    // their codes stop working.
    const roundRows = (await tx.execute(raw`
      select coalesce(max(round), 0) + 1 as round from trip_offers where trip_id = ${tripId}
    `)) as unknown as Array<{ round: number }>;
    const round = Number(roundRows[0]!.round);

    if (round > 1) {
      await tx
        .update(tripOffers)
        .set({ status: 'superseded', respondedAt: new Date() })
        .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, 'pending')));
    }

    const created: Array<{ id: string; code: string; volunteerId: string }> = [];
    const skipped: { volunteerId: string; fullName: string; reason: string }[] =
      targeting.excluded.map((e) => ({
        volunteerId: e.id,
        fullName: e.fullName,
        reason: e.reasons.join('; '),
      }));

    for (const candidate of targeting.eligible) {
      const code = generateOfferCode();
      const [offer] = await tx
        .insert(tripOffers)
        .values({
          tripId,
          volunteerId: candidate.id,
          tokenHash: hashToken(code),
          expiresAt,
          round,
        })
        .returning({ id: tripOffers.id });
      if (offer) created.push({ id: offer.id, code, volunteerId: candidate.id });
      else skipped.push({ volunteerId: candidate.id, fullName: candidate.fullName, reason: 'duplicate offer' });
    }

    // Fairness rotation: being asked counts, whether or not they answer.
    await tx
      .update(users)
      .set({ lastOfferedAt: new Date() })
      .where(inArray(users.id, created.map((c) => c.volunteerId)));

    const [updated] = await tx
      .update(trips)
      .set({
        status: 'offered',
        offerExpiresAt: expiresAt,
        escalatedAt: null,
        offerRound: round,
      })
      .where(eq(trips.id, tripId))
      .returning();

    const [pickup] = await tx.select().from(addresses).where(eq(addresses.id, trip.pickupAddressId));
    const [dropoff] = await tx.select().from(addresses).where(eq(addresses.id, trip.dropoffAddressId));

    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.offered',
        entityType: 'trip',
        entityId: tripId,
        previous: tripSnapshot(trip as unknown as Record<string, unknown>),
        next: tripSnapshot(updated as unknown as Record<string, unknown>),
        metadata: {
          round,
          offered: created.length,
          considered: targeting.eligible.length + targeting.excluded.length,
          skipped: skipped.length,
          relaxed: targeting.relaxed,
          relaxedReason: targeting.relaxedReason ?? null,
          expiresAt: expiresAt.toISOString(),
        },
      },
      tx,
    );

    // One notification per offer, carrying that volunteer's own code.
    for (const offer of created) {
      const rendered = await renderTemplate(
        'trip.offered',
        'sms',
        {
          reference: updated!.reference,
          priorityTag: updated!.priority !== 'routine' ? `[${updated!.priority.toUpperCase()}] ` : '',
          fromArea: areaOf(pickup!),
          toArea: areaOf(dropoff!),
          when: formatWhen(updated!.pickupAt),
          needs: updated!.mobilityNeeds.filter((n) => n !== 'none').join(', '),
          acceptUrl: `${env.APP_URL}/o/${offer.code}`,
          smsCode: formatOfferCode(offer.code),
          expiresClock: formatClock(expiresAt),
        },
        tx,
      );

      await notify(
        {
          userId: offer.volunteerId,
          event: 'trip.offered',
          title: `Trip ${updated!.reference}`,
          body: rendered.body,
          tripId,
          offerId: offer.id,
          payload: { reference: updated!.reference, code: offer.code, expiresAt },
          // Offers must land, so both channels are used regardless of preference.
          forceChannels: ['sms', 'push'],
        },
        tx,
      );

      // Per-offer expiry, deduplicated so a re-broadcast cannot double-schedule.
      await enqueue(
        'offer.expire',
        { offerId: offer.id, tripId },
        { runAt: expiresAt, dedupeKey: `offer-expire:${offer.id}` },
        tx,
      );
    }

    // A single reminder partway through the window, to the same people.
    const reminderMinutes = await getNumberSetting(SETTING_KEYS.offerReminderMinutes, tx);
    if (reminderMinutes > 0 && reminderMinutes < windowMinutes) {
      await enqueue(
        'trip.reminder',
        { tripId, round },
        {
          runAt: new Date(Date.now() + reminderMinutes * 60_000),
          dedupeKey: `trip-reminder:${tripId}:${round}`,
        },
        tx,
      );
    }

    // Escalation is separate from expiry: dispatchers hear about silence before
    // the window closes.
    const escalateMinutes = await getNumberSetting(SETTING_KEYS.escalationMinutes, tx);
    await enqueue(
      'trip.escalate',
      { tripId, round },
      {
        runAt: new Date(Date.now() + Math.min(escalateMinutes, windowMinutes) * 60_000),
        dedupeKey: `trip-escalate:${tripId}:${round}`,
      },
      tx,
    );

    return {
      tripId,
      offered: created.length,
      expiresAt,
      round,
      skipped,
      relaxed: targeting.relaxed,
      relaxedReason: targeting.relaxedReason,
    };
  });

  logger.info(
    { tripId, offered: result.offered, skipped: result.skipped.length, relaxed: result.relaxed },
    'trip offered',
  );
  return result;
}

/**
 * Re-sends an outstanding offer to the volunteers who already hold one.
 *
 * Deliberately narrow. It does not widen the pool, does not create new offer
 * rows, and does not extend the window — the same people get one reminder with
 * the same code and the same deadline. Widening is escalation, which is a
 * decision a dispatcher makes with the information the escalation gives them.
 */
export async function remindPendingOffers(tripId: string, round: number): Promise<number> {
  const [trip] = await db.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!trip || trip.status !== 'offered') return 0;

  const pending = await db
    .select({ id: tripOffers.id, volunteerId: tripOffers.volunteerId, expiresAt: tripOffers.expiresAt })
    .from(tripOffers)
    .where(
      and(
        eq(tripOffers.tripId, tripId),
        eq(tripOffers.round, round),
        raw`${tripOffers.expiresAt} > ${new Date().toISOString()}::timestamptz`,
        eq(tripOffers.status, 'pending'),
      ),
    );
  if (pending.length === 0) return 0;

  const [pickup] = await db.select().from(addresses).where(eq(addresses.id, trip.pickupAddressId));
  const [dropoff] = await db.select().from(addresses).where(eq(addresses.id, trip.dropoffAddressId));

  let sent = 0;
  for (const offer of pending) {
    // The code is hashed at rest, so the reminder carries the link only. A
    // volunteer who has lost the original text can still tap through.
    const rendered = await renderTemplate('trip.offer_reminder', 'sms', {
      reference: trip.reference,
      fromArea: areaOf(pickup!),
      toArea: areaOf(dropoff!),
      when: formatWhen(trip.pickupAt),
      // The trip page, not an /offers/:id route — there is no such screen, and
      // a reminder whose only link 404s is worse than no reminder. A volunteer
      // holding a live offer sees the pre-claim projection there and can accept.
      acceptUrl: `${env.APP_URL}/trips/${tripId}`,
      expiresClock: formatClock(offer.expiresAt),
    });
    try {
      await notify({
        userId: offer.volunteerId,
        event: 'trip.offer_reminder',
        title: `Still open: ${trip.reference}`,
        body: rendered.body,
        tripId,
        offerId: offer.id,
        forceChannels: ['push'],
      });
      sent++;
    } catch (err) {
      logger.warn({ err, offerId: offer.id }, 'offer reminder failed');
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Claim — the race-safe acceptance path
// ---------------------------------------------------------------------------

export interface ClaimArgs {
  tripId?: string;
  /** Raw offer code from a deep link or SMS. */
  code?: string;
  /**
   * How the VOLUNTEER accepted. This path is only ever a volunteer accepting
   * their own offer; a coordinator or admin giving a trip to someone uses
   * assignTrip() (POST /api/trips/:id/assign), which records who assigned it.
   */
  channel: 'app' | 'sms' | 'whatsapp' | 'voice' | 'push';
  /** Present for SMS: the verified sending number, which must match the offer. */
  verifiedPhone?: string;
}

export interface ClaimOutcome {
  ok: boolean;
  reason?: 'already_taken' | 'expired' | 'not_offered' | 'not_your_offer' | 'unknown_code';
  tripId?: string;
  reference?: string;
  volunteerId?: string;
}

/**
 * Accept an offer.
 *
 * The whole correctness of this system rests on one statement:
 *
 *   UPDATE trips SET status='accepted', assigned_volunteer_id = :v
 *    WHERE id = :t AND status='offered' AND assigned_volunteer_id IS NULL
 *
 * That is a single atomic compare-and-set. Two volunteers pressing Accept at
 * the same instant both reach it; exactly one gets a row back. There is no
 * read-then-write window for them to race inside, and no reliance on anything
 * the client does. A partial unique index on `trip_offers (trip_id) WHERE
 * status='accepted'` is the second line of defence.
 */
export async function claimTrip(actor: TripActor, args: ClaimArgs): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    let offerRow:
      | { id: string; tripId: string; volunteerId: string; status: string; expiresAt: Date }
      | undefined;

    if (args.code) {
      const [found] = await tx
        .select({
          id: tripOffers.id,
          tripId: tripOffers.tripId,
          volunteerId: tripOffers.volunteerId,
          status: tripOffers.status,
          expiresAt: tripOffers.expiresAt,
        })
        .from(tripOffers)
        .where(eq(tripOffers.tokenHash, hashToken(args.code)))
        .limit(1);
      offerRow = found;
      if (!offerRow) return { ok: false, reason: 'unknown_code' };
    } else if (args.tripId) {
      const [found] = await tx
        .select({
          id: tripOffers.id,
          tripId: tripOffers.tripId,
          volunteerId: tripOffers.volunteerId,
          status: tripOffers.status,
          expiresAt: tripOffers.expiresAt,
        })
        .from(tripOffers)
        .where(
          and(
            eq(tripOffers.tripId, args.tripId),
            eq(tripOffers.volunteerId, actor.user.id),
          ),
        )
        // Keep the caller's latest offer even if another claim just closed it.
        // Its status below tells a late loser 'already taken', not 'not yours'.
        .orderBy(desc(tripOffers.round))
        .limit(1);
      offerRow = found;
      if (!offerRow) return { ok: false, reason: 'not_your_offer' };
    } else {
      throw Errors.validation('Provide a trip or an offer code');
    }

    // The code identifies the offer; it does not by itself prove who is using
    // it. Whoever presents it must also be the volunteer it was issued to —
    // by authenticated session, or by a Twilio-verified sending number.
    if (args.channel === 'sms' || args.channel === 'whatsapp') {
      if (!args.verifiedPhone) return { ok: false, reason: 'not_your_offer' };
      const [owner] = await tx
        .select({ phone: users.phone })
        .from(users)
        .where(eq(users.id, offerRow.volunteerId))
        .limit(1);
      if (!owner?.phone || owner.phone !== args.verifiedPhone) {
        return { ok: false, reason: 'not_your_offer' };
      }
    } else if (offerRow.volunteerId !== actor.user.id) {
      // Whatever the caller's role. A coordinator or admin holding a
      // volunteer's code (forwarded SMS, shared phone) must not be able to
      // accept for them here: that would record a self-claim nobody made.
      // Assigning someone is the explicit /assign path.
      return { ok: false, reason: 'not_your_offer' };
    }

    if (offerRow.status !== 'pending') {
      return { ok: false, reason: offerRow.status === 'expired' ? 'expired' : 'already_taken' };
    }
    if (offerRow.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(tripOffers)
        .set({ status: 'expired', respondedAt: new Date() })
        .where(eq(tripOffers.id, offerRow.id));
      return { ok: false, reason: 'expired' };
    }

    // ---- the atomic claim -------------------------------------------------
    const claimed = await tx
      .update(trips)
      .set({
        status: 'accepted',
        assignedVolunteerId: offerRow.volunteerId,
        assignedAt: new Date(),
        acceptedAt: new Date(),
        offerExpiresAt: null,
      })
      .where(
        and(
          eq(trips.id, offerRow.tripId),
          eq(trips.status, 'offered'),
          isNull(trips.assignedVolunteerId),
          isNull(trips.deletedAt),
        ),
      )
      .returning();

    if (claimed.length === 0) {
      // Someone else won, or a dispatcher moved the trip on. Nothing was
      // written; tell this volunteer plainly.
      await tx
        .update(tripOffers)
        .set({ status: 'superseded', respondedAt: new Date(), responseChannel: args.channel })
        .where(and(eq(tripOffers.id, offerRow.id), eq(tripOffers.status, 'pending')));
      return { ok: false, reason: 'already_taken', tripId: offerRow.tripId };
    }

    const trip = claimed[0]!;

    await tx
      .update(tripOffers)
      .set({ status: 'accepted', respondedAt: new Date(), responseChannel: args.channel })
      .where(eq(tripOffers.id, offerRow.id));

    // Everyone else's offer for this round is closed, so their codes die too.
    const losers = await tx
      .update(tripOffers)
      .set({ status: 'superseded', respondedAt: new Date() })
      .where(
        and(
          eq(tripOffers.tripId, trip.id),
          eq(tripOffers.status, 'pending'),
          ne(tripOffers.id, offerRow.id),
        ),
      )
      .returning({ id: tripOffers.id, volunteerId: tripOffers.volunteerId });

    await tx.insert(tripAssignments).values({
      tripId: trip.id,
      volunteerId: offerRow.volunteerId,
      assignedById: null,
      source: args.channel === 'sms' || args.channel === 'whatsapp' ? 'sms' : 'claim',
    });

    const [volunteer] = await tx
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, offerRow.volunteerId))
      .limit(1);

    await recordAudit(
      {
        actor:
          args.channel === 'sms' || args.channel === 'whatsapp'
            ? { ...actor.audit, userId: offerRow.volunteerId, name: volunteer?.fullName ?? 'Volunteer', role: 'volunteer' }
            : actor.audit,
        action: 'trip.claimed',
        entityType: 'trip',
        entityId: trip.id,
        previous: { status: 'offered', assignedVolunteerId: null },
        next: tripSnapshot(trip as unknown as Record<string, unknown>),
        metadata: { channel: args.channel, offerId: offerRow.id, supersededOffers: losers.length },
      },
      tx,
    );

    const [pickup] = await tx.select().from(addresses).where(eq(addresses.id, trip.pickupAddressId));

    await notify(
      {
        userId: offerRow.volunteerId,
        event: 'trip.claimed',
        title: `Confirmed — ${trip.reference}`,
        body:
          `You have trip ${trip.reference}.\n` +
          `Caller: ${trip.callerName ?? 'n/a'} ${trip.callerPhone ?? ''}\n` +
          `Pickup: ${pickup!.line1}${pickup!.unit ? ` #${pickup!.unit}` : ''}, ${pickup!.city}\n` +
          `When: ${formatWhen(trip.pickupAt)}` +
          (trip.passengerNotes ? `\nNotes: ${trip.passengerNotes}` : ''),
        tripId: trip.id,
        payload: { reference: trip.reference },
      },
      tx,
    );

    // Everyone who lost is told, so nobody drives to a trip they did not get.
    for (const loser of losers) {
      await notify(
        {
          userId: loser.volunteerId,
          event: 'offer.lost',
          title: `Trip ${trip.reference} taken`,
          body: `Trip ${trip.reference} has been accepted by another volunteer. Thank you.`,
          tripId: trip.id,
          forceChannels: ['inapp'],
        },
        tx,
      );
    }

    return {
      ok: true,
      tripId: trip.id,
      reference: trip.reference,
      volunteerId: offerRow.volunteerId,
    };
  });
}

// ---------------------------------------------------------------------------
// Assign / reassign
// ---------------------------------------------------------------------------

export async function assignTrip(
  actor: TripActor,
  tripId: string,
  volunteerId: string,
  reason?: string,
) {
  return db.transaction(async (tx) => {
    const trip = await loadTripForUpdate(tx, tripId);
    assertTransitionAllowed(trip, 'assign', actor);

    const [volunteer] = await tx
      .select({ id: users.id, fullName: users.fullName, status: users.status })
      .from(users)
      .innerJoin(userGroups, eq(userGroups.userId, users.id))
      .where(
        and(
          eq(users.id, volunteerId),
          eq(userGroups.groupId, trip.groupId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);

    if (!volunteer) {
      throw Errors.validation('That volunteer is not an active member of this trip’s group.', {
        field: 'volunteerId',
      });
    }
    if (volunteer.status !== 'active') {
      throw Errors.validation('That volunteer is not active.', { field: 'volunteerId' });
    }
    await assertSeats(tx, tripId, volunteerId);

    const [updated] = await tx
      .update(trips)
      .set({
        status: 'assigned',
        assignedVolunteerId: volunteerId,
        assignedAt: new Date(),
        offerExpiresAt: null,
      })
      .where(and(eq(trips.id, tripId), eq(trips.version, trip.version)))
      .returning();

    if (!updated) throw Errors.staleState('The trip changed while you were assigning it.');

    await tx
      .update(tripOffers)
      .set({ status: 'superseded', respondedAt: new Date() })
      .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, 'pending')));

    await tx.insert(tripAssignments).values({
      tripId,
      volunteerId,
      assignedById: actor.user.id,
      source: 'dispatcher',
    });

    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.assigned',
        entityType: 'trip',
        entityId: tripId,
        previous: tripSnapshot(trip as unknown as Record<string, unknown>),
        next: tripSnapshot(updated as unknown as Record<string, unknown>),
        metadata: { volunteerId, reason: reason ?? null },
      },
      tx,
    );

    await notify(
      {
        userId: volunteerId,
        event: 'trip.assigned',
        title: `Assigned — ${updated.reference}`,
        body:
          `${actor.user.fullName} assigned you trip ${updated.reference} for ` +
          `${formatWhen(updated.pickupAt)}.` +
          `\nOpen the app for full details.`,
        tripId,
        forceChannels: ['sms', 'push'],
      },
      tx,
    );

    return updated;
  });
}

export async function reassignTrip(
  actor: TripActor,
  tripId: string,
  volunteerId: string,
  reason: string,
) {
  return db.transaction(async (tx) => {
    const trip = await loadTripForUpdate(tx, tripId);
    assertTransitionAllowed(trip, 'reassign', actor);

    if (trip.assignedVolunteerId === volunteerId) {
      throw Errors.validation('That volunteer already has this trip.');
    }

    const [volunteer] = await tx
      .select({ id: users.id, status: users.status })
      .from(users)
      .innerJoin(userGroups, eq(userGroups.userId, users.id))
      .where(and(eq(users.id, volunteerId), eq(userGroups.groupId, trip.groupId), isNull(users.deletedAt)))
      .limit(1);
    if (!volunteer || volunteer.status !== 'active') {
      throw Errors.validation('That volunteer is not available for this group.');
    }
    await assertSeats(tx, tripId, volunteerId);

    const previousVolunteerId = trip.assignedVolunteerId;

    const [updated] = await tx
      .update(trips)
      .set({ status: 'assigned', assignedVolunteerId: volunteerId, assignedAt: new Date() })
      .where(eq(trips.id, tripId))
      .returning();

    // Close the outgoing assignment rather than overwriting it: "who had this
    // trip before, and why did it move?" stays answerable.
    await tx
      .update(tripAssignments)
      .set({ unassignedAt: new Date(), unassignedReason: reason })
      .where(and(eq(tripAssignments.tripId, tripId), isNull(tripAssignments.unassignedAt)));

    await tx.insert(tripAssignments).values({
      tripId,
      volunteerId,
      assignedById: actor.user.id,
      source: 'dispatcher',
    });

    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.reassigned',
        entityType: 'trip',
        entityId: tripId,
        previous: tripSnapshot(trip as unknown as Record<string, unknown>),
        next: tripSnapshot(updated as unknown as Record<string, unknown>),
        metadata: { from: previousVolunteerId, to: volunteerId, reason },
      },
      tx,
    );

    if (previousVolunteerId) {
      await notify(
        {
          userId: previousVolunteerId,
          event: 'trip.reassigned',
          title: `Trip ${updated!.reference} reassigned`,
          body: `Trip ${updated!.reference} has been reassigned. Reason: ${reason}. You are no longer expected to drive it.`,
          tripId,
          forceChannels: ['sms', 'push'],
        },
        tx,
      );
    }

    await notify(
      {
        userId: volunteerId,
        event: 'trip.assigned',
        title: `Assigned — ${updated!.reference}`,
        body: `${actor.user.fullName} assigned you trip ${updated!.reference} for ${formatWhen(updated!.pickupAt)}.`,
        tripId,
        forceChannels: ['sms', 'push'],
      },
      tx,
    );

    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Progress & terminal transitions
// ---------------------------------------------------------------------------

const SIMPLE_TRANSITIONS: Record<
  'start_en_route' | 'start_trip' | 'complete',
  { status: TripStatus; stamp: 'enRouteAt' | 'startedAt' | 'completedAt'; action: string }
> = {
  start_en_route: { status: 'en_route', stamp: 'enRouteAt', action: 'trip.en_route' },
  start_trip: { status: 'in_progress', stamp: 'startedAt', action: 'trip.started' },
  complete: { status: 'completed', stamp: 'completedAt', action: 'trip.completed' },
};

export async function advanceTrip(
  actor: TripActor,
  tripId: string,
  transition: 'start_en_route' | 'start_trip' | 'complete',
  note?: string,
) {
  const spec = SIMPLE_TRANSITIONS[transition];
  return db.transaction(async (tx) => {
    const trip = await loadTripForUpdate(tx, tripId);
    assertTransitionAllowed(trip, transition, actor);

    const [updated] = await tx
      .update(trips)
      .set({ status: spec.status, [spec.stamp]: new Date() })
      .where(and(eq(trips.id, tripId), eq(trips.status, trip.status)))
      .returning();

    if (!updated) throw Errors.staleState('The trip changed before this action was applied.');

    if (transition === 'complete') {
      await tx
        .update(tripAssignments)
        .set({ unassignedAt: new Date(), unassignedReason: 'completed' })
        .where(and(eq(tripAssignments.tripId, tripId), isNull(tripAssignments.unassignedAt)));
    }

    await recordAudit(
      {
        actor: actor.audit,
        action: spec.action,
        entityType: 'trip',
        entityId: tripId,
        previous: tripSnapshot(trip as unknown as Record<string, unknown>),
        next: tripSnapshot(updated as unknown as Record<string, unknown>),
        metadata: { note: note ?? null },
      },
      tx,
    );

    return updated;
  });
}

export async function cancelTrip(actor: TripActor, tripId: string, reason: string) {
  return db.transaction(async (tx) => {
    const trip = await loadTripForUpdate(tx, tripId);
    assertTransitionAllowed(trip, 'cancel', actor);

    const [updated] = await tx
      .update(trips)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledById: actor.user.id,
        cancellationReason: reason,
        offerExpiresAt: null,
      })
      .where(eq(trips.id, tripId))
      .returning();

    await tx
      .update(tripOffers)
      .set({ status: 'cancelled', respondedAt: new Date() })
      .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, 'pending')));

    await tx
      .update(tripAssignments)
      .set({ unassignedAt: new Date(), unassignedReason: `cancelled: ${reason}` })
      .where(and(eq(tripAssignments.tripId, tripId), isNull(tripAssignments.unassignedAt)));

    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.cancelled',
        entityType: 'trip',
        entityId: tripId,
        previous: tripSnapshot(trip as unknown as Record<string, unknown>),
        next: tripSnapshot(updated as unknown as Record<string, unknown>),
        metadata: { reason },
      },
      tx,
    );

    // Everyone who needs to know, told inside the same transaction as the
    // cancellation — the old flow cancelled first and notified afterwards on a
    // best-effort basis, so a failed notify left a silently cancelled trip.
    const recipients = new Set<string>();
    if (trip.assignedVolunteerId && trip.assignedVolunteerId !== actor.user.id) {
      recipients.add(trip.assignedVolunteerId);
    }
    if (actor.user.role === 'volunteer') {
      const dispatchers = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            inArray(users.role, ['dispatcher', 'admin']),
            eq(users.status, 'active'),
            isNull(users.deletedAt),
          ),
        );
      for (const d of dispatchers) recipients.add(d.id);
    }

    for (const userId of recipients) {
      await notify(
        {
          userId,
          event: 'trip.cancelled',
          title: `Cancelled — ${updated!.reference}`,
          body:
            `Trip ${updated!.reference} (${formatWhen(updated!.pickupAt)}) ` +
            `was cancelled by ${actor.user.fullName}.\nReason: ${reason}`,
          tripId,
        },
        tx,
      );
    }

    return updated!;
  });
}

/** Pull a trip back to the queue without cancelling it. */
export async function returnToPending(actor: TripActor, tripId: string, reason: string) {
  return db.transaction(async (tx) => {
    const trip = await loadTripForUpdate(tx, tripId);
    assertTransitionAllowed(trip, 'return_to_pending', actor);
    const previousVolunteerId = trip.assignedVolunteerId;

    const [updated] = await tx
      .update(trips)
      .set({
        status: 'pending',
        assignedVolunteerId: null,
        assignedAt: null,
        acceptedAt: null,
        offerExpiresAt: null,
      })
      .where(eq(trips.id, tripId))
      .returning();

    await tx
      .update(tripOffers)
      .set({ status: 'cancelled', respondedAt: new Date() })
      .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.status, 'pending')));

    await tx
      .update(tripAssignments)
      .set({ unassignedAt: new Date(), unassignedReason: reason })
      .where(and(eq(tripAssignments.tripId, tripId), isNull(tripAssignments.unassignedAt)));

    await recordAudit(
      {
        actor: actor.audit,
        action: 'trip.returned_to_pending',
        entityType: 'trip',
        entityId: tripId,
        previous: tripSnapshot(trip as unknown as Record<string, unknown>),
        next: tripSnapshot(updated as unknown as Record<string, unknown>),
        metadata: { reason, previousVolunteerId },
      },
      tx,
    );

    if (previousVolunteerId) {
      await notify(
        {
          userId: previousVolunteerId,
          event: 'trip.reassigned',
          title: `Trip ${updated!.reference} withdrawn`,
          body: `Trip ${updated!.reference} has been taken back by dispatch. Reason: ${reason}`,
          tripId,
        },
        tx,
      );
    }
    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Scheduler-driven transitions
// ---------------------------------------------------------------------------

/** Expire one offer. Called by the job runner at the offer's expiry time. */
export async function expireOffer(offerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [offer] = await tx
      .update(tripOffers)
      .set({ status: 'expired', respondedAt: new Date() })
      .where(
        and(
          eq(tripOffers.id, offerId),
          eq(tripOffers.status, 'pending'),
          raw`${tripOffers.expiresAt} <= ${new Date().toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: tripOffers.id, tripId: tripOffers.tripId });

    if (!offer) return;

    // If that was the last live offer, the trip itself expires and dispatchers
    // are told. A request never just goes quiet.
    const remainingRows = (await tx.execute(raw`
      select count(*)::int as remaining from trip_offers
      where trip_id = ${offer.tripId} and status = 'pending'
    `)) as unknown as Array<{ remaining: number }>;
    const remaining = Number(remainingRows[0]!.remaining);

    if (remaining > 0) return;

    const [trip] = await tx
      .update(trips)
      .set({ status: 'expired', offerExpiresAt: null })
      .where(and(eq(trips.id, offer.tripId), eq(trips.status, 'offered')))
      .returning();

    if (!trip) return;

    await recordAudit(
      {
        actor: SYSTEM_ACTOR,
        action: 'trip.expired',
        entityType: 'trip',
        entityId: trip.id,
        previous: { status: 'offered' },
        next: tripSnapshot(trip as unknown as Record<string, unknown>),
        metadata: { reason: 'no volunteer accepted within the offer window' },
      },
      tx,
    );

    const dispatchers = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          inArray(users.role, ['dispatcher', 'admin']),
          eq(users.status, 'active'),
          isNull(users.deletedAt),
        ),
      );

    for (const d of dispatchers) {
      await notify(
        {
          userId: d.id,
          event: 'trip.expired',
          title: `No answer — ${trip.reference}`,
          body:
            `Nobody accepted trip ${trip.reference} (pickup ${formatWhen(trip.pickupAt)}). ` +
            `It needs a direct assignment or a wider broadcast.`,
          tripId: trip.id,
        },
        tx,
      );
    }
  });
}

/** Warn dispatchers that an offer round is going unanswered, before it expires. */
export async function escalateUnanswered(tripId: string, round: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [trip] = await tx
      .select()
      .from(trips)
      .where(and(eq(trips.id, tripId), eq(trips.status, 'offered'), isNull(trips.escalatedAt)))
      .limit(1);
    if (!trip) return;

    await tx
      .update(trips)
      .set({ escalatedAt: new Date(), escalationCount: trip.escalationCount + 1 })
      .where(eq(trips.id, tripId));

    const offeredCount = (
      (await tx.execute(raw`
        select count(*)::int as n from trip_offers where trip_id = ${tripId} and round = ${round}
      `)) as unknown as Array<{ n: number }>
    )[0]!.n;
    const minutes = Math.round((Date.now() - trip.updatedAt.getTime()) / 60_000);

    await recordAudit(
      {
        actor: SYSTEM_ACTOR,
        action: 'trip.escalated',
        entityType: 'trip',
        entityId: tripId,
        metadata: { round, reason: 'no response within escalation window' },
      },
      tx,
    );

    const dispatchers = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          inArray(users.role, ['dispatcher', 'admin']),
          eq(users.status, 'active'),
          isNull(users.deletedAt),
        ),
      );

    const rendered = await renderTemplate(
      'trip.escalated',
      'sms',
      {
        reference: trip.reference,
        when: formatWhen(trip.pickupAt),
        offered: offeredCount,
        minutes,
        appUrl: `${env.APP_URL}/trips/${tripId}`,
      },
      tx,
    );

    for (const d of dispatchers) {
      await notify(
        {
          userId: d.id,
          event: 'trip.escalated',
          title: `Still unanswered — ${trip.reference}`,
          body: rendered.body,
          tripId,
          // In-app plus push: a dispatcher at the board sees it immediately,
          // and one who has stepped away gets it on their phone. Not SMS —
          // escalations are frequent and would drown the useful texts.
          forceChannels: ['inapp', 'push'],
        },
        tx,
      );
    }
  });
}

export { or };

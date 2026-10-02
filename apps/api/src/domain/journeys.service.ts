import { sql as raw } from 'drizzle-orm';
import type { CreateJourneyInput, JourneyKind, JourneyView, PassengerInput, ReturnMode } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { recordAudit } from '../lib/audit.js';
import { Errors } from '../lib/errors.js';
import type { AuthenticatedUser } from '../auth/session.js';
import { createTrip, updateTrip, type CreateTripArgs, type TripActor } from './dispatch.service.js';

/**
 * Journeys: round trips, extra stops and several passengers.
 *
 * Every leg is an ordinary trip created by createTrip, so everything that
 * already works per trip keeps working per leg: offers and reminders,
 * claiming, reassignment, cancellation, the driver's view. Cancelling one leg
 * cancels only that leg. The journey only ties legs together for the
 * coordinator and remembers a return ride that has no time yet.
 *
 * Off unless MULTI_LEG_TRIPS_ENABLED (the routes answer 404).
 */

type TripBase = CreateJourneyInput['trip'];

function legArgs(base: TripBase, over: Partial<CreateTripArgs>): CreateTripArgs {
  return {
    isTest: base.isTest,
    callerId: base.callerId ?? null,
    callerName: base.callerName ?? null,
    callerPhone: base.callerPhone ?? null,
    callbackNumber: base.callbackNumber ?? null,
    pickup: base.pickup,
    dropoff: base.dropoff,
    pickupEntrance: base.pickupEntrance ?? null,
    pickupParking: base.pickupParking ?? null,
    dropoffEntrance: base.dropoffEntrance ?? null,
    dropoffParking: base.dropoffParking ?? null,
    pickupAt: base.pickupAt,
    appointmentAt: base.appointmentAt ?? null,
    tripType: base.tripType,
    priority: base.priority,
    groupSlug: base.groupSlug,
    assignmentMode: base.assignmentMode,
    mobilityNeeds: base.mobilityNeeds,
    passengerNotes: base.passengerNotes ?? null,
    ...over,
  };
}

function unionNeeds(base: string[], passengers: PassengerInput[]): string[] {
  return [...new Set([...base, ...passengers.flatMap((p) => p.mobilityNeeds)])];
}

async function insertPassengers(exec: Executor, tripId: string, passengers: PassengerInput[]): Promise<void> {
  let position = 0;
  for (const p of passengers) {
    await exec.execute(raw`
      insert into trip_passengers (trip_id, position, name, mobility_needs, seats, notes)
      values (${tripId}, ${position++}, ${p.name}, ${`{${p.mobilityNeeds.join(',')}}`}::text[], ${p.seats}, ${p.notes ?? null})`);
  }
}

async function insertLeg(exec: Executor, journeyId: string, legIndex: number, tripId: string, isReturn: boolean): Promise<void> {
  await exec.execute(raw`
    insert into trip_journey_legs (journey_id, leg_index, trip_id, is_return)
    values (${journeyId}, ${legIndex}, ${tripId}, ${isReturn})`);
}

export async function createJourney(actor: TripActor, input: CreateJourneyInput): Promise<string> {
  return db.transaction(async (tx) => {
    const base = input.trip;
    const needs = unionNeeds(base.mobilityNeeds, input.passengers);
    const points = [base.pickup, ...input.stops.map((s) => s.address), base.dropoff];
    const times = [base.pickupAt, ...input.stops.map((s) => s.departAt)];
    const entrances = [base.pickupEntrance ?? null, ...input.stops.map((s) => s.entrance ?? null), base.dropoffEntrance ?? null];

    const kind: JourneyKind = input.stops.length > 0 ? 'multi_stop' : input.return.mode !== 'none' ? 'round_trip' : 'one_way';
    const returnMode: ReturnMode = input.return.mode;
    const pendingReturn = returnMode === 'call_when_ready'
      ? {
          // Everything needed to create the ride home later, minus its time.
          trip: { ...base, pickupAt: undefined },
          pickup: base.dropoff,
          dropoff: base.pickup,
          pickupEntrance: base.dropoffEntrance ?? null,
          dropoffEntrance: base.pickupEntrance ?? null,
        }
      : null;
    const expectedAt = input.return.mode === 'call_when_ready' ? input.return.expectedAt ?? null : null;

    const [journey] = await tx.execute<{ id: string }>(raw`
      insert into trip_journeys (kind, return_mode, pending_return, return_expected_at, created_by_id)
      values (${kind}, ${returnMode}, ${pendingReturn ? JSON.stringify(pendingReturn) : null}::jsonb,
              ${expectedAt ? expectedAt.toISOString() : null}::timestamptz, ${actor.user.id})
      returning id`);
    const journeyId = journey!.id;

    const tripIds: string[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const trip = await createTrip(actor, legArgs(base, {
        pickup: points[i]!,
        dropoff: points[i + 1]!,
        pickupAt: times[i]!,
        pickupEntrance: entrances[i] ?? null,
        dropoffEntrance: entrances[i + 1] ?? null,
        // Parking notes and the appointment belong to the first leg's ends.
        pickupParking: i === 0 ? base.pickupParking ?? null : null,
        dropoffParking: i === points.length - 2 ? base.dropoffParking ?? null : null,
        appointmentAt: i === 0 ? base.appointmentAt ?? null : null,
        mobilityNeeds: needs,
        skipRemember: i > 0,
      }), tx);
      await insertLeg(tx, journeyId, i, trip.id, false);
      await insertPassengers(tx, trip.id, input.passengers);
      tripIds.push(trip.id);
    }

    if (input.return.mode === 'scheduled') {
      const trip = await createTrip(actor, legArgs(base, {
        pickup: base.dropoff,
        dropoff: base.pickup,
        pickupAt: input.return.pickupAt,
        pickupEntrance: base.dropoffEntrance ?? null,
        dropoffEntrance: base.pickupEntrance ?? null,
        pickupParking: base.dropoffParking ?? null,
        dropoffParking: base.pickupParking ?? null,
        appointmentAt: null,
        mobilityNeeds: needs,
        skipRemember: true,
      }), tx);
      await insertLeg(tx, journeyId, points.length - 1, trip.id, true);
      await insertPassengers(tx, trip.id, input.passengers);
      tripIds.push(trip.id);
    }

    await recordAudit({
      actor: actor.audit, action: 'journey.created', entityType: 'trip_journey', entityId: journeyId,
      next: { kind, returnMode, legs: tripIds.length, passengers: input.passengers.length },
      metadata: { tripIds },
    }, tx);
    return journeyId;
  });
}

/**
 * The passenger has called: create the ride home now. Exactly once — a
 * second press, or two coordinators pressing together, gets a conflict that
 * names the ride already created.
 */
export async function returnReady(actor: TripActor, journeyId: string, pickupAt?: Date): Promise<string> {
  return db.transaction(async (tx) => {
    const [j] = await tx.execute<{ id: string; return_mode: string; pending_return: Record<string, unknown> | null; return_called_at: Date | null }>(raw`
      select id, return_mode, pending_return, return_called_at from trip_journeys where id = ${journeyId} for update`);
    if (!j) throw Errors.notFound('Journey');
    if (j.return_mode !== 'call_when_ready' || !j.pending_return) {
      throw Errors.conflict('This journey has no ride home waiting for a call.');
    }
    if (j.return_called_at) {
      const [leg] = await tx.execute<{ trip_id: string }>(raw`
        select trip_id from trip_journey_legs where journey_id = ${journeyId} and is_return order by leg_index desc limit 1`);
      throw Errors.conflict('The ride home has already been arranged.', { tripId: leg?.trip_id ?? null });
    }
    const pending = j.pending_return as {
      trip: TripBase; pickup: TripBase['pickup']; dropoff: TripBase['dropoff'];
      pickupEntrance: string | null; dropoffEntrance: string | null;
    };
    const [{ next }] = await tx.execute<{ next: number }>(raw`
      select coalesce(max(leg_index), -1) + 1 as next from trip_journey_legs where journey_id = ${journeyId}`) as unknown as [{ next: number }];
    const [first] = await tx.execute<{ trip_id: string; mobility_needs: string[] }>(raw`
      select l.trip_id, t.mobility_needs from trip_journey_legs l join trips t on t.id = l.trip_id
       where l.journey_id = ${journeyId} order by l.leg_index limit 1`);

    const when = pickupAt ?? new Date();
    const trip = await createTrip(actor, legArgs({ ...pending.trip, pickupAt: when } as TripBase, {
      pickup: pending.pickup,
      dropoff: pending.dropoff,
      pickupAt: when,
      pickupEntrance: pending.pickupEntrance,
      dropoffEntrance: pending.dropoffEntrance,
      pickupParking: null,
      dropoffParking: null,
      appointmentAt: null,
      mobilityNeeds: first?.mobility_needs ?? pending.trip.mobilityNeeds ?? [],
      skipRemember: true,
    }), tx);
    await insertLeg(tx, journeyId, Number(next), trip.id, true);
    if (first) {
      await tx.execute(raw`
        insert into trip_passengers (trip_id, position, name, mobility_needs, seats, notes)
        select ${trip.id}, position, name, mobility_needs, seats, notes from trip_passengers where trip_id = ${first.trip_id}`);
    }
    await tx.execute(raw`update trip_journeys set return_called_at = now(), updated_at = now() where id = ${journeyId}`);
    await recordAudit({
      actor: actor.audit, action: 'journey.return_called', entityType: 'trip_journey', entityId: journeyId,
      next: { tripId: trip.id, pickupAt: when.toISOString() },
    }, tx);
    return trip.id;
  });
}

type LegRow = {
  leg_index: number; is_return: boolean; trip_id: string; reference: string; status: string;
  pickup_at: Date; from_line: string; to_line: string; volunteer_name: string | null;
};

export async function getJourney(journeyId: string, exec: Executor = db): Promise<JourneyView> {
  const [j] = await exec.execute<{
    id: string; kind: JourneyKind; return_mode: ReturnMode; return_expected_at: Date | null; return_called_at: Date | null;
  }>(raw`select id, kind, return_mode, return_expected_at, return_called_at from trip_journeys where id = ${journeyId}`);
  if (!j) throw Errors.notFound('Journey');
  const legs = await exec.execute<LegRow>(raw`
    select l.leg_index, l.is_return, t.id as trip_id, t.reference, t.status, t.pickup_at,
           pa.line1 as from_line, da.line1 as to_line, u.full_name as volunteer_name
      from trip_journey_legs l
      join trips t on t.id = l.trip_id
      join addresses pa on pa.id = t.pickup_address_id
      join addresses da on da.id = t.dropoff_address_id
      left join users u on u.id = t.assigned_volunteer_id
     where l.journey_id = ${journeyId}
     order by l.leg_index`);
  const passengers = legs[0]
    ? await exec.execute<{ name: string; mobility_needs: string[]; seats: number; notes: string | null }>(raw`
        select name, mobility_needs, seats, notes from trip_passengers where trip_id = ${legs[0].trip_id} order by position`)
    : [];
  return {
    id: j.id,
    kind: j.kind,
    returnMode: j.return_mode,
    returnExpectedAt: j.return_expected_at ? new Date(j.return_expected_at).toISOString() : null,
    returnCalledAt: j.return_called_at ? new Date(j.return_called_at).toISOString() : null,
    awaitingReturnCall: j.return_mode === 'call_when_ready' && !j.return_called_at,
    legs: legs.map((l) => ({
      legIndex: Number(l.leg_index), isReturn: Boolean(l.is_return), tripId: l.trip_id, reference: l.reference,
      status: l.status, pickupAt: new Date(l.pickup_at).toISOString(), from: l.from_line, to: l.to_line,
      volunteerName: l.volunteer_name,
    })),
    passengers: passengers.map((p) => ({ name: p.name, mobilityNeeds: p.mobility_needs ?? [], seats: Number(p.seats), notes: p.notes })),
    seatsNeeded: passengers.reduce((n, p) => n + Number(p.seats), 0),
  };
}

/**
 * The journey a trip belongs to, as the person asking may see it.
 * A coordinator gets the whole journey. A driver gets only where their own
 * leg sits ("leg 2 of 3") and nothing about the other legs.
 */
export async function journeyForTrip(user: AuthenticatedUser, tripId: string):
  Promise<{ journey: JourneyView } | { position: { legIndex: number; legCount: number } } | null> {
  const [leg] = await db.execute<{ journey_id: string; leg_index: number; assigned: string | null }>(raw`
    select l.journey_id, l.leg_index, t.assigned_volunteer_id as assigned
      from trip_journey_legs l join trips t on t.id = l.trip_id where l.trip_id = ${tripId}`);
  if (!leg) return null;
  if (user.role === 'dispatcher' || user.role === 'admin') return { journey: await getJourney(leg.journey_id) };
  if (leg.assigned !== user.id) return null;
  const [{ n }] = await db.execute<{ n: number }>(raw`
    select count(*)::int as n from trip_journey_legs where journey_id = ${leg.journey_id}`) as unknown as [{ n: number }];
  return { position: { legIndex: Number(leg.leg_index), legCount: Number(n) } };
}

/** Journeys whose passenger has not called for the ride home yet. */
export async function awaitingReturn(): Promise<Array<{ journeyId: string; expectedAt: string | null; lastTripId: string; reference: string; callerName: string | null }>> {
  const rows = await db.execute<{ id: string; return_expected_at: Date | null; trip_id: string; reference: string; caller_name: string | null }>(raw`
    select j.id, j.return_expected_at, t.id as trip_id, t.reference, t.caller_name
      from trip_journeys j
      join lateral (
        select l.trip_id from trip_journey_legs l where l.journey_id = j.id order by l.leg_index desc limit 1
      ) last on true
      join trips t on t.id = last.trip_id
     where j.return_mode = 'call_when_ready' and j.return_called_at is null
       and t.status <> 'cancelled' and t.deleted_at is null
     order by j.return_expected_at nulls last, j.created_at`);
  return rows.map((r) => ({
    journeyId: r.id, expectedAt: r.return_expected_at ? new Date(r.return_expected_at).toISOString() : null,
    lastTripId: r.trip_id, reference: r.reference, callerName: r.caller_name,
  }));
}

export async function listPassengers(tripId: string) {
  return db.execute<{ name: string; mobility_needs: string[]; seats: number; notes: string | null }>(raw`
    select name, mobility_needs, seats, notes from trip_passengers where trip_id = ${tripId} order by position`);
}

/**
 * Replaces a trip's passenger list. Their mobility needs are added to the
 * trip's (never removed), so matching keeps asking for a driver who can help.
 */
export async function replacePassengers(actor: TripActor, tripId: string, passengers: PassengerInput[]): Promise<void> {
  const [trip] = await db.execute<{ mobility_needs: string[]; version: number }>(raw`
    select mobility_needs, version from trips where id = ${tripId} and deleted_at is null`);
  if (!trip) throw Errors.notFound('Trip');
  await db.transaction(async (tx) => {
    await tx.execute(raw`delete from trip_passengers where trip_id = ${tripId}`);
    await insertPassengers(tx, tripId, passengers);
    await recordAudit({
      actor: actor.audit, action: 'trip.passengers_set', entityType: 'trip', entityId: tripId,
      next: { passengers: passengers.length, seats: passengers.reduce((n, p) => n + p.seats, 0) },
    }, tx);
  });
  const needs = unionNeeds(trip.mobility_needs ?? [], passengers);
  if (needs.length !== (trip.mobility_needs ?? []).length) {
    await updateTrip(actor, tripId, { mobilityNeeds: needs });
  }
}

import { and, asc, eq, isNull, sql as raw } from 'drizzle-orm';
import { RECURRENCE_FREQUENCIES, SETTING_KEYS, type RecurrenceFrequency } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import {
  addresses,
  callers,
  recurringRideOccurrences,
  recurringRides,
  trips,
  volunteerGroups,
} from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from '../lib/audit.js';
import { getNumberSetting } from '../lib/settings.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import {
  addDaysToDateString,
  daysBetween,
  fromLocalDateString,
  localDateString,
  weekdayOfDateString,
} from '../lib/time.js';
import { createTrip, offerTrip, type TripActor } from './dispatch.service.js';
import { isRestTime } from '../lib/hebcal.js';

/**
 * Standing rides.
 *
 * Dialysis on Monday, Wednesday and Friday. Physiotherapy every second Tuesday.
 * These are a large share of the organisation's work and the legacy app modelled
 * them but never ran them, so dispatchers re-entered the same trip by hand
 * dozens of times a month.
 *
 * The design decision that matters: a recurring ride is a *template with a
 * schedule*, and it never dispatches. A background job turns each occurrence
 * into an ordinary trip, which then goes through the same state machine,
 * targeting, offers, escalation and audit as every other trip. There is no
 * second dispatch path to keep in sync — the thing that goes wrong with
 * recurring work in every system that gives it its own pipeline.
 *
 * Occurrences are recorded in their own table with a unique key on
 * (recurring ride, date), so a horizon that is extended, a job that runs twice,
 * or a worker that crashes mid-batch cannot produce the same ride twice.
 */

export interface RecurringRideInput {
  callerId?: string | null;
  callerName?: string | null;
  callerPhone?: string | null;
  callbackNumber?: string | null;
  pickup: {
    line1: string; unit?: string | null; city?: string; province?: string;
    postalCode?: string | null; notes?: string | null;
    latitude?: number | null; longitude?: number | null;
  };
  dropoff: RecurringRideInput['pickup'];
  pickupEntrance?: string | null;
  pickupParking?: string | null;
  dropoffEntrance?: string | null;
  dropoffParking?: string | null;
  tripType: string;
  priority: string;
  groupSlug: string;
  mobilityNeeds: string[];
  passengerNotes?: string | null;
  appointmentOffsetMinutes?: number | null;
  frequency: RecurrenceFrequency;
  byWeekday: number[];
  byMonthDay?: number | null;
  pickupMinute: number;
  startDate: string;
  endDate?: string | null;
  preferredVolunteerId?: string | null;
  leadTimeMinutes?: number;
}

function validate(input: RecurringRideInput): void {
  if (!RECURRENCE_FREQUENCIES.includes(input.frequency)) {
    throw Errors.validation(`frequency must be one of: ${RECURRENCE_FREQUENCIES.join(', ')}`);
  }
  if (input.frequency === 'monthly') {
    if (!input.byMonthDay || input.byMonthDay < 1 || input.byMonthDay > 28) {
      throw Errors.validation(
        'A monthly standing ride needs a day of the month between 1 and 28. Days 29–31 do not exist in every month, which would silently skip some.',
      );
    }
  } else if (!input.byWeekday?.length) {
    throw Errors.validation('Choose at least one day of the week.');
  } else if (input.byWeekday.some((d) => d < 0 || d > 6)) {
    throw Errors.validation('Days of the week must be 0 (Sunday) through 6 (Saturday).');
  }
  if (input.pickupMinute < 0 || input.pickupMinute > 1439) {
    throw Errors.validation('Pickup time must be a time of day.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) {
    throw Errors.validation('startDate must be YYYY-MM-DD.');
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw Errors.validation('The end date cannot be before the start date.');
  }
}

export async function createRecurringRide(actor: AuditActor, input: RecurringRideInput) {
  validate(input);

  return db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(volunteerGroups)
      .where(eq(volunteerGroups.slug, input.groupSlug))
      .limit(1);
    if (!group) throw Errors.validation(`Unknown volunteer group "${input.groupSlug}"`);

    const [pickup] = await tx.insert(addresses).values({
      line1: input.pickup.line1,
      unit: input.pickup.unit ?? null,
      city: input.pickup.city ?? 'Montreal',
      province: input.pickup.province ?? 'QC',
      postalCode: input.pickup.postalCode ?? null,
      notes: input.pickup.notes ?? null,
      latitude: input.pickup.latitude ?? null,
      longitude: input.pickup.longitude ?? null,
    }).returning();

    const [dropoff] = await tx.insert(addresses).values({
      line1: input.dropoff.line1,
      unit: input.dropoff.unit ?? null,
      city: input.dropoff.city ?? 'Montreal',
      province: input.dropoff.province ?? 'QC',
      postalCode: input.dropoff.postalCode ?? null,
      notes: input.dropoff.notes ?? null,
      latitude: input.dropoff.latitude ?? null,
      longitude: input.dropoff.longitude ?? null,
    }).returning();

    const refRows = (await tx.execute(
      raw`select next_recurring_reference() as reference`,
    )) as unknown as Array<{ reference: string }>;

    const [row] = await tx
      .insert(recurringRides)
      .values({
        reference: refRows[0]!.reference,
        groupId: group.id,
        callerId: input.callerId ?? null,
        callerName: input.callerName ?? null,
        callerPhone: normalizePhone(input.callerPhone),
        callbackNumber: normalizePhone(input.callbackNumber),
        pickupAddressId: pickup!.id,
        dropoffAddressId: dropoff!.id,
        pickupEntrance: input.pickupEntrance ?? null,
        pickupParking: input.pickupParking ?? null,
        dropoffEntrance: input.dropoffEntrance ?? null,
        dropoffParking: input.dropoffParking ?? null,
        tripType: input.tripType,
        priority: input.priority,
        mobilityNeeds: input.mobilityNeeds,
        passengerNotes: input.passengerNotes ?? null,
        appointmentOffsetMinutes: input.appointmentOffsetMinutes ?? null,
        frequency: input.frequency,
        byWeekday: input.frequency === 'monthly' ? [] : input.byWeekday,
        byMonthDay: input.frequency === 'monthly' ? input.byMonthDay! : null,
        pickupMinute: input.pickupMinute,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        preferredVolunteerId: input.preferredVolunteerId ?? null,
        leadTimeMinutes: input.leadTimeMinutes ?? 1440,
        createdById: actor.userId,
      })
      .returning();

    await recordAudit(
      {
        actor,
        action: 'recurring_ride.created',
        entityType: 'recurring_ride',
        entityId: row!.id,
        next: {
          reference: row!.reference,
          frequency: row!.frequency,
          byWeekday: row!.byWeekday,
          startDate: row!.startDate,
          endDate: row!.endDate,
        },
      },
      tx,
    );
    return row!;
  });
}

export async function listRecurringRides(status?: string) {
  const rows = await db
    .select({
      ride: recurringRides,
      group: { slug: volunteerGroups.slug, name: volunteerGroups.name },
      pickup: { line1: addresses.line1, city: addresses.city },
      callerName: callers.name,
    })
    .from(recurringRides)
    .innerJoin(volunteerGroups, eq(volunteerGroups.id, recurringRides.groupId))
    .innerJoin(addresses, eq(addresses.id, recurringRides.pickupAddressId))
    .leftJoin(callers, eq(callers.id, recurringRides.callerId))
    .where(
      status
        ? and(isNull(recurringRides.deletedAt), eq(recurringRides.status, status))
        : isNull(recurringRides.deletedAt),
    )
    .orderBy(asc(recurringRides.reference));
  return rows;
}

export async function getRecurringRide(id: string) {
  const [row] = await db
    .select()
    .from(recurringRides)
    .where(and(eq(recurringRides.id, id), isNull(recurringRides.deletedAt)))
    .limit(1);
  if (!row) throw Errors.notFound('That standing ride no longer exists.');

  const occurrences = await db
    .select({
      occurrence: recurringRideOccurrences,
      trip: { id: trips.id, reference: trips.reference, status: trips.status, pickupAt: trips.pickupAt },
    })
    .from(recurringRideOccurrences)
    .leftJoin(trips, eq(trips.id, recurringRideOccurrences.tripId))
    .where(eq(recurringRideOccurrences.recurringRideId, id))
    .orderBy(asc(recurringRideOccurrences.occurrenceDate));

  return { ...row, occurrences, upcoming: upcomingDates(row, 8) };
}

export async function updateRecurringRide(
  actor: AuditActor,
  id: string,
  patch: Record<string, unknown>,
) {
  const [before] = await db.select().from(recurringRides).where(eq(recurringRides.id, id)).limit(1);
  if (!before) throw Errors.notFound('That standing ride no longer exists.');

  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of [
    'callerName', 'passengerNotes', 'pickupEntrance', 'pickupParking',
    'dropoffEntrance', 'dropoffParking', 'priority', 'status', 'endDate',
    'preferredVolunteerId', 'leadTimeMinutes', 'appointmentOffsetMinutes',
  ]) {
    if (key in patch) set[key] = patch[key] ?? null;
  }
  if ('callerPhone' in patch) set.callerPhone = normalizePhone(patch.callerPhone as string);
  if ('callbackNumber' in patch) set.callbackNumber = normalizePhone(patch.callbackNumber as string);
  if ('mobilityNeeds' in patch) set.mobilityNeeds = patch.mobilityNeeds;
  if ('pickupMinute' in patch) set.pickupMinute = patch.pickupMinute;
  if ('byWeekday' in patch) set.byWeekday = patch.byWeekday;
  if ('byMonthDay' in patch) set.byMonthDay = patch.byMonthDay;
  if ('frequency' in patch) set.frequency = patch.frequency;

  const [after] = await db.update(recurringRides).set(set).where(eq(recurringRides.id, id)).returning();

  await recordAudit({
    actor,
    action: 'recurring_ride.updated',
    entityType: 'recurring_ride',
    entityId: id,
    previous: { status: before.status, pickupMinute: before.pickupMinute, byWeekday: before.byWeekday, endDate: before.endDate },
    next: { status: after!.status, pickupMinute: after!.pickupMinute, byWeekday: after!.byWeekday, endDate: after!.endDate },
    metadata: { fields: Object.keys(set) },
  });
  return after!;
}

/**
 * Ends a standing ride.
 *
 * Trips already materialised are left alone by default: they are real
 * commitments that volunteers may already have accepted. `cancelFuture` also
 * cancels the ones that have not started, which is what a dispatcher usually
 * means when a course of treatment finishes early.
 */
export async function endRecurringRide(
  tripActor: TripActor,
  id: string,
  opts: { reason: string; cancelFuture?: boolean },
): Promise<{ cancelled: number }> {
  const { cancelTrip } = await import('./dispatch.service.js');
  const [ride] = await db.select().from(recurringRides).where(eq(recurringRides.id, id)).limit(1);
  if (!ride) throw Errors.notFound('That standing ride no longer exists.');

  await db
    .update(recurringRides)
    .set({ status: 'ended', endDate: localDateString(new Date()), updatedAt: new Date() })
    .where(eq(recurringRides.id, id));

  let cancelled = 0;
  if (opts.cancelFuture) {
    const future = await db
      .select({ id: trips.id })
      .from(trips)
      .where(
        and(
          eq(trips.recurringRideId, id),
          isNull(trips.deletedAt),
          raw`${trips.pickupAt} > now()`,
          raw`${trips.status} not in ('completed','cancelled')`,
        ),
      );
    for (const t of future) {
      try {
        await cancelTrip(tripActor, t.id, `Standing ride ended: ${opts.reason}`);
        cancelled++;
      } catch (err) {
        logger.error({ err, tripId: t.id }, 'could not cancel a future occurrence');
      }
    }
  }

  await recordAudit({
    actor: tripActor.audit,
    action: 'recurring_ride.ended',
    entityType: 'recurring_ride',
    entityId: id,
    metadata: { reason: opts.reason, cancelledFuture: cancelled },
  });
  return { cancelled };
}

// ---------------------------------------------------------------------------
// Schedule expansion
// ---------------------------------------------------------------------------

interface ScheduleShape {
  frequency: string;
  byWeekday: number[];
  byMonthDay: number | null;
  startDate: string;
  endDate: string | null;
}

/** Does this recurrence fall on this local date? */
export function occursOn(ride: ScheduleShape, isoDate: string): boolean {
  if (isoDate < ride.startDate) return false;
  if (ride.endDate && isoDate > ride.endDate) return false;

  if (ride.frequency === 'monthly') {
    return Number(isoDate.slice(8, 10)) === ride.byMonthDay;
  }

  const weekday = weekdayOfDateString(isoDate);
  if (!ride.byWeekday.includes(weekday)) return false;

  if (ride.frequency === 'biweekly') {
    // Weeks are counted from the start date, so "every second Tuesday" stays on
    // the same fortnight regardless of when the materialiser happens to run.
    const weeksSinceStart = Math.floor(daysBetween(ride.startDate, isoDate) / 7);
    return weeksSinceStart % 2 === 0;
  }
  return true;
}

export function upcomingDates(ride: ScheduleShape, count: number, from?: string): string[] {
  const out: string[] = [];
  let cursor = from ?? localDateString(new Date());
  if (cursor < ride.startDate) cursor = ride.startDate;
  for (let i = 0; i < 400 && out.length < count; i++) {
    if (occursOn(ride, cursor)) out.push(cursor);
    cursor = addDaysToDateString(cursor, 1);
    if (ride.endDate && cursor > ride.endDate) break;
  }
  return out;
}

/**
 * Turns due occurrences into real trips.
 *
 * Runs on a schedule and is safe to run as often as you like: the unique index
 * on (recurring_ride_id, occurrence_date) is what makes it idempotent, not the
 * caller's discipline.
 *
 * A trip landing inside Shabbos or yom tov is created but *not* offered, and
 * the occurrence records why. The software does not decide whether such a ride
 * may happen — a dispatcher does — but it will not quietly text forty people
 * about it either.
 */
export async function materialiseDueRides(now = new Date()): Promise<{
  created: number;
  offered: number;
  skipped: number;
}> {
  const horizonDays = await getNumberSetting(SETTING_KEYS.recurringHorizonDays);
  const today = localDateString(now);
  const horizon = addDaysToDateString(today, horizonDays);

  const rides = await db
    .select()
    .from(recurringRides)
    .where(and(eq(recurringRides.status, 'active'), isNull(recurringRides.deletedAt)));

  let created = 0;
  let offered = 0;
  let skipped = 0;

  for (const ride of rides) {
    const [group] = await db
      .select()
      .from(volunteerGroups)
      .where(eq(volunteerGroups.id, ride.groupId))
      .limit(1);
    const [pickup] = await db.select().from(addresses).where(eq(addresses.id, ride.pickupAddressId));
    const [dropoff] = await db.select().from(addresses).where(eq(addresses.id, ride.dropoffAddressId));
    if (!group || !pickup || !dropoff) {
      logger.error({ rideId: ride.id }, 'standing ride is missing its group or addresses; skipping');
      continue;
    }

    let cursor = today > ride.startDate ? today : ride.startDate;
    while (cursor <= horizon) {
      if (!occursOn(ride, cursor)) {
        cursor = addDaysToDateString(cursor, 1);
        continue;
      }

      const [existing] = await db
        .select({ id: recurringRideOccurrences.id })
        .from(recurringRideOccurrences)
        .where(
          and(
            eq(recurringRideOccurrences.recurringRideId, ride.id),
            eq(recurringRideOccurrences.occurrenceDate, cursor),
          ),
        )
        .limit(1);
      if (existing) {
        cursor = addDaysToDateString(cursor, 1);
        continue;
      }

      const pickupAt = fromLocalDateString(cursor, ride.pickupMinute);
      if (pickupAt.getTime() < now.getTime()) {
        // The horizon moved over a date that has already passed; record it as
        // skipped rather than creating a trip in the past.
        await db.insert(recurringRideOccurrences).values({
          recurringRideId: ride.id,
          occurrenceDate: cursor,
          skipped: true,
          skipReason: 'occurrence date already passed when the schedule was expanded',
        }).onConflictDoNothing();
        skipped++;
        cursor = addDaysToDateString(cursor, 1);
        continue;
      }

      const rest = isRestTime(pickupAt);

      // Claim the date before creating anything. The select above is only a
      // fast path: the scheduled job and the "run now" button can overlap, and
      // without this claim both would create (and offer) the same ride. The
      // unique index decides who wins; the loser moves on.
      const [claim] = await db
        .insert(recurringRideOccurrences)
        .values({ recurringRideId: ride.id, occurrenceDate: cursor })
        .onConflictDoNothing()
        .returning({ id: recurringRideOccurrences.id });
      if (!claim) {
        cursor = addDaysToDateString(cursor, 1);
        continue;
      }

      const systemActor: TripActor = {
        user: {
          id: ride.createdById ?? '00000000-0000-0000-0000-000000000000',
          role: 'admin',
          fullName: 'Standing ride scheduler',
          email: '',
          status: 'active',
          groups: [],
        } as never,
        audit: SYSTEM_ACTOR,
      };

      try {
        const trip = await createTrip(systemActor, {
          callerId: ride.callerId,
          callerName: ride.callerName,
          callerPhone: ride.callerPhone,
          callbackNumber: ride.callbackNumber,
          pickup: {
            line1: pickup.line1, unit: pickup.unit, city: pickup.city, province: pickup.province,
            postalCode: pickup.postalCode, notes: pickup.notes,
            latitude: pickup.latitude, longitude: pickup.longitude,
          },
          dropoff: {
            line1: dropoff.line1, unit: dropoff.unit, city: dropoff.city, province: dropoff.province,
            postalCode: dropoff.postalCode, notes: dropoff.notes,
            latitude: dropoff.latitude, longitude: dropoff.longitude,
          },
          pickupEntrance: ride.pickupEntrance,
          pickupParking: ride.pickupParking,
          dropoffEntrance: ride.dropoffEntrance,
          dropoffParking: ride.dropoffParking,
          pickupAt,
          appointmentAt: ride.appointmentOffsetMinutes
            ? new Date(pickupAt.getTime() + ride.appointmentOffsetMinutes * 60_000)
            : null,
          tripType: ride.tripType,
          priority: ride.priority,
          groupSlug: group.slug,
          assignmentMode: 'auto',
          mobilityNeeds: ride.mobilityNeeds,
          passengerNotes: ride.passengerNotes,
          recurringRideId: ride.id,
          skipRemember: true,
        });

        await db
          .update(recurringRideOccurrences)
          .set({
            tripId: trip.id,
            skipped: rest.resting,
            skipReason: rest.resting
              ? `pickup falls during ${rest.period?.label ?? 'a rest period'} — created but not offered`
              : null,
          })
          .where(eq(recurringRideOccurrences.id, claim.id));
        created++;

        // Offer once the lead time is reached, and never during a rest period.
        const offerAt = pickupAt.getTime() - ride.leadTimeMinutes * 60_000;
        if (!rest.resting && offerAt <= now.getTime()) {
          try {
            await offerTrip(systemActor, trip.id);
            offered++;
          } catch (err) {
            // No eligible volunteer right now is not an error worth failing the
            // batch for — the trip is on the board and a dispatcher will see it.
            logger.info(
              { tripId: trip.id, err: (err as Error).message },
              'standing ride materialised but could not be offered yet',
            );
          }
        }
      } catch (err) {
        logger.error({ err, rideId: ride.id, date: cursor }, 'could not materialise a standing ride');
        // Release the claim if no trip was made, so the next run tries again
        // instead of the date being silently lost.
        await db
          .delete(recurringRideOccurrences)
          .where(and(eq(recurringRideOccurrences.id, claim.id), isNull(recurringRideOccurrences.tripId)))
          .catch((e) => logger.error({ err: e, rideId: ride.id }, 'could not release occurrence claim'));
      }

      cursor = addDaysToDateString(cursor, 1);
    }

    await db
      .update(recurringRides)
      .set({ lastMaterialisedDate: horizon })
      .where(eq(recurringRides.id, ride.id));
  }

  logger.info({ created, offered, skipped, horizon }, 'standing rides materialised');
  return { created, offered, skipped };
}

/** Offers standing-ride trips whose lead time has arrived. */
export async function offerDueRecurringTrips(now = new Date()): Promise<number> {
  const due = (await db.execute(raw`
    select t.id
    from trips t
    join recurring_rides rr on rr.id = t.recurring_ride_id
    join recurring_ride_occurrences o on o.trip_id = t.id
    where t.status = 'pending'
      and t.deleted_at is null
      and o.skipped = false
      and t.pickup_at - make_interval(mins => rr.lead_time_minutes) <= ${now.toISOString()}::timestamptz
      and t.pickup_at > ${now.toISOString()}::timestamptz
  `)) as unknown as Array<{ id: string }>;

  let offered = 0;
  for (const row of due) {
    try {
      const systemActor: TripActor = {
        user: { id: null, role: 'admin', fullName: 'Standing ride scheduler', groups: [] } as never,
        audit: SYSTEM_ACTOR,
      };
      await offerTrip(systemActor, row.id);
      offered++;
    } catch (err) {
      logger.info({ tripId: row.id, err: (err as Error).message }, 'standing ride not offered yet');
    }
  }
  return offered;
}

export { type Executor };

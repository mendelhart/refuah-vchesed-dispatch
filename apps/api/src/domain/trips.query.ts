import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql as raw } from 'drizzle-orm';
import {
  ENGAGED_TRIP_STATUSES,
  OPEN_TRIP_STATUSES,
  transitionsFrom,
  type BoardSummary,
  type OfferedTripDto,
  type TripDto,
  type TripStatus,
} from '@rvc/shared';
import { db } from '../db/client.js';
import { addresses, tripOffers, trips, userGroups, users, volunteerGroups } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import type { AuthenticatedUser } from '../auth/session.js';
import { canSeeDispatchDetail } from '../auth/guards.js';

/**
 * Reads.
 *
 * Scoping happens in SQL, never in the browser. A volunteer's query is
 * constrained by their own id and their group membership before it reaches the
 * database, so the response cannot contain a trip they are not entitled to —
 * the legacy client downloaded the 200 most recent trips (caller names, phones,
 * addresses, passenger notes) and filtered them in JavaScript.
 *
 * There are two projections: the dispatcher's `TripDto`, and the volunteer's
 * pre-claim `OfferedTripDto`, which deliberately omits caller identity and the
 * exact pickup address.
 */

const pickup = aliasedTable(addresses, 'pickup');
const dropoff = aliasedTable(addresses, 'dropoff');
const assignee = aliasedTable(users, 'assignee');

const baseSelection = {
  id: trips.id,
  reference: trips.reference,
  status: trips.status,
  priority: trips.priority,
  tripType: trips.tripType,
  assignmentMode: trips.assignmentMode,
  callerId: trips.callerId,
  callerName: trips.callerName,
  callerPhone: trips.callerPhone,
  callbackNumber: trips.callbackNumber,
  pickupEntrance: trips.pickupEntrance,
  pickupParking: trips.pickupParking,
  dropoffEntrance: trips.dropoffEntrance,
  dropoffParking: trips.dropoffParking,
  appointmentAt: trips.appointmentAt,
  recurringRideId: trips.recurringRideId,
  duplicatedFromTripId: trips.duplicatedFromTripId,
  offerRound: trips.offerRound,
  escalationCount: trips.escalationCount,
  escalatedAt: trips.escalatedAt,
  pickupAt: trips.pickupAt,
  mobilityNeeds: trips.mobilityNeeds,
  passengerNotes: trips.passengerNotes,
  offerExpiresAt: trips.offerExpiresAt,
  createdAt: trips.createdAt,
  updatedAt: trips.updatedAt,
  version: trips.version,
  groupId: volunteerGroups.id,
  groupSlug: volunteerGroups.slug,
  groupName: volunteerGroups.name,
  assigneeId: assignee.id,
  assigneeName: assignee.fullName,
  assigneePhone: assignee.phone,
  pickupId: pickup.id,
  pickupLine1: pickup.line1,
  pickupUnit: pickup.unit,
  pickupCity: pickup.city,
  pickupProvince: pickup.province,
  pickupPostal: pickup.postalCode,
  pickupCountry: pickup.country,
  pickupNotes: pickup.notes,
  pickupLat: pickup.latitude,
  pickupLng: pickup.longitude,
  dropoffId: dropoff.id,
  dropoffLine1: dropoff.line1,
  dropoffUnit: dropoff.unit,
  dropoffCity: dropoff.city,
  dropoffProvince: dropoff.province,
  dropoffPostal: dropoff.postalCode,
  dropoffCountry: dropoff.country,
  dropoffNotes: dropoff.notes,
  dropoffLat: dropoff.latitude,
  dropoffLng: dropoff.longitude,
  openOfferCount: raw<number>`(
    select count(*)::int from trip_offers o
    where o.trip_id = ${trips.id} and o.status = 'pending'
  )`,
  interestedCount: raw<number>`(
    select count(*)::int from trip_offers o
    where o.trip_id = ${trips.id} and o.status in ('pending','accepted')
  )`,
} as const;

type Row = Record<string, unknown>;

function formatAddress(line1: string, unit: string | null, city: string, province: string, postal: string | null) {
  return [line1 + (unit ? `, Unit ${unit}` : ''), city, province, postal].filter(Boolean).join(', ');
}

function toDto(r: Row): TripDto {
  const pickupAt = r.pickupAt as Date;
  const status = r.status as TripStatus;
  const isOverdue =
    OPEN_TRIP_STATUSES.includes(status) && pickupAt.getTime() < Date.now() - 15 * 60_000;

  return {
    id: r.id as string,
    reference: r.reference as string,
    status,
    priority: r.priority as TripDto['priority'],
    tripType: r.tripType as TripDto['tripType'],
    assignmentMode: r.assignmentMode as TripDto['assignmentMode'],
    group: { id: r.groupId as string, slug: r.groupSlug as string, name: r.groupName as string },
    callerId: (r.callerId as string) ?? null,
    callerName: (r.callerName as string) ?? null,
    callerPhone: (r.callerPhone as string) ?? null,
    callbackNumber: (r.callbackNumber as string) ?? null,
    pickupEntrance: (r.pickupEntrance as string) ?? null,
    pickupParking: (r.pickupParking as string) ?? null,
    dropoffEntrance: (r.dropoffEntrance as string) ?? null,
    dropoffParking: (r.dropoffParking as string) ?? null,
    appointmentAt: r.appointmentAt ? (r.appointmentAt as Date).toISOString() : null,
    recurringRideId: (r.recurringRideId as string) ?? null,
    duplicatedFromTripId: (r.duplicatedFromTripId as string) ?? null,
    offerRound: Number(r.offerRound ?? 0),
    escalationCount: Number(r.escalationCount ?? 0),
    escalatedAt: r.escalatedAt ? (r.escalatedAt as Date).toISOString() : null,
    pickup: {
      id: r.pickupId as string,
      line1: r.pickupLine1 as string,
      unit: (r.pickupUnit as string) ?? null,
      city: r.pickupCity as string,
      province: r.pickupProvince as string,
      postalCode: (r.pickupPostal as string) ?? null,
      country: r.pickupCountry as string,
      notes: (r.pickupNotes as string) ?? null,
      formatted: formatAddress(
        r.pickupLine1 as string, (r.pickupUnit as string) ?? null,
        r.pickupCity as string, r.pickupProvince as string, (r.pickupPostal as string) ?? null,
      ),
      latitude: (r.pickupLat as number) ?? null,
      longitude: (r.pickupLng as number) ?? null,
    },
    dropoff: {
      id: r.dropoffId as string,
      line1: r.dropoffLine1 as string,
      unit: (r.dropoffUnit as string) ?? null,
      city: r.dropoffCity as string,
      province: r.dropoffProvince as string,
      postalCode: (r.dropoffPostal as string) ?? null,
      country: r.dropoffCountry as string,
      notes: (r.dropoffNotes as string) ?? null,
      formatted: formatAddress(
        r.dropoffLine1 as string, (r.dropoffUnit as string) ?? null,
        r.dropoffCity as string, r.dropoffProvince as string, (r.dropoffPostal as string) ?? null,
      ),
      latitude: (r.dropoffLat as number) ?? null,
      longitude: (r.dropoffLng as number) ?? null,
    },
    pickupAt: pickupAt.toISOString(),
    mobilityNeeds: (r.mobilityNeeds as TripDto['mobilityNeeds']) ?? [],
    passengerNotes: (r.passengerNotes as string) ?? null,
    assignedVolunteer: r.assigneeId
      ? {
          id: r.assigneeId as string,
          fullName: r.assigneeName as string,
          phone: (r.assigneePhone as string) ?? null,
        }
      : null,
    openOfferCount: Number(r.openOfferCount ?? 0),
    interestedCount: Number(r.interestedCount ?? 0),
    offerExpiresAt: r.offerExpiresAt ? (r.offerExpiresAt as Date).toISOString() : null,
    isOverdue,
    createdAt: (r.createdAt as Date).toISOString(),
    updatedAt: (r.updatedAt as Date).toISOString(),
    version: Number(r.version),
    availableTransitions: transitionsFrom(status),
  };
}

/** Pre-claim projection. Everything identifying is withheld. */
function toOfferedDto(r: Row, offer?: { id: string; expiresAt: Date; status: string }): OfferedTripDto {
  const strip = (line1: string) => line1.replace(/^\s*\d+[A-Za-z]?\s+/, '');
  return {
    id: r.id as string,
    reference: r.reference as string,
    status: r.status as TripStatus,
    priority: r.priority as OfferedTripDto['priority'],
    tripType: r.tripType as OfferedTripDto['tripType'],
    pickupArea: `${strip(r.pickupLine1 as string)}, ${r.pickupCity as string}`,
    dropoffArea: `${strip(r.dropoffLine1 as string)}, ${r.dropoffCity as string}`,
    pickupAt: (r.pickupAt as Date).toISOString(),
    appointmentAt: r.appointmentAt ? (r.appointmentAt as Date).toISOString() : null,
    mobilityNeeds: (r.mobilityNeeds as OfferedTripDto['mobilityNeeds']) ?? [],
    offer: offer
      ? { id: offer.id, expiresAt: offer.expiresAt.toISOString(), status: offer.status as never }
      : null,
  };
}

function baseQuery() {
  return db
    .select(baseSelection)
    .from(trips)
    .innerJoin(volunteerGroups, eq(volunteerGroups.id, trips.groupId))
    .innerJoin(pickup, eq(pickup.id, trips.pickupAddressId))
    .innerJoin(dropoff, eq(dropoff.id, trips.dropoffAddressId))
    .leftJoin(assignee, eq(assignee.id, trips.assignedVolunteerId));
}

export interface ListTripsArgs {
  scope: 'board' | 'mine' | 'available' | 'history';
  status?: TripStatus[];
  groupSlug?: string;
  search?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

export interface ListTripsResult {
  items: TripDto[] | OfferedTripDto[];
  nextCursor: string | null;
}

export async function listTrips(
  user: AuthenticatedUser,
  args: ListTripsArgs,
): Promise<ListTripsResult> {
  const dispatcher = canSeeDispatchDetail(user);
  const groupIds = user.groups.map((g) => g.id);
  const conditions = [isNull(trips.deletedAt)];

  if (args.status?.length) conditions.push(inArray(trips.status, args.status));
  if (args.groupSlug) conditions.push(eq(volunteerGroups.slug, args.groupSlug));
  if (args.from) conditions.push(gte(trips.pickupAt, args.from));
  if (args.to) conditions.push(lte(trips.pickupAt, args.to));

  if (args.search) {
    const term = `%${args.search.toLowerCase()}%`;
    // Volunteers cannot search by caller identity — they only ever match their
    // own trips, and only on the reference.
    conditions.push(
      dispatcher
        ? or(
            raw`lower(${trips.reference}) like ${term}`,
            raw`lower(coalesce(${trips.callerName}, '')) like ${term}`,
            raw`coalesce(${trips.callerPhone}, '') like ${term}`,
            raw`lower(${pickup.line1}) like ${term}`,
            raw`lower(${dropoff.line1}) like ${term}`,
          )!
        : raw`lower(${trips.reference}) like ${term}`,
    );
  }

  switch (args.scope) {
    case 'board': {
      if (!dispatcher) throw Errors.forbidden('The dispatch board is not available to volunteers.');
      if (!args.status?.length) conditions.push(inArray(trips.status, [...OPEN_TRIP_STATUSES]));
      break;
    }
    case 'mine': {
      conditions.push(eq(trips.assignedVolunteerId, user.id));
      break;
    }
    case 'history': {
      if (!dispatcher) conditions.push(eq(trips.assignedVolunteerId, user.id));
      if (!args.status?.length) conditions.push(inArray(trips.status, ['completed', 'cancelled']));
      break;
    }
    case 'available': {
      // Only trips this volunteer holds a live offer for. Group membership
      // alone is not enough: an offer row must exist.
      if (groupIds.length === 0) return { items: [], nextCursor: null };
      conditions.push(
        eq(trips.status, 'offered'),
        isNull(trips.assignedVolunteerId),
        raw`exists (
          select 1 from trip_offers o
          where o.trip_id = ${trips.id}
            and o.volunteer_id = ${user.id}
            and o.status = 'pending'
            and o.expires_at > now()
        )`,
      );
      break;
    }
  }

  if (args.cursor) {
    const decoded = decodeCursor(args.cursor);
    if (decoded) {
      conditions.push(
        raw`(${trips.pickupAt}, ${trips.id}) ${args.scope === 'history' ? raw`<` : raw`>`} (${decoded.pickupAt}, ${decoded.id})`,
      );
    }
  }

  const order =
    args.scope === 'history'
      ? [desc(trips.pickupAt), desc(trips.id)]
      : [asc(trips.pickupAt), asc(trips.id)];

  const rows = (await baseQuery()
    .where(and(...conditions))
    .orderBy(...order)
    .limit(args.limit + 1)) as unknown as Row[];

  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.pickupAt as Date, last.id as string) : null;

  if (args.scope === 'available' && !dispatcher) {
    const ids = page.map((r) => r.id as string);
    const offers = ids.length
      ? await db
          .select({
            id: tripOffers.id,
            tripId: tripOffers.tripId,
            expiresAt: tripOffers.expiresAt,
            status: tripOffers.status,
          })
          .from(tripOffers)
          .where(
            and(
              inArray(tripOffers.tripId, ids),
              eq(tripOffers.volunteerId, user.id),
              eq(tripOffers.status, 'pending'),
            ),
          )
      : [];
    const byTrip = new Map(offers.map((o) => [o.tripId, o]));
    return { items: page.map((r) => toOfferedDto(r, byTrip.get(r.id as string))), nextCursor };
  }

  return { items: page.map(toDto), nextCursor };
}

export async function getTrip(user: AuthenticatedUser, tripId: string): Promise<TripDto | OfferedTripDto> {
  const rows = (await baseQuery()
    .where(and(eq(trips.id, tripId), isNull(trips.deletedAt)))
    .limit(1)) as unknown as Row[];
  const row = rows[0];
  if (!row) throw Errors.notFound('Trip');

  if (canSeeDispatchDetail(user)) return toDto(row);

  // A volunteer sees full detail only for a trip that is theirs.
  if (row.assigneeId === user.id) return toDto(row);

  const [offer] = await db
    .select({ id: tripOffers.id, expiresAt: tripOffers.expiresAt, status: tripOffers.status })
    .from(tripOffers)
    .where(
      and(
        eq(tripOffers.tripId, tripId),
        eq(tripOffers.volunteerId, user.id),
        eq(tripOffers.status, 'pending'),
      ),
    )
    .limit(1);

  if (!offer) throw Errors.notFound('Trip');
  return toOfferedDto(row, offer);
}

export async function boardSummary(user: AuthenticatedUser): Promise<BoardSummary> {
  if (!canSeeDispatchDetail(user)) throw Errors.forbidden();
  const [row] = await db
    .select({
      needsAttention: raw<number>`count(*) filter (where ${trips.status} in ('new','pending','expired'))::int`,
      offered: raw<number>`count(*) filter (where ${trips.status} = 'offered')::int`,
      assigned: raw<number>`count(*) filter (where ${trips.status} in ('assigned','accepted'))::int`,
      inProgress: raw<number>`count(*) filter (where ${trips.status} in ('en_route','in_progress'))::int`,
      overdue: raw<number>`count(*) filter (where ${trips.pickupAt} < now() - interval '15 minutes')::int`,
      unanswered: raw<number>`count(*) filter (where ${trips.status} = 'offered' and ${trips.escalatedAt} is not null)::int`,
    })
    .from(trips)
    .where(and(isNull(trips.deletedAt), inArray(trips.status, [...OPEN_TRIP_STATUSES])));
  return (
    row ?? { needsAttention: 0, offered: 0, assigned: 0, inProgress: 0, overdue: 0, unanswered: 0 }
  );
}

/** Volunteers eligible for a trip: active members of its group. */
export async function eligibleVolunteers(tripId: string) {
  const [trip] = await db.select({ groupId: trips.groupId }).from(trips).where(eq(trips.id, tripId));
  if (!trip) throw Errors.notFound('Trip');
  return db
    .select({ id: users.id, fullName: users.fullName, phone: users.phone, role: users.role })
    .from(users)
    .innerJoin(userGroups, eq(userGroups.userId, users.id))
    .where(
      and(
        eq(userGroups.groupId, trip.groupId),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
        ne(users.role, 'dispatcher'),
      ),
    )
    .orderBy(asc(users.fullName));
}

function encodeCursor(pickupAt: Date, id: string): string {
  return Buffer.from(`${pickupAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { pickupAt: string; id: string } | null {
  try {
    const [pickupAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!pickupAt || !id) return null;
    return { pickupAt, id };
  } catch {
    return null;
  }
}

export { ENGAGED_TRIP_STATUSES };

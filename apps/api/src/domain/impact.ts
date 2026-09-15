import { and, desc, eq, sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { addresses, trips } from '../db/schema.js';

/**
 * A volunteer's own record.
 *
 * Deliberately a ledger of real trips plus a few honest counts — no
 * leaderboards, streaks or badges. For a chesed organisation, ranking
 * volunteers against each other is the wrong incentive, and a streak punishes
 * the person who takes a month off.
 */
export async function volunteerImpact(userId: string, limit = 50) {
  const [totals] = await db.select({
    completed: raw<number>`count(*) filter (where ${trips.status} = 'completed')::int`,
    completedThisMonth: raw<number>`count(*) filter (
      where ${trips.status} = 'completed'
        and ${trips.completedAt} >= date_trunc('month', now() at time zone 'America/Toronto')
    )::int`,
    upcoming: raw<number>`count(*) filter (
      where ${trips.status} in ('assigned','accepted','en_route','in_progress')
    )::int`,
    firstAt: raw<string | null>`min(${trips.completedAt})`,
  }).from(trips).where(eq(trips.assignedVolunteerId, userId));

  const recent = await db.select({
    id: trips.id, reference: trips.reference, status: trips.status,
    pickupAt: trips.pickupAt, completedAt: trips.completedAt,
    tripType: trips.tripType, city: addresses.city,
  }).from(trips)
    .innerJoin(addresses, eq(addresses.id, trips.dropoffAddressId))
    .where(and(eq(trips.assignedVolunteerId, userId), raw`${trips.deletedAt} is null`))
    .orderBy(desc(trips.pickupAt))
    .limit(limit);

  return {
    totals: {
      completed: totals?.completed ?? 0,
      completedThisMonth: totals?.completedThisMonth ?? 0,
      upcoming: totals?.upcoming ?? 0,
      volunteeringSince: totals?.firstAt ?? null,
    },
    trips: recent,
  };
}

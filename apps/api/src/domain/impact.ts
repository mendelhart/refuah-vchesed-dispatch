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

/**
 * The whole organisation's record: what Refuah V'Chesed volunteers did
 * together. Counts only; no ranking of individual volunteers.
 */
export async function organizationImpact() {
  const monthStart = raw`date_trunc('month', now() at time zone 'America/Toronto')`;
  const yearStart = raw`date_trunc('year', now() at time zone 'America/Toronto')`;
  const [totals] = (await db.execute(raw`
    select
      count(*) filter (where status = 'completed')::int as completed,
      count(*) filter (where status = 'completed' and completed_at >= ${monthStart})::int as completed_this_month,
      count(*) filter (where status = 'completed' and completed_at >= ${yearStart})::int as completed_this_year,
      count(*) filter (where status in ('assigned','accepted','en_route','in_progress'))::int as upcoming,
      count(distinct assigned_volunteer_id) filter (where status = 'completed')::int as volunteers_all_time,
      count(distinct assigned_volunteer_id) filter (where status = 'completed' and completed_at >= now() - interval '30 days')::int as volunteers_last_30_days,
      count(distinct coalesce(caller_id::text, caller_phone)) filter (where status = 'completed')::int as people_helped,
      min(completed_at) as first_at
    from trips where deleted_at is null
  `)) as unknown as Array<Record<string, number | string | null>>;

  const byType = (await db.execute(raw`
    select trip_type, count(*)::int as n from trips
     where deleted_at is null and status = 'completed'
     group by trip_type order by n desc
  `)) as unknown as Array<{ trip_type: string; n: number }>;

  const byMonth = (await db.execute(raw`
    select to_char(date_trunc('month', completed_at at time zone 'America/Toronto'), 'YYYY-MM') as month, count(*)::int as n
      from trips
     where deleted_at is null and status = 'completed'
       and completed_at >= date_trunc('month', now() at time zone 'America/Toronto') - interval '11 months'
     group by 1 order by 1
  `)) as unknown as Array<{ month: string; n: number }>;

  const t = totals ?? {};
  return {
    totals: {
      completed: Number(t.completed ?? 0),
      completedThisMonth: Number(t.completed_this_month ?? 0),
      completedThisYear: Number(t.completed_this_year ?? 0),
      upcoming: Number(t.upcoming ?? 0),
      volunteersAllTime: Number(t.volunteers_all_time ?? 0),
      volunteersLast30Days: Number(t.volunteers_last_30_days ?? 0),
      peopleHelped: Number(t.people_helped ?? 0),
      since: (t.first_at as string | null) ?? null,
    },
    byType: byType.map((r) => ({ tripType: r.trip_type, count: r.n })),
    byMonth: byMonth.map((r) => ({ month: r.month, count: r.n })),
  };
}

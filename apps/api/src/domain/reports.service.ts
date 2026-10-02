import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { TRIP_TYPE_DEPARTMENT } from '../lib/departments.js';
import { addDaysToDateString, daysBetween, localDateString } from '../lib/time.js';

/**
 * Reports (item 8). Every number is computed in the database from the date
 * range asked for, in Montreal days, and test rides are always left out (as
 * the impact totals already do). Aggregates only: no names, phone numbers or
 * addresses, except the overdue-equipment list, which shows the borrower's
 * name to admins only.
 */

export interface Range { from: string; to: string }

const MAX_DAYS = 731;

/** Defaults to the last 30 days; refuses a range that is backwards or huge. */
export function resolveRange(from?: string, to?: string): Range {
  const today = localDateString(new Date());
  const end = to ?? today;
  const start = from ?? addDaysToDateString(end, -29);
  if (start > end) throw Errors.validation('The start date is after the end date.');
  if (daysBetween(start, end) > MAX_DAYS) throw Errors.validation('Choose at most two years at a time.');
  return { from: start, to: end };
}

export async function departmentTotals(r: Range) {
  const byType = await db.execute<{ trip_type: string; completed: number; cancelled: number; requested: number; volunteers: number; people: number }>(raw`
    select trip_type,
           count(*) filter (where status = 'completed')::int as completed,
           count(*) filter (where status = 'cancelled')::int as cancelled,
           count(*)::int as requested,
           count(distinct assigned_volunteer_id) filter (where status = 'completed')::int as volunteers,
           count(distinct coalesce(caller_id::text, caller_phone)) filter (where status = 'completed')::int as people
      from trips
     where is_test = false and deleted_at is null
       and pickup_at >= (${r.from}::date)::timestamp at time zone 'America/Toronto'
       and pickup_at < (${r.to}::date + 1)::timestamp at time zone 'America/Toronto'
     group by trip_type order by trip_type`);
  const dept = (t: string) => TRIP_TYPE_DEPARTMENT[t] ?? 'rides';
  const totals: Record<string, { completed: number; cancelled: number; requested: number; volunteers: number; people: number }> = {};
  for (const row of byType) {
    const d = dept(row.trip_type);
    const cur = totals[d] ?? { completed: 0, cancelled: 0, requested: 0, volunteers: 0, people: 0 };
    cur.completed += Number(row.completed); cur.cancelled += Number(row.cancelled); cur.requested += Number(row.requested);
    cur.volunteers += Number(row.volunteers); cur.people += Number(row.people);
    totals[d] = cur;
  }
  const loans = await db.execute<{ out: number; returned: number }>(raw`
    select count(*) filter (where loaned_at >= (${r.from}::date)::timestamp at time zone 'America/Toronto'
                              and loaned_at < (${r.to}::date + 1)::timestamp at time zone 'America/Toronto')::int as out,
           count(*) filter (where returned_at >= (${r.from}::date)::timestamp at time zone 'America/Toronto'
                              and returned_at < (${r.to}::date + 1)::timestamp at time zone 'America/Toronto')::int as returned
      from equipment_loans`);
  const runs = await db.execute<{ runs: number; recipients: number }>(raw`
    select count(*)::int as runs, coalesce(sum(recipients_count), 0)::int as recipients
      from food_distribution_runs where status = 'done' and run_date between ${r.from}::date and ${r.to}::date`).catch(() => [{ runs: 0, recipients: 0 }]);
  return {
    range: r,
    departments: totals,
    equipmentLoans: { loaned: Number(loans[0]?.out ?? 0), returned: Number(loans[0]?.returned ?? 0) },
    foodRuns: { runs: Number(runs[0]?.runs ?? 0), recipients: Number(runs[0]?.recipients ?? 0) },
  };
}

export type Interval = 'day' | 'week' | 'month';

/** Completed rides per period and department, every period present (zeros
 *  included) so a chart never skips a quiet week. */
export async function trends(r: Range, interval: Interval) {
  const rows = await db.execute<{ period: string; trip_type: string; n: number }>(raw`
    with periods as (
      select generate_series(date_trunc(${interval}, ${r.from}::date), date_trunc(${interval}, ${r.to}::date), ('1 ' || ${interval})::interval)::date as period
    )
    select to_char(p.period, 'YYYY-MM-DD') as period, coalesce(t.trip_type, '') as trip_type, count(t.id)::int as n
      from periods p
      left join trips t
        on t.is_test = false and t.deleted_at is null and t.status = 'completed'
       and date_trunc(${interval}, (t.completed_at at time zone 'America/Toronto'))::date = p.period
       and t.completed_at >= (${r.from}::date)::timestamp at time zone 'America/Toronto'
       and t.completed_at < (${r.to}::date + 1)::timestamp at time zone 'America/Toronto'
     group by p.period, t.trip_type order by p.period`);
  type Counts = { rides: number; food: number; equipment: number };
  const map = new Map<string, Counts>();
  for (const row of rows) {
    const cur: Counts = map.get(row.period) ?? { rides: 0, food: 0, equipment: 0 };
    if (row.trip_type) {
      const d = TRIP_TYPE_DEPARTMENT[row.trip_type] ?? 'rides';
      if (d === 'rides' || d === 'food' || d === 'equipment') cur[d] += Number(row.n);
    }
    map.set(row.period, cur);
  }
  return { range: r, interval, periods: [...map.entries()].map(([period, counts]) => ({ period, ...counts })) };
}

/** How well the work was staffed. */
export async function staffing(r: Range) {
  const [rides] = await db.execute<{ total: number; covered: number; median_minutes: number | null; unfilled: number }>(raw`
    select count(*)::int as total,
           count(*) filter (where assigned_at is not null)::int as covered,
           percentile_cont(0.5) within group (order by extract(epoch from (assigned_at - created_at)) / 60)
             filter (where assigned_at is not null) as median_minutes,
           count(*) filter (where assigned_at is null and status in ('expired', 'cancelled'))::int as unfilled
      from trips
     where is_test = false and deleted_at is null
       and pickup_at >= (${r.from}::date)::timestamp at time zone 'America/Toronto'
       and pickup_at < (${r.to}::date + 1)::timestamp at time zone 'America/Toronto'`);
  const [duty] = await db.execute<{ hours: number; people: number }>(raw`
    select coalesce(sum(extract(epoch from (least(ends_at, (${r.to}::date + 1)::timestamp at time zone 'America/Toronto')
                                         - greatest(starts_at, (${r.from}::date)::timestamp at time zone 'America/Toronto'))) / 3600), 0)::float as hours,
           count(distinct user_id)::int as people
      from duty_shifts
     where deleted_at is null and kind = 'phone'
       and ends_at > (${r.from}::date)::timestamp at time zone 'America/Toronto'
       and starts_at < (${r.to}::date + 1)::timestamp at time zone 'America/Toronto'`);
  const kitchen = await db.execute<{ needed: number; filled: number }>(raw`
    with days as (select generate_series(${r.from}::date, ${r.to}::date, '1 day')::date as d),
    occ as (
      select s.id, d.d, s.staff_needed from food_prep_slots s join days d on extract(dow from d.d) = s.weekday where s.active
    )
    select coalesce(sum(staff_needed), 0)::int as needed,
           coalesce(sum(least(staff_needed, (select count(*) from food_prep_signups g where g.slot_id = occ.id and g.on_date = occ.d))), 0)::int as filled
      from occ`).catch(() => [{ needed: 0, filled: 0 }]);
  const total = Number(rides?.total ?? 0);
  const rangeHours = (daysBetween(r.from, r.to) + 1) * 24;
  return {
    range: r,
    rides: {
      total,
      covered: Number(rides?.covered ?? 0),
      coveredPercent: total ? Math.round((Number(rides?.covered ?? 0) / total) * 100) : null,
      unfilled: Number(rides?.unfilled ?? 0),
      medianMinutesToDriver: rides?.median_minutes === null || rides?.median_minutes === undefined ? null : Math.round(Number(rides.median_minutes)),
    },
    phoneDuty: {
      hoursCovered: Math.round(Number(duty?.hours ?? 0) * 10) / 10,
      percentOfHours: Math.round((Number(duty?.hours ?? 0) / rangeHours) * 100),
      people: Number(duty?.people ?? 0),
    },
    kitchen: { placesNeeded: Number(kitchen[0]?.needed ?? 0), placesFilled: Number(kitchen[0]?.filled ?? 0) },
  };
}

/** Equipment now, plus loans overdue. Borrower names only for admins. */
export async function equipmentStatus(showNames: boolean) {
  const byStatus = await db.execute<{ status: string; n: number }>(raw`
    select status, count(*)::int as n from equipment where deleted_at is null group by status order by status`);
  const overdue = await db.execute<{ item_code: string | null; equipment_type: string; days: number; borrower_name: string }>(raw`
    select e.item_code, e.equipment_type, (current_date - (l.expected_return_at at time zone 'America/Toronto')::date)::int as days, l.borrower_name
      from equipment_loans l join equipment e on e.id = l.equipment_id
     where l.returned_at is null and l.expected_return_at < now()
     order by l.expected_return_at`);
  return {
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, Number(s.n)])),
    overdue: overdue.map((o) => ({
      itemCode: o.item_code, type: o.equipment_type, daysOverdue: Number(o.days),
      ...(showNames ? { borrower: o.borrower_name } : {}),
    })),
  };
}

// --- CSV ------------------------------------------------------------------------------

const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  // Quote when needed; neutralise spreadsheet formulas.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const toCsv = (header: string[], rows: unknown[][]): string =>
  [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

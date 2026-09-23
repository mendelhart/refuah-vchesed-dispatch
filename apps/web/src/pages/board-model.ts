/**
 * The Board's pure logic: which tabs exist and what each asks the server for,
 * how rides are ordered and grouped, and which rest period (Shabbos, Yom Tov)
 * a pickup falls in. No React, so it can be unit-tested directly.
 */
import type { TripDto, TripStatus } from '@rvc/shared';
import type { TripListParams } from '@/lib/query';
import { priorityRank } from '@/lib/format';

export interface Segment {
  id: string;
  label: string;
  status?: readonly TripStatus[];
  history?: boolean;
  todayOnly?: boolean;
  empty: { title: string; hint?: string };
}

export interface RestPeriod {
  startsAt: string;
  endsAt: string;
  label: string;
  kind: string;
}

export const SEGMENTS: Segment[] = [
  {
    id: 'needs-driver',
    label: 'Need driver',
    status: ['new', 'pending', 'expired'],
    empty: { title: 'Every ride has a driver right now.', hint: 'New requests will appear here the moment they come in.' },
  },
  {
    id: 'offered',
    label: 'Offered',
    status: ['offered'],
    empty: { title: 'Nothing is out with volunteers right now.', hint: 'Offer a ride from the "Needs driver" tab to start the clock.' },
  },
  {
    id: 'assigned',
    label: 'Assigned',
    status: ['assigned', 'accepted'],
    empty: { title: 'No rides are waiting to start.', hint: 'Accepted rides land here until the volunteer sets off.' },
  },
  {
    id: 'in-progress',
    label: 'Active',
    status: ['en_route', 'in_progress'],
    empty: { title: 'Nobody is on the road at the moment.' },
  },
  {
    id: 'today',
    label: 'Today',
    todayOnly: true,
    empty: { title: 'Nothing else is scheduled for today.' },
  },
  {
    id: 'completed',
    label: 'Completed',
    status: ['completed'],
    history: true,
    empty: { title: 'No completed rides yet.', hint: 'Rides land here when the volunteer marks one done.' },
  },
  {
    id: 'all',
    label: 'All',
    empty: { title: 'The board is clear.', hint: 'Every open ride is handled.' },
  },
];


/** Local midnight to 23:59:59.999 of the given day, as ISO strings. */
export function dayBounds(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function boardListParams(segment: Segment, search: string, now: Date = new Date()): TripListParams {
  const bounds = segment.todayOnly ? dayBounds(now) : null;
  return {
    scope: segment.history ? ('history' as const) : ('board' as const),
    ...(segment.status ? { status: segment.status } : {}),
    ...(search ? { search } : {}),
    ...(bounds ? { from: bounds.from, to: bounds.to } : {}),
    limit: 100,
  };
}

/** Overdue first, then by urgency, then by pickup time. */
export function groupBoardTrips(items: TripDto[]) {
  const sorted = [...items].sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return new Date(a.pickupAt).getTime() - new Date(b.pickupAt).getTime();
  });
  return {
    all: sorted,
    needsAttention: sorted.filter((trip) => trip.isOverdue || trip.priority === 'emergency'),
    urgent: sorted.filter((trip) => !trip.isOverdue && trip.priority === 'urgent'),
    scheduled: sorted.filter((trip) => !trip.isOverdue && trip.priority === 'routine'),
    total: sorted.length,
  };
}

export function findRestPeriod(periods: RestPeriod[], pickupAt: string): RestPeriod | null {
  const at = new Date(pickupAt).getTime();
  if (Number.isNaN(at)) return null;
  return (
    periods.find((period) => at >= new Date(period.startsAt).getTime() && at <= new Date(period.endsAt).getTime()) ??
    null
  );
}

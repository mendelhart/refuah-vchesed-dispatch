/**
 * Role-aware home. A dispatcher lands on the state of the board; a volunteer
 * lands on what is being asked of them right now.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Car, LayoutDashboard } from 'lucide-react';
import type { OfferedTripDto } from '@rvc/shared';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { formatDateTime, relativeTime } from '@/lib/format';
import { isFullTrip, type BoardSummaryResponse, type ImpactResponse, type TripListResponse } from '@/types/api';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, primaryButtonClass } from '@/components/states';

function DispatcherHome(): React.JSX.Element {
  const summary = useQuery({
    queryKey: qk.trips.summary(),
    queryFn: () => api.get<BoardSummaryResponse>('/api/trips/summary'),
  });
  const impact = useQuery({
    queryKey: qk.me.impact(),
    queryFn: () => api.get<ImpactResponse>('/api/me/impact'),
  });

  if (summary.isPending) return <ListSkeleton rows={2} lines={2} />;
  if (summary.isError) {
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} what="the board summary" />;
  }

  const stats = summary.data;
  const tiles = [
    { label: 'Needs attention', value: stats.needsAttention, accent: true },
    { label: 'Overdue', value: stats.overdue, accent: true },
    { label: 'Unanswered offers', value: stats.unanswered, accent: stats.unanswered > 0 },
    { label: 'Offered', value: stats.offered, accent: false },
    { label: 'Assigned', value: stats.assigned, accent: false },
    { label: 'In progress', value: stats.inProgress, accent: false },
  ];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map((tile) => (
          <div key={tile.label} className={`${cardClass} p-4`}>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{tile.label}</p>
            <p className={`mt-1 text-3xl font-bold ${tile.accent ? 'text-[#EA0029]' : 'text-slate-900 dark:text-white'}`}>
              {tile.value}
            </p>
          </div>
        ))}
      </div>
      <Link to="/board" className={primaryButtonClass}>
        <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
        Open the dispatch board
      </Link>
      <section className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-4`}>
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Your stats</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {impact.data
              ? `${impact.data.totals.completed} rides you drove · ${impact.data.totals.completedThisMonth} this month`
              : 'Loading…'}
          </p>
        </div>
        <Link to="/impact" className="inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-[#EA0029] hover:underline">
          Organization impact
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </section>
    </>
  );
}

function VolunteerHome(): React.JSX.Element {
  const available = useQuery({
    queryKey: qk.trips.list({ scope: 'available', limit: 10 }),
    queryFn: () => api.get<TripListResponse>('/api/trips', { scope: 'available', limit: 10 }),
  });
  const mine = useQuery({
    queryKey: qk.trips.list({ scope: 'mine', limit: 10 }),
    queryFn: () => api.get<TripListResponse>('/api/trips', { scope: 'mine', limit: 10 }),
  });
  const impact = useQuery({
    queryKey: qk.me.impact(),
    queryFn: () => api.get<ImpactResponse>('/api/me/impact'),
  });

  const offers = (available.data?.items ?? []).filter((trip): trip is OfferedTripDto => !isFullTrip(trip));
  const next = (mine.data?.items ?? [])
    .filter(isFullTrip)
    .filter((trip) => !['completed', 'cancelled'].includes(trip.status))
    .sort((a, b) => new Date(a.pickupAt).getTime() - new Date(b.pickupAt).getTime())[0];

  return (
    <div className="space-y-6">
      <section className={cardClass}>
        <div className="p-5 md:p-6">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Your next ride</h2>
          {mine.isPending ? (
            <ListSkeleton rows={1} lines={2} />
          ) : mine.isError ? (
            <ErrorState error={mine.error} onRetry={() => void mine.refetch()} what="your rides" />
          ) : next ? (
            <Link to={`/trips/${next.id}`} className="mt-3 block rounded-lg bg-slate-50 p-4 hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800">
              <p className="font-semibold text-slate-900 dark:text-white">{next.callerName ?? next.reference}</p>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {next.pickup.line1} → {next.dropoff.line1}
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {formatDateTime(next.pickupAt)} ({relativeTime(next.pickupAt)})
              </p>
            </Link>
          ) : (
            <EmptyState icon={Car} title="Nothing booked in right now." hint="If a ride comes up nearby, we'll send it to you." />
          )}
        </div>
      </section>

      <section className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 md:p-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              {available.isPending
                ? 'Checking for open offers…'
                : offers.length === 0
                  ? "No open rides right now — we'll let you know."
                  : `${offers.length} ride${offers.length === 1 ? '' : 's'} waiting for an answer`}
            </h2>
            {impact.data ? (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                {impact.data.totals.completed} completed · {impact.data.totals.completedThisMonth} this month
              </p>
            ) : null}
          </div>
          <Link to="/my-trips" className={primaryButtonClass}>
            See my rides
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </section>
    </div>
  );
}

export function HomePage(): React.JSX.Element {
  const { user } = useAuth();
  const isDispatch = user?.role === 'dispatcher' || user?.role === 'admin';
  const firstName = user?.fullName.split(' ')[0] ?? '';

  return (
    <div className="space-y-6">
      <PageHeader
        title={firstName ? `Hello, ${firstName}` : 'Hello'}
        subtitle={isDispatch ? 'Where the board stands right now' : 'Thank you for driving'}
      />
      {isDispatch ? <DispatcherHome /> : <VolunteerHome />}
    </div>
  );
}

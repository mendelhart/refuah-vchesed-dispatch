/**
 * My impact.
 *
 * Honest counts and a ledger of real rides. No leaderboard, no streak, no
 * badge: ranking volunteers against each other is the wrong incentive for a
 * chesed organisation, and a streak punishes the person who takes a month off.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, CalendarClock, HeartHandshake } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDate, formatMonthYear, statusClass, statusLabel, titleCase } from '@/lib/format';
import type { TripStatus } from '@rvc/shared';
import type { ImpactResponse } from '@/types/api';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass } from '@/components/states';

export function ImpactPage(): React.JSX.Element {
  const impact = useQuery({
    queryKey: qk.me.impact(),
    queryFn: () => api.get<ImpactResponse>('/api/me/impact'),
  });

  if (impact.isPending) return <ListSkeleton rows={3} lines={2} />;
  if (impact.isError) {
    return <ErrorState error={impact.error} onRetry={() => void impact.refetch()} what="your record" />;
  }

  const { totals, trips } = impact.data;

  const tiles = [
    { label: 'Rides completed', value: totals.completed, icon: HeartHandshake },
    { label: 'This month', value: totals.completedThisMonth, icon: CalendarCheck },
    { label: 'Coming up', value: totals.upcoming, icon: CalendarClock },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="My impact"
        subtitle={
          totals.volunteeringSince
            ? `Driving with Refuah V'Chesed since ${formatMonthYear(totals.volunteeringSince)}`
            : 'Your record so far'
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <div key={tile.label} className={`${cardClass} p-6`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-600 dark:text-slate-400">{tile.label}</p>
                  <p className="mt-2 text-3xl font-bold text-slate-900 dark:text-white">{tile.value}</p>
                </div>
                <span className="rounded-xl bg-red-50 p-3 text-[#E31E24] dark:bg-red-950/40">
                  <Icon className="h-7 w-7" aria-hidden="true" />
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <section className={cardClass}>
        <div className="p-5 md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">Your rides</h2>
          {trips.length === 0 ? (
            <EmptyState
              title="No rides on your record yet."
              hint="Once you accept and finish a ride it shows up here."
            />
          ) : (
            <ul className="space-y-2">
              {trips.map((trip) => (
                <li key={trip.id}>
                  <Link
                    to={`/trips/${trip.id}`}
                    className="flex min-h-[44px] flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-4 py-3 text-sm hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900 dark:text-white">
                        {titleCase(trip.tripType)} to {trip.city}
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {trip.completedAt ? `Completed ${formatDate(trip.completedAt)}` : `Scheduled ${formatDate(trip.pickupAt)}`}
                        {' · '}
                        {trip.reference}
                      </span>
                    </span>
                    <span className={`rounded-full px-2 py-1 text-xs ${statusClass(trip.status as TripStatus)}`}>
                      {statusLabel(trip.status as TripStatus)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

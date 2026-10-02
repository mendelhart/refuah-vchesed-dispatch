/**
 * Organization impact.
 *
 * What Refuah V'Chesed volunteers have done together. Counts only: no
 * leaderboard and no ranking of individual volunteers.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, CalendarClock, CalendarRange, HeartHandshake, UserCheck, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatMonthYear, titleCase } from '@/lib/format';
import type { OrgImpactResponse } from '@/types/api';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass } from '@/components/states';

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString('en-CA', { month: 'short', year: '2-digit' });
}

export function ImpactPage(): React.JSX.Element {
  const impact = useQuery({
    queryKey: qk.me.orgImpact(),
    queryFn: () => api.get<OrgImpactResponse>('/api/impact'),
  });

  if (impact.isPending) return <ListSkeleton rows={3} lines={2} />;
  if (impact.isError) {
    return <ErrorState error={impact.error} onRetry={() => void impact.refetch()} what="the organization's record" />;
  }

  const { totals, byType, byMonth } = impact.data;
  const tiles = [
    { label: 'Rides completed', value: totals.completed, icon: HeartHandshake },
    { label: 'This month', value: totals.completedThisMonth, icon: CalendarCheck },
    { label: 'This year', value: totals.completedThisYear, icon: CalendarRange },
    { label: 'Coming up', value: totals.upcoming, icon: CalendarClock },
    { label: 'People helped', value: totals.peopleHelped, icon: Users },
    { label: 'Volunteers who drove', value: totals.volunteersAllTime, icon: UserCheck, sub: `${totals.volunteersLast30Days} in the last 30 days` },
  ];
  const max = Math.max(1, ...byMonth.map((m) => m.count));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organization impact"
        subtitle={totals.since ? `Everything our volunteers have done together since ${formatMonthYear(totals.since)}` : 'Everything our volunteers have done together'}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map((tile) => {
          const Icon = tile.icon;
          return (
            <div key={tile.label} className={`${cardClass} p-4`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-600 dark:text-slate-400">{tile.label}</p>
                  <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{tile.value}</p>
                  {tile.sub ? <p className="text-xs text-slate-500 dark:text-slate-400">{tile.sub}</p> : null}
                </div>
                <Icon className="h-6 w-6 flex-shrink-0 text-[#C80023] dark:text-red-400" aria-hidden="true" />
              </div>
            </div>
          );
        })}
      </div>

      <section className={cardClass}>
        <div className="p-5 md:p-6">
          <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">Rides per month</h2>
          {byMonth.length === 0 ? (
            <EmptyState title="No completed rides yet." hint="Completed rides show up here month by month." />
          ) : (
            <ul className="space-y-2">
              {byMonth.map((m) => (
                <li key={m.month} className="flex items-center gap-3 text-sm">
                  <span className="w-16 flex-shrink-0 text-slate-600 dark:text-slate-400">{monthLabel(m.month)}</span>
                  <span className="h-3 rounded bg-[#EA0029]" style={{ width: `${Math.max(4, (m.count / max) * 100)}%` }} />
                  <span className="font-medium text-slate-900 dark:text-white">{m.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {byType.length > 0 ? (
        <section className={cardClass}>
          <div className="p-5 md:p-6">
            <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-white">By kind of help</h2>
            <ul className="space-y-1 text-sm">
              {byType.map((t) => (
                <li key={t.tripType} className="flex justify-between">
                  <span className="text-slate-700 dark:text-slate-300">{titleCase(t.tripType)}</span>
                  <span className="font-medium text-slate-900 dark:text-white">{t.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </div>
  );
}

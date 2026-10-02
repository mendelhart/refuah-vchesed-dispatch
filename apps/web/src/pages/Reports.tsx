/**
 * Reports (item 8). Phone first: headline numbers as tiles, one small bar
 * chart per department (one series each, so no colour legend is needed and
 * nothing depends on telling colours apart), every chart with a table view,
 * and CSV downloads. All figures come from the server for the chosen dates;
 * test rides are left out there.
 */
import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '@/lib/api';
import { ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, secondaryButtonClass } from '@/components/states';
import { dayLabel } from './food-model';
import { barGeometry, defaultRange, periodLabel, type Interval } from './reports-model';

type Dept = { completed: number; cancelled: number; requested: number; volunteers: number; people: number };
interface Summary { departments: Record<string, Dept>; equipmentLoans: { loaned: number; returned: number }; foodRuns: { runs: number; recipients: number } }
interface Trends { periods: Array<{ period: string; rides: number; food: number; equipment: number }> }
interface Staffing {
  rides: { total: number; covered: number; coveredPercent: number | null; unfilled: number; medianMinutesToDriver: number | null };
  phoneDuty: { hoursCovered: number; percentOfHours: number; people: number };
  kitchen: { placesNeeded: number; placesFilled: number };
}
interface Equipment { byStatus: Record<string, number>; overdue: Array<{ itemCode: string | null; type: string; daysOverdue: number; borrower?: string }> }

const DEPTS: Array<{ id: 'rides' | 'food' | 'equipment'; label: string }> = [
  { id: 'rides', label: 'Rides' },
  { id: 'food', label: 'Food' },
  { id: 'equipment', label: 'Equipment' },
];

function Tile({ label, value, note }: { label: string; value: string; note?: string }): React.JSX.Element {
  return (
    <div className={`${cardClass} p-4`}>
      <p className="text-sm text-slate-600 dark:text-slate-300">{label}</p>
      <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">{value}</p>
      {note ? <p className="text-sm text-slate-600 dark:text-slate-300">{note}</p> : null}
    </div>
  );
}

/** One series: completed per period. Bars rise from a shared baseline;
 *  each bar names its own value for screen readers and on hover. */
function BarChart({ title, points, interval }: { title: string; points: Array<{ period: string; value: number }>; interval: Interval }): React.JSX.Element {
  const [showTable, setShowTable] = useState(false);
  const geo = barGeometry(points.map((p) => p.value), 300, 120);
  return (
    <figure className={`${cardClass} p-4`}>
      <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-slate-900 dark:text-white">{title}</span>
        <button type="button" className="min-h-[44px] text-sm font-medium text-[#C80023] underline dark:text-red-400" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Show chart' : 'Show as a table'}
        </button>
      </figcaption>
      {showTable ? (
        <table className="w-full text-sm text-slate-800 dark:text-slate-100">
          <thead><tr><th className="py-1 text-start font-medium">Period</th><th className="py-1 text-end font-medium">Completed</th></tr></thead>
          <tbody>{points.map((p) => <tr key={p.period}><td className="py-1">{periodLabel(p.period, interval)}</td><td className="py-1 text-end tabular-nums">{p.value}</td></tr>)}</tbody>
        </table>
      ) : geo.max === 0 ? (
        <p className="py-6 text-sm text-slate-600 dark:text-slate-300">Nothing completed in these dates.</p>
      ) : (
        <svg viewBox="0 0 300 140" className="h-auto w-full" role="img" aria-label={`${title}: ${points.map((p) => `${periodLabel(p.period, interval)} ${p.value}`).join(', ')}`}>
          <line x1="0" x2="300" y1="120.5" y2="120.5" className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1" />
          {geo.bars.map((b, i) => (
            <g key={points[i]!.period}>
              <title>{`${periodLabel(points[i]!.period, interval)}: ${points[i]!.value}`}</title>
              <rect x={b.x} y={b.y} width={b.width} height={Math.max(b.height, 0)} rx="2" className="fill-slate-600 dark:fill-slate-300" />
              {/* hit area taller than the bar */}
              <rect x={b.x} y={0} width={b.width} height={120} fill="transparent" />
            </g>
          ))}
          <text x="0" y="136" className="fill-slate-600 text-[10px] dark:fill-slate-300">{points[0] ? periodLabel(points[0].period, interval) : ''}</text>
          <text x="300" y="136" textAnchor="end" className="fill-slate-600 text-[10px] dark:fill-slate-300">{points.length ? periodLabel(points[points.length - 1]!.period, interval) : ''}</text>
          <text x="0" y="10" className="fill-slate-600 text-[10px] dark:fill-slate-300">{`max ${geo.max}`}</text>
        </svg>
      )}
    </figure>
  );
}

export function ReportsPage(): React.JSX.Element {
  const initial = useMemo(() => defaultRange(new Date()), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [interval, setIntervalChoice] = useState<Interval>('week');
  const params = { from, to };
  const summary = useQuery({ queryKey: ['reports', 'summary', from, to], queryFn: () => api.get<Summary>('/api/reports/summary', params) });
  const trends = useQuery({ queryKey: ['reports', 'trends', from, to, interval], queryFn: () => api.get<Trends>('/api/reports/trends', { ...params, interval }) });
  const staffing = useQuery({ queryKey: ['reports', 'staffing', from, to], queryFn: () => api.get<Staffing>('/api/reports/staffing', params) });
  const equipment = useQuery({ queryKey: ['reports', 'equipment'], queryFn: () => api.get<Equipment>('/api/reports/equipment') });
  const csvHref = (report: string) => `/api/reports/export.csv?report=${report}&from=${from}&to=${to}&interval=${interval}`;
  const s = summary.data;
  const st = staffing.data;

  return (
    <div className="space-y-4">
      <PageHeader title="Reports" subtitle={`${dayLabel(from)} to ${dayLabel(to)}`} />

      <form className={`${cardClass} grid gap-3 p-4 sm:grid-cols-3 [&>*]:min-w-0`} onSubmit={(e) => e.preventDefault()} aria-label="Dates">
        <div><label htmlFor="rep-from" className={labelClass}>From</label><input id="rep-from" type="date" className={inputClass} value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></div>
        <div><label htmlFor="rep-to" className={labelClass}>To</label><input id="rep-to" type="date" className={inputClass} value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></div>
        <div>
          <label htmlFor="rep-interval" className={labelClass}>Group by</label>
          <select id="rep-interval" className={inputClass} value={interval} onChange={(e) => setIntervalChoice(e.target.value as Interval)}>
            <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
          </select>
        </div>
      </form>

      {summary.isError ? <ErrorState error={summary.error} onRetry={() => void summary.refetch()} what="the totals" /> : null}
      {summary.isPending ? <ListSkeleton rows={1} lines={3} /> : null}
      {s ? (
        <section aria-labelledby="rep-totals">
          <h2 id="rep-totals" className="mb-2 text-base font-semibold text-slate-900 dark:text-white">Totals</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {DEPTS.map((d) => (
              <Tile key={d.id} label={`${d.label} completed`} value={String(s.departments[d.id]?.completed ?? 0)}
                note={`${s.departments[d.id]?.cancelled ?? 0} cancelled · ${s.departments[d.id]?.volunteers ?? 0} volunteers`} />
            ))}
            <Tile label="People helped" value={String(Object.values(s.departments).reduce((n, d) => n + d.people, 0))} />
            <Tile label="Equipment loaned" value={String(s.equipmentLoans.loaned)} note={`${s.equipmentLoans.returned} returned`} />
            <Tile label="Food runs" value={String(s.foodRuns.runs)} note={`${s.foodRuns.recipients} people served`} />
          </div>
        </section>
      ) : null}

      <section aria-labelledby="rep-trends" className="space-y-2">
        <h2 id="rep-trends" className="text-base font-semibold text-slate-900 dark:text-white">Completed over time</h2>
        {trends.isError ? <ErrorState error={trends.error} onRetry={() => void trends.refetch()} what="the trends" /> : null}
        {trends.data ? DEPTS.map((d) => (
          <BarChart key={d.id} title={d.label} interval={interval} points={trends.data.periods.map((p) => ({ period: p.period, value: p[d.id] ?? 0 }))} />
        )) : null}
      </section>

      {st ? (
        <section aria-labelledby="rep-staffing">
          <h2 id="rep-staffing" className="mb-2 text-base font-semibold text-slate-900 dark:text-white">Staffing</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Rides with a driver" value={st.rides.coveredPercent === null ? '–' : `${st.rides.coveredPercent}%`} note={`${st.rides.covered} of ${st.rides.total}`} />
            <Tile label="Never filled" value={String(st.rides.unfilled)} />
            <Tile label="Typical wait for a driver" value={st.rides.medianMinutesToDriver === null ? '–' : `${st.rides.medianMinutesToDriver} min`} />
            <Tile label="Phone duty covered" value={`${st.phoneDuty.percentOfHours}%`} note={`${st.phoneDuty.hoursCovered} h by ${st.phoneDuty.people} people`} />
            <Tile label="Kitchen places filled" value={`${st.kitchen.placesFilled} of ${st.kitchen.placesNeeded}`} />
          </div>
        </section>
      ) : null}

      {equipment.data ? (
        <section aria-labelledby="rep-equipment" className={`${cardClass} p-4`}>
          <h2 id="rep-equipment" className="mb-2 text-base font-semibold text-slate-900 dark:text-white">Equipment now</h2>
          <p className="text-sm text-slate-800 dark:text-slate-100">
            {Object.entries(equipment.data.byStatus).map(([k, v]) => `${v} ${k}`).join(' · ') || 'No equipment recorded.'}
          </p>
          <h3 className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">Overdue ({equipment.data.overdue.length})</h3>
          <ul className="mt-1 space-y-1 text-sm text-slate-800 dark:text-slate-100">
            {equipment.data.overdue.map((o, i) => (
              <li key={i}>{o.itemCode ?? o.type}: {o.daysOverdue} {o.daysOverdue === 1 ? 'day' : 'days'} late{o.borrower ? ` · ${o.borrower}` : ''}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={`${cardClass} flex flex-wrap gap-2 p-4`} aria-label="Downloads">
        {['summary', 'trends', 'staffing'].map((r) => (
          <a key={r} href={csvHref(r)} className={secondaryButtonClass} download>
            <Download className="h-4 w-4" aria-hidden="true" /> {r[0]!.toUpperCase() + r.slice(1)} (CSV)
          </a>
        ))}
      </section>
    </div>
  );
}

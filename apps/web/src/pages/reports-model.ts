/** Pure helpers for the Reports page (unit-tested in test/reports-model.test.ts). */
export type Interval = 'day' | 'week' | 'month';

/** The last 30 days, Montreal dates. */
export function defaultRange(now: Date): { from: string; to: string } {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { from: fmt(new Date(now.getTime() - 29 * 86_400_000)), to: fmt(now) };
}

/** Bars on a shared zero baseline; a 2px gap between neighbours; a tiny stub
 *  for zero so a quiet period is visible but clearly empty. */
export function barGeometry(values: number[], width: number, height: number, gap = 2) {
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length);
  const w = Math.max(1, (width - gap * (n - 1)) / n);
  return {
    max: Math.max(0, ...values),
    bars: values.map((v, i) => {
      const h = v === 0 ? 1 : (v / max) * (height - 12);
      return { x: i * (w + gap), y: height - h, width: w, height: h };
    }),
  };
}

export function periodLabel(period: string, interval: Interval): string {
  const [y, m, d] = period.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!, 12));
  if (interval === 'month') return date.toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

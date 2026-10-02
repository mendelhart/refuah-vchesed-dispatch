import { describe, expect, it } from 'vitest';
import { barGeometry, defaultRange, periodLabel } from '@/pages/reports-model';

describe('reports model', () => {
  it('bars share one baseline, the tallest fills the chart, zeros are a visible stub', () => {
    const g = barGeometry([0, 5, 10], 300, 120);
    expect(g.max).toBe(10);
    for (const b of g.bars) expect(b.y + b.height).toBeCloseTo(120);
    expect(g.bars[2]!.height).toBeCloseTo(108);
    expect(g.bars[0]!.height).toBe(1);
    expect(g.bars[1]!.x - (g.bars[0]!.x + g.bars[0]!.width)).toBeCloseTo(2);
  });

  it('defaults to the last 30 days', () => {
    const r = defaultRange(new Date('2026-10-02T15:00:00Z'));
    expect(r).toEqual({ from: '2026-09-03', to: '2026-10-02' });
  });

  it('labels periods plainly', () => {
    expect(periodLabel('2026-10-01', 'month')).toMatch(/Oct.*2026/);
    expect(periodLabel('2026-09-28', 'week')).toMatch(/Sep.*28/);
  });
});

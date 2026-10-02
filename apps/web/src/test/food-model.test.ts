import { describe, expect, it } from 'vitest';
import { dayLabel, groupByDay, parseShoppingLines, staffingLabel } from '@/pages/food-model';

describe('food model', () => {
  it('groups slot occurrences by day, in order', () => {
    const s = (date: string, startMinute: number) => ({ slotId: 'x', date, title: 't', startMinute, endMinute: startMinute + 60, staffNeeded: 2, signedUp: 0, stillNeeded: 2, iAmSignedUp: false, notes: null, items: [] });
    const g = groupByDay([s('2026-10-07', 600), s('2026-10-06', 900), s('2026-10-06', 480)]);
    expect(g.map((d) => d.date)).toEqual(['2026-10-06', '2026-10-07']);
    expect(g[0]!.slots.map((x) => x.startMinute)).toEqual([480, 900]);
  });

  it('says how staffed a slot is in plain words', () => {
    expect(staffingLabel({ staffNeeded: 3, signedUp: 1, stillNeeded: 2 })).toBe('2 more people needed (1 of 3)');
    expect(staffingLabel({ staffNeeded: 2, signedUp: 1, stillNeeded: 1 })).toBe('1 more person needed (1 of 2)');
    expect(staffingLabel({ staffNeeded: 2, signedUp: 2, stillNeeded: 0 })).toBe('Full: 2 of 2');
  });

  it('names the day without shifting it across time zones', () => {
    expect(dayLabel('2026-10-07')).toMatch(/Wednesday.*7.*October|Wednesday, October 7/);
  });

  it('reads a typed shopping list', () => {
    expect(parseShoppingLines('6 dozen eggs\n10 kg flour\nsalt\n2 challahs\n\n')).toEqual([
      { name: 'eggs', quantity: 6, unit: 'dozen' },
      { name: 'flour', quantity: 10, unit: 'kg' },
      { name: 'salt', quantity: 1, unit: 'each' },
      { name: 'challahs', quantity: 2, unit: 'each' },
    ]);
  });
});

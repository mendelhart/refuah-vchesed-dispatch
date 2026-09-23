import { describe, expect, it } from 'vitest';
import { isRestTime, restPeriodsBetween } from '../lib/hebcal.js';
import { fromLocal } from '../lib/time.js';

/**
 * Spec §15: Shabbos / yom tov boundaries in Montreal. Pure calendar tests, no
 * database. The process timezone is irrelevant: every instant is built from
 * Toronto/Montreal wall-clock time and compared as an absolute instant.
 */
describe('rest period boundaries (Montreal)', () => {
  const periods = restPeriodsBetween(new Date('2026-09-01T00:00:00Z'), new Date('2027-10-31T00:00:00Z'));

  it('finds every Shabbos and yom tov and each one closes', () => {
    expect(periods.length).toBeGreaterThan(55);
    for (const p of periods) {
      const hours = (Date.parse(p.endsAt) - Date.parse(p.startsAt)) / 3_600_000;
      expect(hours).toBeGreaterThan(20);
      expect(hours).toBeLessThan(80); // a 3-day yom tov + Shabbos is the longest
    }
  });

  it('isRestTime agrees with the periods at every half hour, including 3-day yom tov', () => {
    let misses = 0;
    for (const p of periods) {
      for (let t = Date.parse(p.startsAt) + 60_000; t < Date.parse(p.endsAt); t += 30 * 60_000) {
        if (!isRestTime(new Date(t)).resting) misses++;
      }
    }
    expect(misses).toBe(0);
    // Pesach 2027 runs Wednesday night to Saturday night.
    const pesach = periods.find((p) => p.label === 'Pesach' && p.startsAt.startsWith('2027-04'));
    expect(pesach).toBeTruthy();
    expect(isRestTime(new Date(Date.parse(pesach!.endsAt) - 10 * 60_000)).resting).toBe(true);
  });

  it('Friday afternoon before candle lighting is open; just after is rest', () => {
    // Friday Dec 18 2026.
    const p = periods.find((x) => x.startsAt.startsWith('2026-12-18'))!;
    expect(p.kind).toBe('shabbat');
    const start = new Date(p.startsAt);
    expect(isRestTime(fromLocal(2026, 12, 18, 13 * 60)).resting).toBe(false);
    expect(isRestTime(new Date(start.getTime() - 60_000)).resting).toBe(false);
    expect(isRestTime(new Date(start.getTime() + 60_000)).resting).toBe(true);
  });

  it('Saturday night after havdalah is open again', () => {
    const p = periods.find((x) => x.startsAt.startsWith('2026-12-18'))!;
    const end = new Date(p.endsAt);
    expect(isRestTime(new Date(end.getTime() - 60_000)).resting).toBe(true);
    expect(isRestTime(new Date(end.getTime() + 60_000)).resting).toBe(false);
    expect(isRestTime(fromLocal(2026, 12, 19, 22 * 60)).resting).toBe(false);
  });

  it('yom tov starting on a weekday is a rest period of kind yomtov', () => {
    const rh = periods.find((x) => x.label === 'Rosh Hashana' && x.startsAt.startsWith('2027-10'))!;
    expect(rh.kind).toBe('yomtov');
    expect(isRestTime(new Date(Date.parse(rh.startsAt) + 3_600_000)).resting).toBe(true);
  });

  it('fast days are not rest periods (dispatch is allowed)', () => {
    // A weekday fast (Thursday Aug 12 2027, around Tisha B'Av) is a normal dispatch day.
    expect(isRestTime(fromLocal(2027, 8, 12, 12 * 60)).resting).toBe(false);
  });
});

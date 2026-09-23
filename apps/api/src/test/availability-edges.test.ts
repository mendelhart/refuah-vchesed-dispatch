import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { availabilityExceptions, availabilityRules, trips } from '../db/schema.js';
import { evaluateCandidates } from '../domain/targeting.js';
import { fromLocal, localMinuteOfDay, localWeekday } from '../lib/time.js';

/**
 * Spec §12: availability at the edges. Rules are weekly wall-clock windows in
 * the organisation's timezone (America/Toronto, same as Montreal). An overnight
 * shift such as 22:00–02:00 is stored as two windows: 22:00–24:00 on the first
 * day and 00:00–02:00 on the next. Pickup instants below are built from local
 * wall-clock times, so they hold on either side of a DST change.
 */
describe('availability edge cases', () => {
  let dispatcher: TestUser;
  let groupId: string;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher' });
    const res = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    expect(res.status).toBe(201);
    const [trip] = await db.select().from(trips).where(eq(trips.id, (res.body.trip as { id: string }).id));
    groupId = trip!.groupId;
  });

  async function isEligible(userId: string, pickupAt: Date, priority = 'routine'): Promise<boolean> {
    const r = await evaluateCandidates({ groupId, tripType: 'ride', priority, pickupAt, mobilityNeeds: [] });
    return r.eligible.some((c) => c.id === userId);
  }

  async function volunteerWith(windows: Array<[number, number, number]>): Promise<string> {
    const v = await createTestUser({ role: 'volunteer' });
    for (const [weekday, startMinute, endMinute] of windows) {
      await db.insert(availabilityRules).values({ userId: v.id, weekday, startMinute, endMinute });
    }
    return v.id;
  }

  // Sunday Oct 4 2026 and Monday Oct 5 2026 (EDT).
  const SUN = 0;
  const MON = 1;
  const SAT = 6;

  it('reads the weekday and minute in Toronto time, not UTC', () => {
    // 21:30 Sunday local is already Monday 01:30 UTC.
    const t = fromLocal(2026, 10, 4, 21 * 60 + 30);
    expect(t.toISOString()).toBe('2026-10-05T01:30:00.000Z');
    expect(localWeekday(t)).toBe(SUN);
    expect(localMinuteOfDay(t)).toBe(21 * 60 + 30);
  });

  it('a window ending at midnight (1440) covers 23:59 but not 00:00 next day', async () => {
    const v = await volunteerWith([[SUN, 20 * 60, 1440]]);
    expect(await isEligible(v, fromLocal(2026, 10, 4, 23 * 60 + 59))).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 5, 0))).toBe(false);
  });

  it('a window starting at 00:00 covers midnight exactly', async () => {
    const v = await volunteerWith([[MON, 0, 60]]);
    expect(await isEligible(v, fromLocal(2026, 10, 5, 0))).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 5, 60))).toBe(false); // end is exclusive
  });

  it('overnight Sunday 22:00 to Monday 02:00, stored as two windows, is continuous', async () => {
    const v = await volunteerWith([[SUN, 22 * 60, 1440], [MON, 0, 2 * 60]]);
    expect(await isEligible(v, fromLocal(2026, 10, 4, 21 * 60 + 59))).toBe(false);
    expect(await isEligible(v, fromLocal(2026, 10, 4, 22 * 60))).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 4, 23 * 60 + 59))).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 5, 0))).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 5, 90))).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 5, 120))).toBe(false);
  });

  it('Saturday night into Sunday wraps weekday 6 to 0', async () => {
    const v = await volunteerWith([[SAT, 23 * 60, 1440], [SUN, 0, 60]]);
    expect(await isEligible(v, fromLocal(2026, 10, 3, 23 * 60 + 30))).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 4, 30))).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 4, 90))).toBe(false);
  });

  it('keeps the wall-clock window across the November DST change', async () => {
    // Nov 1 2026 is a Sunday; clocks fall back at 02:00. A Sunday 09:00-10:00
    // window must still mean 09:00 local (now EST, UTC-5).
    const v = await volunteerWith([[SUN, 9 * 60, 10 * 60]]);
    const t = fromLocal(2026, 11, 1, 9 * 60 + 15);
    expect(t.toISOString()).toBe('2026-11-01T14:15:00.000Z');
    expect(await isEligible(v, t)).toBe(true);
    expect(await isEligible(v, fromLocal(2026, 10, 25, 9 * 60 + 15))).toBe(true); // week before, EDT
    expect(await isEligible(v, fromLocal(2026, 11, 1, 10 * 60 + 15))).toBe(false);
  });

  it('keeps the wall-clock window across the March DST change', async () => {
    // Mar 14 2027 is a Sunday; clocks spring forward at 02:00.
    const v = await volunteerWith([[SUN, 7 * 60, 8 * 60]]);
    const t = fromLocal(2027, 3, 14, 7 * 60 + 30);
    expect(t.toISOString()).toBe('2027-03-14T11:30:00.000Z');
    expect(await isEligible(v, t)).toBe(true);
  });

  it('an unavailable exception beats a weekly window; an available exception opens a closed time', async () => {
    const v = await volunteerWith([[SUN, 9 * 60, 17 * 60]]);
    const noon = fromLocal(2026, 10, 4, 12 * 60);
    await db.insert(availabilityExceptions).values({
      userId: v, kind: 'unavailable',
      startsAt: fromLocal(2026, 10, 4, 11 * 60), endsAt: fromLocal(2026, 10, 4, 13 * 60),
    } as never);
    expect(await isEligible(v, noon)).toBe(false);

    const late = fromLocal(2026, 10, 4, 20 * 60);
    expect(await isEligible(v, late)).toBe(false);
    await db.insert(availabilityExceptions).values({
      userId: v, kind: 'available',
      startsAt: fromLocal(2026, 10, 4, 19 * 60), endsAt: fromLocal(2026, 10, 4, 21 * 60),
    } as never);
    expect(await isEligible(v, late)).toBe(true);
  });

  it('emergency ignores the weekly window; routine does not', async () => {
    const v = await volunteerWith([[MON, 9 * 60, 10 * 60]]);
    const sundayNight = fromLocal(2026, 10, 4, 23 * 60);
    expect(await isEligible(v, sundayNight, 'routine')).toBe(false);
    expect(await isEligible(v, sundayNight, 'emergency')).toBe(true);
  });
});

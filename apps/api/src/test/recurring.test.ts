import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { recurringRideOccurrences, recurringRides, trips } from '../db/schema.js';
import { materialiseDueRides, occursOn, upcomingDates } from '../domain/recurring.service.js';
import { addDaysToDateString, localDateString, weekdayOfDateString } from '../lib/time.js';

describe('standing rides and duplication', () => {
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher' });
    await createTestUser({ role: 'volunteer' });
  });

  const today = () => localDateString(new Date());

  const sampleRecurring = (over: Record<string, unknown> = {}) => ({
    callerName: 'Chana Weiss',
    callerPhone: '514-555-7788',
    pickup: { line1: '5000 Avenue Victoria', city: 'Montreal', province: 'QC' },
    dropoff: { line1: '3755 Chemin de la Côte-Sainte-Catherine', city: 'Montreal', province: 'QC' },
    tripType: 'ride',
    priority: 'routine',
    groupSlug: 'chesed_on_the_go',
    mobilityNeeds: [],
    frequency: 'weekly',
    byWeekday: [0, 1, 2, 3, 4, 5, 6],
    pickupMinute: 9 * 60,
    startDate: today(),
    leadTimeMinutes: 1440,
    ...over,
  });

  // --- schedule arithmetic, tested without touching the database -----------

  it('expands a weekly schedule on the chosen days only', () => {
    const ride = { frequency: 'weekly', byWeekday: [1, 3], byMonthDay: null, startDate: '2026-09-14', endDate: null };
    const dates = upcomingDates(ride, 4, '2026-09-14');
    expect(dates).toEqual(['2026-09-14', '2026-09-16', '2026-09-21', '2026-09-23']);
    expect(dates.every((d) => [1, 3].includes(weekdayOfDateString(d)))).toBe(true);
  });

  it('keeps a fortnightly schedule on the same fortnight', () => {
    const ride = { frequency: 'biweekly', byWeekday: [2], byMonthDay: null, startDate: '2026-09-15', endDate: null };
    const dates = upcomingDates(ride, 3, '2026-09-15');
    expect(dates).toEqual(['2026-09-15', '2026-09-29', '2026-10-13']);
    expect(occursOn(ride, '2026-09-22')).toBe(false);
  });

  it('never schedules a monthly ride on a day some months lack', () => {
    const ride = { frequency: 'monthly', byWeekday: [], byMonthDay: 28, startDate: '2026-01-01', endDate: null };
    const dates = upcomingDates(ride, 3, '2026-01-01');
    expect(dates).toEqual(['2026-01-28', '2026-02-28', '2026-03-28']);
  });

  it('stops at the end date', () => {
    const ride = { frequency: 'weekly', byWeekday: [1], byMonthDay: null, startDate: '2026-09-14', endDate: '2026-09-21' };
    expect(upcomingDates(ride, 10, '2026-09-14')).toEqual(['2026-09-14', '2026-09-21']);
  });

  // --- the API -------------------------------------------------------------

  it('refuses a weekly schedule with no days chosen', async () => {
    const res = await api('POST', '/api/recurring-rides', {
      cookie: dispatcher.cookie,
      payload: sampleRecurring({ byWeekday: [] }),
    });
    expect(res.status).toBe(422);
  });

  it('refuses a monthly schedule beyond the 28th', async () => {
    const res = await api('POST', '/api/recurring-rides', {
      cookie: dispatcher.cookie,
      payload: sampleRecurring({ frequency: 'monthly', byWeekday: [], byMonthDay: 31 }),
    });
    expect(res.status).toBe(422);
  });

  it('materialises occurrences into ordinary trips', async () => {
    const created = await api('POST', '/api/recurring-rides', {
      cookie: dispatcher.cookie,
      payload: sampleRecurring(),
    });
    expect(created.status).toBe(201);
    const rideId = (created.body.ride as { id: string }).id;

    const result = await materialiseDueRides();
    expect(result.created).toBeGreaterThan(0);

    const made = await db.select().from(trips).where(eq(trips.recurringRideId, rideId));
    expect(made.length).toBe(result.created);
    // Every occurrence is a normal trip in the normal starting state.
    expect(made.every((t) => t.status === 'pending' || t.status === 'offered')).toBe(true);
    expect(made.every((t) => t.reference.startsWith('RVC-'))).toBe(true);
    expect(made.every((t) => t.assignedVolunteerId === null)).toBe(true);
  });

  it('never materialises the same date twice, however often it runs', async () => {
    await api('POST', '/api/recurring-rides', { cookie: dispatcher.cookie, payload: sampleRecurring() });

    const first = await materialiseDueRides();
    const second = await materialiseDueRides();
    const third = await materialiseDueRides();

    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
    expect(third.created).toBe(0);

    const occurrences = await db.select().from(recurringRideOccurrences);
    const keys = occurrences.map((o) => `${o.recurringRideId}:${o.occurrenceDate}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('respects the horizon rather than creating a year of trips', async () => {
    await api('POST', '/api/recurring-rides', { cookie: dispatcher.cookie, payload: sampleRecurring() });
    await materialiseDueRides();

    const made = await db.select().from(trips);
    const horizon = addDaysToDateString(today(), 15);
    expect(made.every((t) => localDateString(t.pickupAt) <= horizon)).toBe(true);
    // Daily for a fortnight is at most 15 occurrences.
    expect(made.length).toBeLessThanOrEqual(15);
  });

  it('ends a standing ride and can cancel the trips not yet started', async () => {
    const created = await api('POST', '/api/recurring-rides', {
      cookie: dispatcher.cookie,
      payload: sampleRecurring(),
    });
    const rideId = (created.body.ride as { id: string }).id;
    await materialiseDueRides();

    const before = await db.select().from(trips).where(eq(trips.recurringRideId, rideId));
    expect(before.length).toBeGreaterThan(0);

    const ended = await api('POST', `/api/recurring-rides/${rideId}/end`, {
      cookie: dispatcher.cookie,
      payload: { reason: 'Course of treatment finished', cancelFuture: true },
    });
    expect(ended.status).toBe(200);
    expect(ended.body.cancelled).toBeGreaterThan(0);

    const [ride] = await db.select().from(recurringRides).where(eq(recurringRides.id, rideId));
    expect(ride!.status).toBe('ended');

    const after = await db
      .select()
      .from(trips)
      .where(and(eq(trips.recurringRideId, rideId), raw`${trips.pickupAt} > now()`));
    expect(after.every((t) => t.status === 'cancelled')).toBe(true);
  });

  it('leaves existing trips alone when ending without cancelFuture', async () => {
    const created = await api('POST', '/api/recurring-rides', {
      cookie: dispatcher.cookie,
      payload: sampleRecurring(),
    });
    const rideId = (created.body.ride as { id: string }).id;
    await materialiseDueRides();

    await api('POST', `/api/recurring-rides/${rideId}/end`, {
      cookie: dispatcher.cookie,
      payload: { reason: 'Paused', cancelFuture: false },
    });

    const after = await db.select().from(trips).where(eq(trips.recurringRideId, rideId));
    expect(after.some((t) => t.status !== 'cancelled')).toBe(true);
  });

  // --- duplicate ride ------------------------------------------------------

  it('duplicates a completed trip as a brand new pending one', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const sourceId = (created.body.trip as { id: string }).id;

    await api('POST', `/api/trips/${sourceId}/assign`, {
      cookie: dispatcher.cookie,
      payload: { volunteerId: volunteer.id },
    });
    await api('POST', `/api/trips/${sourceId}/complete`, { cookie: dispatcher.cookie, payload: {} });

    const dup = await api('POST', `/api/trips/${sourceId}/duplicate`, {
      cookie: dispatcher.cookie,
      payload: {},
    });
    expect(dup.status).toBe(201);

    const newId = (dup.body.trip as { id: string }).id;
    const [fresh] = await db.select().from(trips).where(eq(trips.id, newId));
    const [source] = await db.select().from(trips).where(eq(trips.id, sourceId));

    // Carried over: the journey.
    expect(fresh!.callerName).toBe(source!.callerName);
    expect(fresh!.pickupAddressId).toBeTruthy();
    expect(fresh!.mobilityNeeds).toEqual(source!.mobilityNeeds);

    // NOT carried over: anything that happened to it.
    expect(fresh!.status).toBe('pending');
    expect(fresh!.assignedVolunteerId).toBeNull();
    expect(fresh!.acceptedAt).toBeNull();
    expect(fresh!.completedAt).toBeNull();
    expect(fresh!.offerExpiresAt).toBeNull();
    expect(fresh!.escalatedAt).toBeNull();
    expect(fresh!.offerRound).toBe(0);
    expect(fresh!.reference).not.toBe(source!.reference);
    expect(fresh!.duplicatedFromTripId).toBe(sourceId);
    expect(fresh!.pickupAt.getTime()).toBeGreaterThan(source!.pickupAt.getTime());
  });

  it('gives the duplicate its own offers and audit trail', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const sourceId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${sourceId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    const dup = await api('POST', `/api/trips/${sourceId}/duplicate`, { cookie: dispatcher.cookie, payload: {} });
    const newId = (dup.body.trip as { id: string }).id;

    const offers = (await db.execute(raw`
      select count(*)::int as n from trip_offers where trip_id = ${newId}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(Number(offers[0]!.n)).toBe(0);

    const audit = await api('GET', `/api/audit?entityType=trip&entityId=${newId}`, {
      cookie: dispatcher.cookie,
    });
    const actions = (audit.body.events as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('trip.duplicated');
    expect(actions).not.toContain('trip.offered');
  });

  it('accepts an explicit pickup time for the duplicate', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const sourceId = (created.body.trip as { id: string }).id;
    const when = new Date(Date.now() + 72 * 3_600_000);

    const dup = await api('POST', `/api/trips/${sourceId}/duplicate`, {
      cookie: dispatcher.cookie,
      payload: { pickupAt: when.toISOString(), priority: 'urgent' },
    });
    const [fresh] = await db.select().from(trips).where(eq(trips.id, (dup.body.trip as { id: string }).id));
    expect(Math.abs(fresh!.pickupAt.getTime() - when.getTime())).toBeLessThan(2000);
    expect(fresh!.priority).toBe('urgent');
  });

  it('refuses to let a volunteer duplicate a trip', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const sourceId = (created.body.trip as { id: string }).id;
    const res = await api('POST', `/api/trips/${sourceId}/duplicate`, {
      cookie: volunteer.cookie,
      payload: {},
    });
    expect(res.status).toBe(403);
  });
});

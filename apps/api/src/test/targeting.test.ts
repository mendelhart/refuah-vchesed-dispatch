import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { availabilityRules, trips, users } from '../db/schema.js';
import { evaluateCandidates } from '../domain/targeting.js';
import { localMinuteOfDay, localWeekday } from '../lib/time.js';

/**
 * Targeting.
 *
 * The behaviour these tests pin down is the difference between an organisation
 * that can afford 500 volunteers and one that cannot. Each filter gets a test
 * for what it excludes AND a test that it does not exclude the wrong people —
 * a targeting bug that silently narrows the pool looks exactly like a quiet
 * evening until somebody is left without a ride.
 */
describe('offer targeting', () => {
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher' });
  });

  async function makeTrip(over: Record<string, unknown> = {}): Promise<string> {
    const res = await api('POST', '/api/trips', {
      cookie: dispatcher.cookie,
      payload: sampleTrip(over),
    });
    expect(res.status).toBe(201);
    return (res.body.trip as { id: string }).id;
  }

  async function groupIdOf(tripId: string): Promise<string> {
    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    return trip!.groupId;
  }

  it('offers to a volunteer with no availability rules on file', async () => {
    // The critical default. Rules absent means "no stated restriction", not
    // "never available" — the opposite reading would mute the whole roster on
    // the day availability shipped.
    const volunteer = await createTestUser({ role: 'volunteer' });
    const tripId = await makeTrip();
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(res.status).toBe(200);
    expect(res.body.offered).toBe(1);
    expect((res.body.skipped as unknown[]).some((s) => (s as { volunteerId: string }).volunteerId === volunteer.id)).toBe(false);
  });

  it('skips a volunteer whose availability does not cover the pickup time', async () => {
    const available = await createTestUser({ role: 'volunteer', name: 'Always Free' });
    const busy = await createTestUser({ role: 'volunteer', name: 'Only Mondays' });

    const pickupAt = new Date(Date.now() + 4 * 3_600_000);
    const weekday = localWeekday(pickupAt);
    const minute = localMinuteOfDay(pickupAt);

    // A window on a different day entirely.
    await db.insert(availabilityRules).values({
      userId: busy.id,
      weekday: (weekday + 3) % 7,
      startMinute: 0,
      endMinute: 1440,
    });
    // And one on the right day that stops before the pickup, to prove the
    // comparison is on the time as well as the day.
    await db.insert(availabilityRules).values({
      userId: busy.id,
      weekday,
      startMinute: 0,
      endMinute: Math.max(1, minute - 60),
    });

    const tripId = await makeTrip({ pickupAt: pickupAt.toISOString() });
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    expect(res.status).toBe(200);
    expect(res.body.offered).toBe(1);
    const skipped = res.body.skipped as Array<{ volunteerId: string; reason: string }>;
    const entry = skipped.find((s) => s.volunteerId === busy.id);
    expect(entry?.reason).toMatch(/not available/i);
    expect(skipped.find((s) => s.volunteerId === available.id)).toBeUndefined();
  });

  it('offers inside a stated availability window', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const pickupAt = new Date(Date.now() + 4 * 3_600_000);
    await db.insert(availabilityRules).values({
      userId: volunteer.id,
      weekday: localWeekday(pickupAt),
      startMinute: Math.max(0, localMinuteOfDay(pickupAt) - 30),
      endMinute: Math.min(1440, localMinuteOfDay(pickupAt) + 30),
    });
    const tripId = await makeTrip({ pickupAt: pickupAt.toISOString() });
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(res.body.offered).toBe(1);
  });

  it('skips a volunteer who cannot cover the mobility need', async () => {
    const capable = await createTestUser({ role: 'volunteer', capabilities: ['wheelchair'] });
    const notCapable = await createTestUser({ role: 'volunteer', capabilities: [] });

    const tripId = await makeTrip({ mobilityNeeds: ['wheelchair'] });
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    expect(res.body.offered).toBe(1);
    const skipped = res.body.skipped as Array<{ volunteerId: string; reason: string }>;
    expect(skipped.find((s) => s.volunteerId === notCapable.id)?.reason).toMatch(/cannot cover/i);
    expect(skipped.find((s) => s.volunteerId === capable.id)).toBeUndefined();
  });

  it('does not require any capability for a trip with no mobility needs', async () => {
    await createTestUser({ role: 'volunteer', capabilities: [] });
    const tripId = await makeTrip({ mobilityNeeds: [] });
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(res.body.offered).toBe(1);
  });

  it('skips a volunteer who has not opted in to this service', async () => {
    const optedIn = await createTestUser({ role: 'volunteer', services: ['ride'] });
    const optedOut = await createTestUser({ role: 'volunteer', services: ['hospital_food'] });

    const tripId = await makeTrip({ tripType: 'ride' });
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    expect(res.body.offered).toBe(1);
    const skipped = res.body.skipped as Array<{ volunteerId: string; reason: string }>;
    expect(skipped.find((s) => s.volunteerId === optedOut.id)?.reason).toMatch(/opted in/i);
    expect(skipped.find((s) => s.volunteerId === optedIn.id)).toBeUndefined();
  });

  it('skips a snoozed volunteer but still reaches the others', async () => {
    const awake = await createTestUser({ role: 'volunteer' });
    const snoozed = await createTestUser({ role: 'volunteer' });
    await db
      .update(users)
      .set({ mutedUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(users.id, snoozed.id));

    const tripId = await makeTrip();
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    expect(res.body.offered).toBe(1);
    const skipped = res.body.skipped as Array<{ volunteerId: string; reason: string }>;
    expect(skipped.find((s) => s.volunteerId === snoozed.id)?.reason).toMatch(/snoozed/i);
    expect(skipped.find((s) => s.volunteerId === awake.id)).toBeUndefined();
  });

  it('skips a volunteer already committed to another trip at that hour', async () => {
    const busy = await createTestUser({ role: 'volunteer' });
    const free = await createTestUser({ role: 'volunteer' });

    const pickupAt = new Date(Date.now() + 5 * 3_600_000);
    const firstId = await makeTrip({ pickupAt: pickupAt.toISOString() });
    await api('POST', `/api/trips/${firstId}/assign`, {
      cookie: dispatcher.cookie,
      payload: { volunteerId: busy.id },
    });

    // 30 minutes later — inside the 90-minute conflict window.
    const secondId = await makeTrip({
      pickupAt: new Date(pickupAt.getTime() + 30 * 60_000).toISOString(),
    });
    const res = await api('POST', `/api/trips/${secondId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    expect(res.body.offered).toBe(1);
    const skipped = res.body.skipped as Array<{ volunteerId: string; reason: string }>;
    expect(skipped.find((s) => s.volunteerId === busy.id)?.reason).toMatch(/another trip/i);
    expect(skipped.find((s) => s.volunteerId === free.id)).toBeUndefined();
  });

  it('relaxes availability for an emergency', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const pickupAt = new Date(Date.now() + 2 * 3_600_000);
    // Available only on a different day.
    await db.insert(availabilityRules).values({
      userId: volunteer.id,
      weekday: (localWeekday(pickupAt) + 2) % 7,
      startMinute: 0,
      endMinute: 1440,
    });
    await db.update(users).set({ mutedUntil: new Date(Date.now() + 3_600_000) }).where(eq(users.id, volunteer.id));

    const routine = await makeTrip({ pickupAt: pickupAt.toISOString(), priority: 'routine' });
    const routineRes = await api('POST', `/api/trips/${routine}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(routineRes.status).toBe(409);

    const emergency = await makeTrip({ pickupAt: pickupAt.toISOString(), priority: 'emergency' });
    const emergencyRes = await api('POST', `/api/trips/${emergency}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(emergencyRes.status).toBe(200);
    expect(emergencyRes.body.offered).toBe(1);
    expect(emergencyRes.body.relaxed).toBe(true);
  });

  it('widens an urgent trip only when the strict pool is empty', async () => {
    const unavailable = await createTestUser({ role: 'volunteer' });
    const pickupAt = new Date(Date.now() + 2 * 3_600_000);
    await db.insert(availabilityRules).values({
      userId: unavailable.id,
      weekday: (localWeekday(pickupAt) + 2) % 7,
      startMinute: 0,
      endMinute: 1440,
    });

    const tripId = await makeTrip({ pickupAt: pickupAt.toISOString(), priority: 'urgent' });
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    expect(res.status).toBe(200);
    expect(res.body.offered).toBe(1);
    expect(res.body.relaxed).toBe(true);
    expect(String(res.body.relaxedReason)).toMatch(/urgent/i);
  });

  it('does not widen an urgent trip when somebody strictly qualifies', async () => {
    await createTestUser({ role: 'volunteer', name: 'Strictly available' });
    const snoozed = await createTestUser({ role: 'volunteer', name: 'Snoozed' });
    await db
      .update(users)
      .set({ mutedUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(users.id, snoozed.id));

    const tripId = await makeTrip({ priority: 'urgent' });
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    expect(res.body.offered).toBe(1);
    expect(res.body.relaxed).toBe(false);
  });

  it('gives a urgent trip a shorter offer window than a routine one', async () => {
    await createTestUser({ role: 'volunteer' });
    const routineId = await makeTrip({ priority: 'routine' });
    const routine = await api('POST', `/api/trips/${routineId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    await createTestUser({ role: 'volunteer' });
    const urgentId = await makeTrip({ priority: 'urgent' });
    const urgent = await api('POST', `/api/trips/${urgentId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    const routineWindow = new Date(routine.body.expiresAt as string).getTime() - Date.now();
    const urgentWindow = new Date(urgent.body.expiresAt as string).getTime() - Date.now();
    expect(urgentWindow).toBeLessThan(routineWindow);
  });

  it('orders the pool by who was asked least recently', async () => {
    const recently = await createTestUser({ role: 'volunteer', name: 'Asked an hour ago' });
    const longAgo = await createTestUser({ role: 'volunteer', name: 'Asked last week' });
    await db.update(users).set({ lastOfferedAt: new Date(Date.now() - 3_600_000) }).where(eq(users.id, recently.id));
    await db.update(users).set({ lastOfferedAt: new Date(Date.now() - 7 * 86_400_000) }).where(eq(users.id, longAgo.id));

    const tripId = await makeTrip();
    const result = await evaluateCandidates({
      groupId: await groupIdOf(tripId),
      tripType: 'ride',
      priority: 'routine',
      pickupAt: new Date(Date.now() + 4 * 3_600_000),
      mobilityNeeds: [],
    });

    expect(result.eligible[0]!.id).toBe(longAgo.id);
    expect(result.eligible[1]!.id).toBe(recently.id);
  });

  it('records being asked, so the rotation advances', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const before = (await db.select().from(users).where(eq(users.id, volunteer.id)))[0]!.lastOfferedAt;
    expect(before).toBeNull();

    const tripId = await makeTrip();
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    const after = (await db.select().from(users).where(eq(users.id, volunteer.id)))[0]!.lastOfferedAt;
    expect(after).not.toBeNull();
  });

  it('explains why nobody could be offered instead of saying "no volunteers"', async () => {
    await createTestUser({ role: 'volunteer', capabilities: [] });
    const tripId = await makeTrip({ mobilityNeeds: ['stretcher'] });
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    expect(res.status).toBe(409);
    const message = (res.body.error as { message: string }).message;
    expect(message).toMatch(/cannot cover/i);
    expect(message).toMatch(/stretcher/i);
  });

  it('honours a dispatcher naming volunteers explicitly, filters and all', async () => {
    // A dispatcher who names someone has already made the judgement the filters
    // exist to make. Second-guessing them produces "the system will not let me
    // send it to the person I just spoke to on the phone".
    const snoozedAndUnavailable = await createTestUser({ role: 'volunteer', capabilities: [] });
    await db
      .update(users)
      .set({ mutedUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(users.id, snoozedAndUnavailable.id));

    const tripId = await makeTrip({ mobilityNeeds: [] });
    const res = await api('POST', `/api/trips/${tripId}/offer`, {
      cookie: dispatcher.cookie,
      payload: { volunteerIds: [snoozedAndUnavailable.id] },
    });
    expect(res.status).toBe(200);
    expect(res.body.offered).toBe(1);
  });

  it('never offers to a dispatcher who is not also a volunteer', async () => {
    await createTestUser({ role: 'volunteer' });
    const tripId = await makeTrip();
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(res.body.offered).toBe(1);

    const offers = (await db.execute(raw`
      select u.role from trip_offers o join users u on u.id = o.volunteer_id
      where o.trip_id = ${tripId}::uuid
    `)) as unknown as Array<{ role: string }>;
    expect(offers.every((o) => o.role === 'volunteer')).toBe(true);
  });
});

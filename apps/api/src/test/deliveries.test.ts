import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, drainJobs, futureDate, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { captured } from '../services/providers/index.js';

/** Item 6: package deliveries and lift assist. */
const call = (method: 'GET' | 'POST' | 'PUT', path: string, who: TestUser, payload?: unknown) =>
  api(method, path, { cookie: who.cookie, ...(payload !== undefined ? { payload } : {}) });

describe('item 6', () => {
beforeAll(async () => { await getApp(); });
afterAll(async () => { await shutdown(); });

describe('package deliveries', () => {
  let coord: TestUser;
  let driver: TestUser;
  let other: TestUser;
  const original = env.PACKAGE_DELIVERY_ENABLED;

  beforeEach(async () => {
    await resetDb();
    env.PACKAGE_DELIVERY_ENABLED = true;
    coord = await createTestUser({ role: 'dispatcher', groups: [] });
    driver = await createTestUser({ role: 'volunteer' });
    other = await createTestUser({ role: 'volunteer' });
  });
  afterEach(() => { env.PACKAGE_DELIVERY_ENABLED = original; });

  const body = () => ({
    trip: sampleTrip({ tripType: 'equipment_delivery', mobilityNeeds: [] }),
    package: { description: 'Box of medication', size: 'small', weightKg: 1.5, recipientName: 'Leah Klein', recipientPhone: '514-555-0177', handlingNotes: 'Keep upright' },
  });

  it('is off by default and 404 while off', async () => {
    expect(original).toBe(false);
    env.PACKAGE_DELIVERY_ENABLED = false;
    expect((await call('POST', '/api/packages', coord, body())).status).toBe(404);
  });

  it('a package delivery is an ordinary equipment-delivery trip with the package described', async () => {
    const res = await call('POST', '/api/packages', coord, body());
    expect(res.status).toBe(201);
    expect((res.body.trip as { tripType: string }).tripType).toBe('equipment_delivery');
    expect(res.body.package).toMatchObject({ description: 'Box of medication', size: 'small', weightKg: 1.5, recipientName: 'Leah Klein', deliveredAt: null });
  });

  it('only the coordinator and the trip’s own driver see the package; proof of delivery once', async () => {
    const res = await call('POST', '/api/packages', coord, body());
    const tripId = (res.body.trip as { id: string }).id;
    expect((await call('GET', `/api/trips/${tripId}/package`, driver)).status).toBe(404);
    // Not assigned yet: cannot be marked delivered.
    expect((await call('POST', `/api/trips/${tripId}/package/delivered`, coord, { receivedBy: 'Leah' })).status).toBe(409);
    await call('POST', `/api/trips/${tripId}/assign`, coord, { volunteerId: driver.id });
    expect((await call('GET', `/api/trips/${tripId}/package`, driver)).status).toBe(200);
    expect((await call('GET', `/api/trips/${tripId}/package`, other)).status).toBe(404);
    expect((await call('POST', `/api/trips/${tripId}/package/delivered`, other, { receivedBy: 'x' })).status).toBe(404);
    const done = await call('POST', `/api/trips/${tripId}/package/delivered`, driver, { receivedBy: 'Leah Klein', note: 'Left with her daughter' });
    expect(done.status).toBe(200);
    expect((done.body.package as { receivedBy: string; deliveredAt: string | null }).deliveredAt).not.toBeNull();
    expect((await call('POST', `/api/trips/${tripId}/package/delivered`, driver, { receivedBy: 'Again' })).status).toBe(409);
    const audit = await db.execute(raw`select 1 from audit_events where action = 'package.delivered'`);
    expect(audit.length).toBe(1);
  });
});

describe('lift assist', () => {
  let coord: TestUser;
  let helpers: TestUser[];
  let notHelper: TestUser;
  const original = env.LIFT_ASSIST_ENABLED;

  beforeEach(async () => {
    await resetDb();
    env.LIFT_ASSIST_ENABLED = true;
    coord = await createTestUser({ role: 'dispatcher', groups: [] });
    helpers = await Promise.all([1, 2, 3, 4].map(() => createTestUser({ role: 'volunteer' })));
    notHelper = await createTestUser({ role: 'volunteer' });
    for (const h of helpers) expect((await call('PUT', '/api/lift-assist/helper', h, { willing: true })).status).toBe(200);
  });
  afterEach(() => { env.LIFT_ASSIST_ENABLED = original; });

  async function newRequest(needed = 2): Promise<string> {
    const res = await call('POST', '/api/lift-assist', coord, { title: 'Move a hospital bed', location: '1234 Avenue Bernard', startsAt: futureDate(24), needed });
    expect(res.status).toBe(201);
    return (res.body.request as { id: string }).id;
  }

  it('is off by default and 404 while off; volunteers cannot create or invite', async () => {
    expect(original).toBe(false);
    expect((await call('POST', '/api/lift-assist', helpers[0]!, { title: 'x', location: 'xyz', startsAt: futureDate(2), needed: 2 })).status).toBe(403);
    env.LIFT_ASSIST_ENABLED = false;
    expect((await call('POST', '/api/lift-assist', coord, { title: 'x', location: 'xyz', startsAt: futureDate(2), needed: 2 })).status).toBe(404);
  });

  it('suggests only people who offered to help lift and are free, and names them before sending', async () => {
    const id = await newRequest();
    // One helper is busy on a ride at that time.
    const trip = await call('POST', '/api/trips', coord, sampleTrip({ pickupAt: futureDate(24) }));
    await call('POST', `/api/trips/${(trip.body.trip as { id: string }).id}/assign`, coord, { volunteerId: helpers[3]!.id });
    const p = await call('POST', `/api/lift-assist/${id}/preview`, coord, {});
    const names = (p.body.recipients as Array<{ id: string }>).map((r) => r.id).sort();
    expect(names).toEqual(helpers.slice(0, 3).map((h) => h.id).sort());
    expect(names).not.toContain(notHelper.id);
    expect(p.body).toMatchObject({ count: 3, needed: 2, enough: true });
    expect(captured.sms.length).toBe(0);
  });

  it('invites exactly the previewed people, once; never someone who is not a suggestion', async () => {
    const id = await newRequest();
    const chosen = [helpers[0]!.id, helpers[1]!.id];
    const p = await call('POST', `/api/lift-assist/${id}/preview`, coord, { userIds: chosen });
    expect(p.body.count).toBe(2);
    const send = { userIds: chosen, audienceHash: p.body.audienceHash, confirm: true };
    const results = await Promise.all([1, 2].map(() => call('POST', `/api/lift-assist/${id}/invite`, coord, send)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    await drainJobs();
    const invited = await db.execute<{ user_id: string }>(raw`select user_id from notifications where event = 'lift_assist.invite'`);
    expect(invited.map((r) => r.user_id).sort()).toEqual([...chosen].sort());
    expect((await call('POST', `/api/lift-assist/${id}/preview`, coord, { userIds: [notHelper.id] })).status).toBe(422);
    expect((await call('POST', `/api/lift-assist/${id}/invite`, coord, { userIds: [helpers[2]!.id], audienceHash: p.body.audienceHash, confirm: true })).status).toBe(422);
  });

  it('closes when enough say yes; the first yes leads; late yeses are thanked, not added', async () => {
    const id = await newRequest(2);
    const ids = helpers.slice(0, 3).map((h) => h.id);
    const p = await call('POST', `/api/lift-assist/${id}/preview`, coord, { userIds: ids });
    await call('POST', `/api/lift-assist/${id}/invite`, coord, { userIds: ids, audienceHash: p.body.audienceHash, confirm: true });
    expect((await call('POST', `/api/lift-assist/${id}/respond`, helpers[0]!, { accept: true })).body.status).toBe('open');
    expect((await call('POST', `/api/lift-assist/${id}/respond`, helpers[2]!, { accept: false })).status).toBe(200);
    // Two people answer yes for the last place at the same moment.
    const both = await Promise.all([helpers[1]!, helpers[2]!].map((h) => call('POST', `/api/lift-assist/${id}/respond`, h, { accept: true })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const view = await call('GET', `/api/lift-assist/${id}`, coord);
    expect(view.body.request).toMatchObject({ status: 'filled', accepted: 2, leadName: helpers[0]!.fullName });
    await drainJobs();
    const confirmed = await db.execute(raw`select 1 from notifications where event = 'lift_assist.confirmed'`);
    expect(confirmed.length).toBe(2);
  });

  it('a volunteer sees only requests they were asked to, without other people’s names', async () => {
    const id = await newRequest();
    const ids = [helpers[0]!.id, helpers[1]!.id];
    const p = await call('POST', `/api/lift-assist/${id}/preview`, coord, { userIds: ids });
    await call('POST', `/api/lift-assist/${id}/invite`, coord, { userIds: ids, audienceHash: p.body.audienceHash, confirm: true });
    const mine = await call('GET', `/api/lift-assist/${id}`, helpers[0]!);
    expect(mine.status).toBe(200);
    expect((mine.body.request as { invites?: unknown }).invites).toBeUndefined();
    expect((await call('GET', `/api/lift-assist/${id}`, helpers[2]!)).status).toBe(404);
    expect(((await call('GET', '/api/lift-assist', helpers[2]!)).body.requests as unknown[]).length).toBe(0);
  });

  it('the coordinator can choose the lead among those who said yes', async () => {
    const id = await newRequest(3);
    const ids = helpers.slice(0, 3).map((h) => h.id);
    const p = await call('POST', `/api/lift-assist/${id}/preview`, coord, { userIds: ids });
    await call('POST', `/api/lift-assist/${id}/invite`, coord, { userIds: ids, audienceHash: p.body.audienceHash, confirm: true });
    await call('POST', `/api/lift-assist/${id}/respond`, helpers[0]!, { accept: true });
    await call('POST', `/api/lift-assist/${id}/respond`, helpers[1]!, { accept: true });
    expect((await call('POST', `/api/lift-assist/${id}/lead`, coord, { userId: helpers[2]!.id })).status).toBe(422);
    expect((await call('POST', `/api/lift-assist/${id}/lead`, coord, { userId: helpers[1]!.id })).status).toBe(200);
    expect(((await call('GET', `/api/lift-assist/${id}`, coord)).body.request as { leadName: string }).leadName).toBe(helpers[1]!.fullName);
  });
});
});

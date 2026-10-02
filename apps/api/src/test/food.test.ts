import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { captured, capturedExtra } from '../services/providers/index.js';
import { addDaysToDateString, localDateString, weekdayOfDateString } from '../lib/time.js';

/** Food operations (item 5). */
describe('food operations', () => {
  let coord: TestUser;
  let vol1: TestUser;
  let vol2: TestUser;
  let vol3: TestUser;
  const original = env.FOOD_OPS_ENABLED;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    env.FOOD_OPS_ENABLED = true;
    coord = await createTestUser({ role: 'dispatcher', groups: [] });
    vol1 = await createTestUser({ role: 'volunteer' });
    vol2 = await createTestUser({ role: 'volunteer' });
    vol3 = await createTestUser({ role: 'volunteer' });
  });
  afterEach(() => { env.FOOD_OPS_ENABLED = original; });

  const call = (method: 'GET' | 'POST', path: string, who: TestUser, payload?: unknown) =>
    api(method, path, { cookie: who.cookie, ...(payload !== undefined ? { payload } : {}) });

  it('is off by default, and every route is a 404 while off', async () => {
    expect(original).toBe(false);
    env.FOOD_OPS_ENABLED = false;
    expect((await call('GET', '/api/food/items', coord)).status).toBe(404);
    expect((await call('GET', '/api/food/prep-slots/upcoming', vol1)).status).toBe(404);
  });

  it('volunteers cannot manage stock, runs or lists', async () => {
    expect((await call('GET', '/api/food/items', vol1)).status).toBe(403);
    expect((await call('POST', '/api/food/shopping-lists', vol1, { title: 'x', items: [{ name: 'a', quantity: 1 }] })).status).toBe(403);
  });

  it('stock: items with vendors, low-stock flag, adjustments audited and never below zero', async () => {
    const v = await call('POST', '/api/food/vendors', coord, { name: 'Kosher Wholesale', phone: '514-555-0100' });
    const it1 = await call('POST', '/api/food/items', coord, { name: 'Challah', unit: 'loaf', vendorId: v.body.id, onHand: 10, parLevel: 20 });
    expect(it1.status).toBe(201);
    expect((await call('POST', '/api/food/items', coord, { name: 'challah' })).status).toBe(409);
    const items = (await call('GET', '/api/food/items', coord)).body.items as Array<{ name: string; low: boolean; vendorName: string }>;
    expect(items[0]).toMatchObject({ name: 'Challah', low: true, vendorName: 'Kosher Wholesale' });
    const id = it1.body.id as string;
    expect((await call('POST', `/api/food/items/${id}/adjust`, coord, { change: 15, reason: 'Delivery' })).body.onHand).toBe(25);
    const tooMuch = await call('POST', `/api/food/items/${id}/adjust`, coord, { change: -30, reason: 'Used' });
    expect(tooMuch.status).toBe(422);
    const audit = await db.execute(raw`select 1 from audit_events where action = 'food.stock_adjusted'`);
    expect(audit.length).toBe(1);
  });

  describe('preparation slots', () => {
    let slotId: string;
    let date: string;

    beforeEach(async () => {
      date = addDaysToDateString(localDateString(new Date()), 2);
      const item = await call('POST', '/api/food/items', coord, { name: 'Soup', unit: 'litre' });
      const res = await call('POST', '/api/food/prep-slots', coord, {
        title: 'Friday cooking', weekday: weekdayOfDateString(date), startMinute: 600, endMinute: 780, staffNeeded: 2,
        items: [{ itemId: item.body.id, quantity: 20 }],
      });
      expect(res.status).toBe(201);
      slotId = res.body.id as string;
    });

    it('shows what is needed and who is coming; volunteers do not see names', async () => {
      await call('POST', `/api/food/prep-slots/${slotId}/signup`, vol1, { onDate: date });
      const staffView = (await call('GET', '/api/food/prep-slots/upcoming?days=7', coord)).body.slots as Array<Record<string, unknown>>;
      const occ = staffView.find((s) => s.date === date)!;
      expect(occ).toMatchObject({ staffNeeded: 2, signedUp: 1, stillNeeded: 1, items: [{ name: 'Soup', unit: 'litre', quantity: 20 }] });
      expect(occ.names).toEqual([vol1.fullName]);
      const volView = (await call('GET', '/api/food/prep-slots/upcoming?days=7', vol2)).body.slots as Array<Record<string, unknown>>;
      expect(volView.find((s) => s.date === date)!.names).toBeUndefined();
    });

    it('never takes more people than needed, even when they press together', async () => {
      const results = await Promise.all([vol1, vol2, vol3].map((v) => call('POST', `/api/food/prep-slots/${slotId}/signup`, v, { onDate: date })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409]);
      const [{ n }] = await db.execute<{ n: number }>(raw`select count(*)::int as n from food_prep_signups`) as unknown as [{ n: number }];
      expect(n).toBe(2);
    });

    it('signing up twice is harmless; withdrawing frees the place', async () => {
      await call('POST', `/api/food/prep-slots/${slotId}/signup`, vol1, { onDate: date });
      expect((await call('POST', `/api/food/prep-slots/${slotId}/signup`, vol1, { onDate: date })).body.already).toBe(true);
      await call('POST', `/api/food/prep-slots/${slotId}/withdraw`, vol1, { onDate: date });
      const [{ n }] = await db.execute<{ n: number }>(raw`select count(*)::int as n from food_prep_signups`) as unknown as [{ n: number }];
      expect(n).toBe(0);
    });

    it('refuses a day the slot does not run', async () => {
      const wrong = addDaysToDateString(date, 1);
      expect((await call('POST', `/api/food/prep-slots/${slotId}/signup`, vol1, { onDate: wrong })).status).toBe(422);
    });
  });

  it('distribution runs: route, recipients and volunteers; a volunteer sees only their own runs', async () => {
    const res = await call('POST', '/api/food/runs', coord, {
      runDate: localDateString(new Date()), route: 'Jewish General, then Mount Sinai', recipientsCount: 40, volunteerIds: [vol1.id],
    });
    expect(res.status).toBe(201);
    await call('POST', `/api/food/runs/${res.body.id as string}/status`, coord, { status: 'done', recipientsCount: 42 });
    const mine = (await call('GET', '/api/food/runs', vol1)).body.runs as Array<{ status: string; recipientsCount: number; volunteers: string[] }>;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'done', recipientsCount: 42, volunteers: [vol1.fullName] });
    expect(((await call('GET', '/api/food/runs', vol2)).body.runs as unknown[]).length).toBe(0);
  });

  it('the hospital_food trip type is unchanged and unaffected', async () => {
    const trip = await call('POST', '/api/trips', coord, sampleTrip({ tripType: 'hospital_food', callerName: null, callerPhone: null }));
    expect(trip.status).toBe(201);
  });

  describe('shopping lists', () => {
    let listId: string;
    beforeEach(async () => {
      const res = await call('POST', '/api/food/shopping-lists', coord, {
        title: 'Thursday shopping', items: [{ name: 'Eggs', quantity: 6, unit: 'dozen' }, { name: 'Flour', quantity: 10, unit: 'kg' }],
      });
      listId = res.body.id as string;
    });

    it('preview names the people and the count before anything is sent', async () => {
      const p = await call('POST', `/api/food/shopping-lists/${listId}/preview`, coord, { userIds: [vol2.id, vol1.id] });
      expect(p.body).toMatchObject({ count: 2, alreadySent: false });
      expect((p.body.recipients as Array<{ fullName: string }>).map((r) => r.fullName).sort()).toEqual([vol1.fullName, vol2.fullName].sort());
      expect(captured.sms.length + capturedExtra.email.length).toBe(0);
    });

    it('sends once to exactly the previewed people; a second press, or two at once, sends nothing more', async () => {
      const p = await call('POST', `/api/food/shopping-lists/${listId}/preview`, coord, { userIds: [vol1.id, vol2.id] });
      const body = { userIds: [vol2.id, vol1.id], audienceHash: p.body.audienceHash, confirm: true };
      const results = await Promise.all([1, 2, 3].map(() => call('POST', `/api/food/shopping-lists/${listId}/send`, coord, body)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      await drainJobs();
      const notes = await db.execute<{ user_id: string }>(raw`select user_id from notifications where event = 'food.shopping_list'`);
      expect(notes.map((n) => n.user_id).sort()).toEqual([vol1.id, vol2.id].sort());
      expect(captured.sms.filter((m) => m.to === vol3.phone)).toHaveLength(0);
      const again = await call('POST', `/api/food/shopping-lists/${listId}/preview`, coord, { userIds: [vol1.id, vol2.id] });
      expect(again.body.alreadySent).toBe(true);
    });

    it('refuses a send whose people differ from the preview, or without confirmation', async () => {
      const p = await call('POST', `/api/food/shopping-lists/${listId}/preview`, coord, { userIds: [vol1.id] });
      expect((await call('POST', `/api/food/shopping-lists/${listId}/send`, coord, { userIds: [vol1.id, vol3.id], audienceHash: p.body.audienceHash, confirm: true })).status).toBe(422);
      expect((await call('POST', `/api/food/shopping-lists/${listId}/send`, coord, { userIds: [vol1.id], audienceHash: p.body.audienceHash })).status).toBe(422);
      const sent = await db.execute(raw`select 1 from notifications where event = 'food.shopping_list'`);
      expect(sent.length).toBe(0);
    });

    it('can never go to everyone: 25 people at most', async () => {
      const many = Array.from({ length: 26 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      expect((await call('POST', `/api/food/shopping-lists/${listId}/preview`, coord, { userIds: many })).status).toBe(422);
    });
  });
});

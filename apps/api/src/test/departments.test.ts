import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';

/**
 * Department-aware permissions (item 4). Server-side: every check here goes
 * through the API, never the screens.
 */
describe('departments', () => {
  let admin: TestUser;
  let food: TestUser; // coordinator in the food department only
  let open: TestUser; // coordinator in no department: today's access
  let volunteer: TestUser;
  let rideId: string;
  let foodId: string;
  const original = env.DEPARTMENT_SCOPING_ENABLED;

  const as = (u: TestUser) => ({ cookie: u.cookie });

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    env.DEPARTMENT_SCOPING_ENABLED = true;
    admin = await createTestUser({ role: 'admin', groups: [] });
    food = await createTestUser({ role: 'dispatcher', groups: ['chesed_on_the_go', 'chaim_vchesed'] });
    open = await createTestUser({ role: 'dispatcher', groups: [] });
    volunteer = await createTestUser({ role: 'volunteer' });
    const r = await api('POST', '/api/trips', { ...as(open), payload: sampleTrip() });
    rideId = (r.body.trip as { id: string }).id;
    const f = await api('POST', '/api/trips', { ...as(open), payload: sampleTrip({ tripType: 'hospital_food', callerName: null, callerPhone: null }) });
    foodId = (f.body.trip as { id: string }).id;
    const set = await api('PUT', '/api/departments/food/members', { ...as(admin), payload: { userIds: [food.id] } });
    expect(set.status).toBe(200);
  });
  afterEach(() => { env.DEPARTMENT_SCOPING_ENABLED = original; });

  const boardIds = async (u: TestUser) =>
    ((await api('GET', '/api/trips?scope=board', as(u))).body.items as Array<{ id: string }>).map((t) => t.id).sort();

  it('is off by default; while off nobody is restricted and the admin routes are 404', async () => {
    expect(original).toBe(false);
    env.DEPARTMENT_SCOPING_ENABLED = false;
    expect(await boardIds(food)).toEqual([rideId, foodId].sort());
    expect((await api('GET', `/api/trips/${rideId}`, as(food))).status).toBe(200);
    expect((await api('GET', '/api/departments', as(admin))).status).toBe(404);
  });

  it('a coordinator in no department keeps exactly today’s access', async () => {
    expect(await boardIds(open)).toEqual([rideId, foodId].sort());
    expect((await api('GET', '/api/equipment', as(open))).status).toBe(200);
    expect((await api('GET', '/api/me/departments', as(open))).body).toEqual({ departments: null });
  });

  it('a food coordinator sees only food work on the board and in the counts', async () => {
    expect(await boardIds(food)).toEqual([foodId]);
    const summary = await api('GET', '/api/trips/summary', as(food));
    expect(summary.status).toBe(200);
    expect((summary.body as { needsAttention: number }).needsAttention).toBe(1);
    expect((await api('GET', '/api/me/departments', as(food))).body).toEqual({ departments: ['food'] });
  });

  it('…and cannot open, change, offer or cancel a ride outside it (not even confirmed to exist)', async () => {
    expect((await api('GET', `/api/trips/${rideId}`, as(food))).status).toBe(404);
    expect((await api('PATCH', `/api/trips/${rideId}`, { ...as(food), payload: { passengerNotes: 'x' } })).status).toBe(404);
    expect((await api('POST', `/api/trips/${rideId}/offer`, { ...as(food), payload: {} })).status).toBe(404);
    expect((await api('POST', `/api/trips/${rideId}/cancel`, { ...as(food), payload: { reason: 'x' } })).status).toBe(404);
    expect((await api('POST', '/api/trips/bulk/offer', { ...as(food), payload: { tripIds: [foodId, rideId] } })).status).toBe(403);
    const [t] = await db.execute<{ status: string }>(raw`select status from trips where id = ${rideId}`);
    expect(t!.status).toBe('pending');
  });

  it('…can work on its own trips', async () => {
    expect((await api('GET', `/api/trips/${foodId}`, as(food))).status).toBe(200);
    expect((await api('POST', `/api/trips/${foodId}/offer`, { ...as(food), payload: {} })).status).not.toBe(404);
  });

  it('…can create only food trips', async () => {
    expect((await api('POST', '/api/trips', { ...as(food), payload: sampleTrip() })).status).toBe(403);
    const ok = await api('POST', '/api/trips', { ...as(food), payload: sampleTrip({ tripType: 'hospital_food', callerName: null, callerPhone: null }) });
    expect(ok.status).toBe(201);
  });

  it('…is kept out of other departments’ whole areas', async () => {
    expect((await api('GET', '/api/equipment/loans', as(food))).status).toBe(403);
    expect((await api('GET', '/api/recurring-rides', as(food))).status).toBe(403);
    expect((await api('GET', '/api/callers', as(food))).status).toBe(403);
    expect((await api('GET', '/api/impact', as(food))).status).toBe(403);
    // Shared tools stay open to everyone.
    expect((await api('GET', '/api/contacts', as(food))).status).toBe(200);
    expect((await api('GET', '/api/duty', as(food))).status).toBe(200);
  });

  it('admins and volunteers are never restricted by departments', async () => {
    await db.execute(raw`insert into department_members (department_id, user_id) select id, ${admin.id} from departments where slug = 'food'`);
    expect(await boardIds(admin)).toEqual([rideId, foodId].sort());
    expect((await api('GET', '/api/equipment', as(volunteer))).status).toBe(200);
  });

  it('two departments add up', async () => {
    await api('PUT', '/api/departments/rides/members', { ...as(admin), payload: { userIds: [food.id] } });
    expect(await boardIds(food)).toEqual([rideId, foodId].sort());
  });

  it('only admins manage membership, only coordinators can be members, and every change is audited', async () => {
    expect((await api('PUT', '/api/departments/food/members', { ...as(food), payload: { userIds: [] } })).status).toBe(403);
    expect((await api('PUT', '/api/departments/food/members', { ...as(admin), payload: { userIds: [volunteer.id] } })).status).toBe(422);
    await api('PUT', '/api/departments/food/members', { ...as(admin), payload: { userIds: [open.id] } });
    const audit = await db.execute<{ action: string; entity_id: string }>(raw`
      select action, entity_id from audit_events where action like 'department.%'`);
    expect(audit.map((a) => `${a.action} ${a.entity_id}`).sort()).toEqual([
      `department.member_added ${food.id}`,
      `department.member_added ${open.id}`,
      `department.member_removed ${food.id}`,
    ].sort());
    const list = await api('GET', '/api/departments', as(admin));
    const foodDept = (list.body.departments as Array<{ slug: string; members: Array<{ id: string }> }>).find((d) => d.slug === 'food');
    expect(foodDept!.members.map((m) => m.id)).toEqual([open.id]);
    // Removed from every department: back to today's access.
    expect(await boardIds(food)).toEqual([rideId, foodId].sort());
  });
});

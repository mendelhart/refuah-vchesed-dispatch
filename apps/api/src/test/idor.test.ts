import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { availabilityExceptions, notifications } from '../db/schema.js';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';

/**
 * Spec §8: object-level authorization (IDOR/BOLA). Every check here is on the
 * server; the web app hiding a button proves nothing.
 */
describe('object-level authorization', () => {
  let admin: TestUser;
  let dispatcher: TestUser;
  let a: TestUser;
  let b: TestUser;
  let tripId: string;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin', groups: [] });
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    a = await createTestUser({ role: 'volunteer' });
    b = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    tripId = (created.body.trip as { id: string }).id;
  });

  it("volunteer B cannot read volunteer A's trip once A has it, and learns nothing about the caller", async () => {
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect((await api('POST', `/api/trips/${tripId}/claim`, { cookie: a.cookie, payload: {} })).status).toBe(200);
    const res = await api('GET', `/api/trips/${tripId}`, { cookie: b.cookie });
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/Sara Klein|555-9001|1234 Avenue Bernard/);
    const hist = await api('GET', `/api/trips/${tripId}/history`, { cookie: b.cookie });
    expect(hist.status).toBe(403);
  });

  it('altered or invented ids get nothing', async () => {
    const fake = randomUUID();
    for (const path of [`/api/trips/${fake}`, `/api/files/${fake}`, `/api/callers/${fake}`, `/api/conversations/${fake}`,
      `/api/recurring-rides/${fake}`, `/api/applications/${fake}`, `/api/exports/${fake}/download`]) {
      const res = await api('GET', path, { cookie: a.cookie });
      expect([403, 404], path).toContain(res.status);
    }
    const bad = await api('POST', '/api/offers/accept', { cookie: a.cookie, payload: { code: 'ZZZZZZZZZZ' } });
    expect(bad.status).toBe(409);
  });

  it('volunteers cannot read audit, delivery or SMS logs', async () => {
    for (const path of ['/api/audit', '/api/notifications/deliveries', '/api/sms-events']) {
      expect((await api('GET', path, { cookie: a.cookie })).status, path).toBe(403);
    }
  });

  it('coordinators cannot reach exports, files or view-as (admin only)', async () => {
    expect((await api('GET', '/api/exports', { cookie: dispatcher.cookie })).status).toBe(403);
    expect((await api('GET', `/api/exports/${randomUUID()}/download`, { cookie: dispatcher.cookie })).status).toBe(403);
    expect((await api('GET', `/api/files/${randomUUID()}`, { cookie: dispatcher.cookie })).status).toBe(403);
    expect((await api('POST', `/api/admin/view-as/${a.id}`, { cookie: dispatcher.cookie, payload: {} })).status).toBe(403);
  });

  it("one volunteer cannot mark read or see another's notifications", async () => {
    const [n] = await db.insert(notifications)
      .values({ userId: b.id, event: 'test', title: 'For B only', body: 'private' }).returning();
    const list = await api('GET', '/api/notifications', { cookie: a.cookie });
    expect(JSON.stringify(list.body)).not.toMatch(/For B only/);
    await api('POST', '/api/notifications/read', { cookie: a.cookie, payload: { ids: [n!.id] } });
    const [after] = await db.select().from(notifications).where(eq(notifications.id, n!.id));
    expect(after!.readAt).toBeNull();
  });

  it("one volunteer cannot delete another's availability exception", async () => {
    const made = await api('POST', '/api/me/availability/exceptions', {
      cookie: b.cookie,
      payload: { startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    });
    expect(made.status).toBe(201);
    const id = (made.body.exception as { id: string }).id;
    await api('DELETE', `/api/me/availability/exceptions/${id}`, { cookie: a.cookie });
    const rows = await db.select().from(availabilityExceptions).where(eq(availabilityExceptions.id, id));
    expect(rows).toHaveLength(1);
  });

  it('pausing a volunteer ends their existing session at once', async () => {
    const r = await api('POST', `/api/users/${a.id}/suspend`, { cookie: dispatcher.cookie, payload: { reason: 'away' } });
    expect(r.status).toBe(200);
    expect((await api('GET', '/api/trips?scope=mine', { cookie: a.cookie })).status).toBe(401);
  });

  it('a volunteer cannot edit, pause or message other people', async () => {
    expect((await api('PATCH', `/api/users/${b.id}`, { cookie: a.cookie, payload: { fullName: 'x' } })).status).toBe(403);
    expect((await api('POST', `/api/users/${b.id}/suspend`, { cookie: a.cookie, payload: {} })).status).toBe(403);
    expect((await api('POST', `/api/users/${b.id}/message`, { cookie: a.cookie, payload: { body: 'hi' } })).status).toBe(403);
    expect((await api('POST', `/api/users/${a.id}/role`, { cookie: a.cookie, payload: { role: 'admin' } })).status).toBe(403);
    void admin;
  });
});

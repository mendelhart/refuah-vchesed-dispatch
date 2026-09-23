import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { api, createTestUser, getApp, resetDb, shutdown } from './harness.js';

/** Admin "View as": read-only, admin-only, audited. */
describe('view as', () => {
  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await resetDb(); });

  it('lets an admin see the app as a volunteer, and records it', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const volunteer = await createTestUser({ role: 'volunteer' });

    const start = await api('POST', `/api/admin/view-as/${volunteer.id}`, { cookie: admin.cookie });
    expect(start.status).toBe(200);
    const [row] = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, 'admin.view_as_started'), eq(auditEvents.entityId, volunteer.id)));
    expect(row?.actorUserId).toBe(admin.id);

    const me = await api('GET', '/api/auth/me', { cookie: admin.cookie, headers: { 'x-view-as': volunteer.id } });
    expect(me.status).toBe(200);
    expect((me.body.user as { id: string; role: string }).id).toBe(volunteer.id);
    expect((me.body.user as { role: string }).role).toBe('volunteer');
    expect((me.body.viewAsBy as { id: string }).id).toBe(admin.id);

    // Server-side permissions are the volunteer's, not the admin's.
    const board = await api('GET', '/api/settings', { cookie: admin.cookie, headers: { 'x-view-as': volunteer.id } });
    expect(board.status).toBe(403);
  });

  it('is read-only', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const volunteer = await createTestUser({ role: 'volunteer' });
    const res = await api('PATCH', '/api/me', {
      cookie: admin.cookie, headers: { 'x-view-as': volunteer.id }, payload: { fullName: 'Changed' },
    });
    expect(res.status).toBe(403);
  });

  it('is refused to non-admins and for admin targets', async () => {
    const dispatcher = await createTestUser({ role: 'dispatcher' });
    const volunteer = await createTestUser({ role: 'volunteer' });
    const otherAdmin = await createTestUser({ role: 'admin' });
    const admin = await createTestUser({ role: 'admin' });

    expect((await api('GET', '/api/auth/me', { cookie: dispatcher.cookie, headers: { 'x-view-as': volunteer.id } })).status).toBe(403);
    expect((await api('POST', `/api/admin/view-as/${volunteer.id}`, { cookie: dispatcher.cookie })).status).toBe(403);
    expect((await api('GET', '/api/auth/me', { cookie: admin.cookie, headers: { 'x-view-as': otherAdmin.id } })).status).toBe(403);
    expect((await api('POST', `/api/admin/view-as/${otherAdmin.id}`, { cookie: admin.cookie })).status).toBe(403);
  });
});

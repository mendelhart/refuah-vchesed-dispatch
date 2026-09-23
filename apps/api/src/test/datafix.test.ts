import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';

/** Admin > Data fixes: admin only, reason required, every change audited. */
describe('data fixes', () => {
  let admin: TestUser;
  let dispatcher: TestUser;
  let volunteer: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });

  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin', groups: [] });
    dispatcher = await createTestUser({ role: 'dispatcher' });
    volunteer = await createTestUser({ role: 'volunteer' });
  });

  async function finishedTrip(): Promise<{ id: string; reference: string }> {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    expect(created.status).toBe(201);
    const trip = created.body.trip as { id: string; reference: string };
    await api('POST', `/api/trips/${trip.id}/offer`, { cookie: dispatcher.cookie, payload: {} });
    const claimed = await api('POST', `/api/trips/${trip.id}/claim`, { cookie: volunteer.cookie, payload: {} });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    for (const step of ['en-route', 'start', 'complete']) {
      const res = await api('POST', `/api/trips/${trip.id}/${step}`, { cookie: volunteer.cookie, payload: {} });
      expect(res.status, `${step}: ${JSON.stringify(res.body)}`).toBe(200);
    }
    return trip;
  }

  it('is closed to coordinators', async () => {
    expect((await api('GET', '/api/admin/data-fixes/never-set-up', { cookie: dispatcher.cookie })).status).toBe(403);
    expect((await api('POST', `/api/admin/data-fixes/trips/${volunteer.id}/outcome`, {
      cookie: dispatcher.cookie, payload: { status: 'cancelled', reason: 'test' },
    })).status).toBe(403);
  });

  it('lists people invited over a week ago who never set a password', async () => {
    const stale = await createTestUser({ role: 'volunteer', name: 'Never Set Up' });
    const fresh = await createTestUser({ role: 'volunteer', name: 'Just Invited' });
    await db.execute(raw`update users set password_hash = null, created_at = now() - interval '10 days' where id = ${stale.id}`);
    await db.execute(raw`update users set password_hash = null where id = ${fresh.id}`);
    const res = await api('GET', '/api/admin/data-fixes/never-set-up', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const ids = (res.body.people as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);
  });

  it('corrects how a finished ride ended, with a reason, and audits it', async () => {
    const trip = await finishedTrip();
    const found = await api('GET', `/api/admin/data-fixes/trips/by-reference/${trip.reference.toLowerCase()}`, { cookie: admin.cookie });
    expect(found.status).toBe(200);
    expect(found.body.canCorrect).toBe(true);

    expect((await api('POST', `/api/admin/data-fixes/trips/${trip.id}/outcome`, {
      cookie: admin.cookie, payload: { status: 'cancelled', reason: '' },
    })).status).toBe(422);

    const fixed = await api('POST', `/api/admin/data-fixes/trips/${trip.id}/outcome`, {
      cookie: admin.cookie, payload: { status: 'cancelled', reason: 'Passenger was in hospital, ride never happened' },
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    const rows = (await db.execute(raw`select status, cancellation_reason from trips where id = ${trip.id}`)) as unknown as Array<{ status: string; cancellation_reason: string }>;
    expect(rows[0]!.status).toBe('cancelled');
    expect(rows[0]!.cancellation_reason).toContain('never happened');
    const audits = (await db.execute(raw`
      select count(*)::int as n from audit_events where action = 'trip.outcome_corrected' and entity_id = ${trip.id}
    `)) as unknown as Array<{ n: number }>;
    expect(audits[0]!.n).toBe(1);

    // And back again.
    expect((await api('POST', `/api/admin/data-fixes/trips/${trip.id}/outcome`, {
      cookie: admin.cookie, payload: { status: 'completed', reason: 'It did happen after all' },
    })).status).toBe(200);
  });

  it('will not touch an open ride', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    expect((await api('POST', `/api/admin/data-fixes/trips/${tripId}/outcome`, {
      cookie: admin.cookie, payload: { status: 'completed', reason: 'should not work' },
    })).status).toBe(409);
  });
});

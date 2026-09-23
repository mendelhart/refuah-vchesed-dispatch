import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { endExpiredSuspensions } from '../domain/users.service.js';
import { db } from '../db/client.js';
import { handlers } from '../jobs/handlers/index.js';

/**
 * The timed housekeeping jobs. Each is run directly through the same handler
 * table the worker uses, against rows backdated with SQL, so the retention
 * windows promised in docs/SECURITY.md and on the /privacy page are checked.
 */
async function count(query: ReturnType<typeof raw>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

describe('timed jobs', () => {
  let admin: TestUser;
  let volunteer: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });

  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin', groups: [] });
    volunteer = await createTestUser({ role: 'volunteer' });
  });

  it('cleanup.retention ages out old notifications and wipes old call details, keeping recent ones', async () => {
    await db.execute(raw`
      insert into notifications (user_id, event, title, body, created_at) values
        (${volunteer.id}, 'test.old', 'Old', 'old', now() - interval '400 days'),
        (${volunteer.id}, 'test.new', 'New', 'new', now() - interval '2 days')
    `);
    await db.execute(raw`
      insert into calls (initiated_by_id, counterparty_type, authorization_basis, counterparty_name, destination_last4, started_at) values
        (${admin.id}, 'caller', 'test', 'Old Caller', '1111', now() - interval '400 days'),
        (${admin.id}, 'caller', 'test', 'New Caller', '2222', now() - interval '2 days')
    `);

    await handlers['cleanup.retention']({});

    expect(await count(raw`select count(*) as n from notifications where event = 'test.old'`)).toBe(0);
    expect(await count(raw`select count(*) as n from notifications where event = 'test.new'`)).toBe(1);
    // The old call row survives for counts, without the personal detail.
    expect(await count(raw`select count(*) as n from calls where counterparty_name is null and destination_last4 is null`)).toBe(1);
    expect(await count(raw`select count(*) as n from calls where counterparty_name = 'New Caller' and destination_last4 = '2222'`)).toBe(1);
    expect(await count(raw`select count(*) as n from calls`)).toBe(2);
  });

  it('cleanup.sessions removes sessions that expired over 30 days ago and leaves live ones', async () => {
    await db.execute(raw`
      insert into sessions (user_id, token_hash, expires_at) values
        (${volunteer.id}, 'jobs-test-old', now() - interval '31 days'),
        (${volunteer.id}, 'jobs-test-live', now() + interval '1 day')
    `);
    await handlers['cleanup.sessions']({});
    expect(await count(raw`select count(*) as n from sessions where token_hash = 'jobs-test-old'`)).toBe(0);
    expect(await count(raw`select count(*) as n from sessions where token_hash = 'jobs-test-live'`)).toBe(1);
  });

  it('cleanup.tokens deletes invite and reset tokens a week after they expire', async () => {
    await db.execute(raw`
      insert into auth_tokens (user_id, kind, token_hash, expires_at) values
        (${volunteer.id}, 'password_reset', 'jobs-tok-old', now() - interval '8 days'),
        (${volunteer.id}, 'password_reset', 'jobs-tok-recent', now() - interval '1 day'),
        (${volunteer.id}, 'invite', 'jobs-tok-live', now() + interval '3 days')
    `);
    await handlers['cleanup.tokens']({});
    expect(await count(raw`select count(*) as n from auth_tokens where token_hash = 'jobs-tok-old'`)).toBe(0);
    expect(await count(raw`select count(*) as n from auth_tokens where token_hash in ('jobs-tok-recent', 'jobs-tok-live')`)).toBe(2);
  });

  it('ends a pause once its date has passed, and leaves open-ended and future pauses alone', async () => {
    const past = await createTestUser({ role: 'volunteer' });
    const future = await createTestUser({ role: 'volunteer' });
    const openEnded = await createTestUser({ role: 'volunteer' });
    await db.execute(raw`update users set status = 'inactive', suspended_until = now() - interval '1 hour', suspension_reason = 'away' where id = ${past.id}`);
    await db.execute(raw`update users set status = 'inactive', suspended_until = now() + interval '3 days' where id = ${future.id}`);
    await db.execute(raw`update users set status = 'inactive', suspended_until = null where id = ${openEnded.id}`);

    expect(await endExpiredSuspensions()).toBe(1);
    const rows = (await db.execute(raw`
      select id, status, suspended_until, suspension_reason from users where id in (${past.id}, ${future.id}, ${openEnded.id})
    `)) as unknown as Array<{ id: string; status: string; suspended_until: unknown; suspension_reason: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(past.id)).toMatchObject({ status: 'active', suspended_until: null, suspension_reason: null });
    expect(byId.get(future.id)!.status).toBe('inactive');
    expect(byId.get(openEnded.id)!.status).toBe('inactive');
  });

  it('trip.escalate flags an unanswered offer once, audits it and tells the coordinators', async () => {
    const coordinator = await createTestUser({ role: 'dispatcher' });
    const created = await api('POST', '/api/trips', { cookie: coordinator.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    const offered = await api('POST', `/api/trips/${tripId}/offer`, { cookie: coordinator.cookie, payload: {} });
    expect((offered.body.trip as { status: string }).status).toBe('offered');

    await handlers['trip.escalate']({ tripId, round: 1 });
    await handlers['trip.escalate']({ tripId, round: 1 });

    expect(await count(raw`select escalation_count as n from trips where id = ${tripId}`)).toBe(1);
    expect(await count(raw`select count(*) as n from trips where id = ${tripId} and escalated_at is not null`)).toBe(1);
    expect(await count(raw`select count(*) as n from audit_events where action = 'trip.escalated' and entity_id = ${tripId}`)).toBe(1);
    expect(await count(raw`select count(*) as n from notifications where trip_id = ${tripId} and user_id = ${coordinator.id}`)).toBeGreaterThan(0);
  });

  it('trip.escalate does nothing once the ride has been taken', async () => {
    const coordinator = await createTestUser({ role: 'dispatcher' });
    const created = await api('POST', '/api/trips', { cookie: coordinator.cookie, payload: sampleTrip() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: coordinator.cookie, payload: {} });
    const claimed = await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });
    expect(claimed.status).toBe(200);

    await handlers['trip.escalate']({ tripId, round: 1 });
    expect(await count(raw`select count(*) as n from trips where id = ${tripId} and escalated_at is null`)).toBe(1);
  });

  it('the scans run cleanly on an empty day', async () => {
    for (const kind of ['licence.expiry_scan', 'duty.reminder_scan', 'equipment.due_scan', 'recurring.materialise'] as const) {
      await expect(handlers[kind]({}), kind).resolves.toBeUndefined();
    }
  });
});

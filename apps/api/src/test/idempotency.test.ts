import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { purgeExpiredIdempotencyKeys, settleClaim } from '../lib/idempotency.js';

/**
 * Idempotency: a double tap or a retried request does the work once.
 *
 * Exercised on POST /api/trips, the first route opted in, because a duplicate
 * ride is the most expensive duplicate this system can produce: two drivers,
 * one passenger.
 */

async function tripCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(raw`select count(*)::int as n from trips`);
  return rows[0]!.n;
}

function post(user: TestUser, key: string | undefined, payload: unknown) {
  return api('POST', '/api/trips', {
    cookie: user.cookie,
    payload,
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  });
}

describe('idempotency keys', () => {
  let dispatcher: TestUser;
  let other: TestUser;
  const original = env.IDEMPOTENCY_KEYS_ENABLED;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    env.IDEMPOTENCY_KEYS_ENABLED = true;
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    other = await createTestUser({ role: 'dispatcher', groups: [] });
  });
  afterEach(() => { env.IDEMPOTENCY_KEYS_ENABLED = original; });

  it('is off by default', () => {
    expect(original).toBe(false);
  });

  it('with the flag off, the header is ignored and behaviour is unchanged', async () => {
    env.IDEMPOTENCY_KEYS_ENABLED = false;
    const trip = sampleTrip();
    expect((await post(dispatcher, 'double-tap-0001', trip)).status).toBe(201);
    expect((await post(dispatcher, 'double-tap-0001', trip)).status).toBe(201);
    expect(await tripCount()).toBe(2);
    const stored = await db.execute(raw`select 1 from idempotency_keys`);
    expect(stored.length).toBe(0);
  });

  it('without a header, nothing changes even with the flag on', async () => {
    const trip = sampleTrip();
    await post(dispatcher, undefined, trip);
    await post(dispatcher, undefined, trip);
    expect(await tripCount()).toBe(2);
  });

  it('a double submit creates one trip and replays the first answer', async () => {
    const trip = sampleTrip();
    const first = await post(dispatcher, 'double-tap-0002', trip);
    const second = await post(dispatcher, 'double-tap-0002', trip);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.raw.headers['idempotent-replayed']).toBe('true');
    expect(first.raw.headers['idempotent-replayed']).toBeUndefined();
    expect((second.body.trip as { id: string }).id).toBe((first.body.trip as { id: string }).id);
    expect(await tripCount()).toBe(1);
  });

  it('simultaneous duplicates: exactly one trip, the rest replay or wait', async () => {
    const trip = sampleTrip();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => post(dispatcher, 'double-tap-0003', trip)),
    );
    expect(await tripCount()).toBe(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.filter((r) => r.status === 201 && !r.raw.headers['idempotent-replayed']).length).toBe(1);
  });

  it('the same key with a different request is refused, and does nothing', async () => {
    await post(dispatcher, 'double-tap-0004', sampleTrip());
    const changed = await post(dispatcher, 'double-tap-0004', sampleTrip({ callerName: 'Someone Else' }));
    expect(changed.status).toBe(422);
    expect(await tripCount()).toBe(1);
  });

  it('keys belong to one person: another user with the same key is not replayed', async () => {
    const trip = sampleTrip();
    await post(dispatcher, 'double-tap-0005', trip);
    const theirs = await post(other, 'double-tap-0005', trip);
    expect(theirs.status).toBe(201);
    expect(theirs.raw.headers['idempotent-replayed']).toBeUndefined();
    expect(await tripCount()).toBe(2);
  });

  it('a refused or invalid request does not use up the key: the corrected form goes through', async () => {
    const badTrip = { ...sampleTrip(), pickupAt: 'not a date' };
    expect((await post(dispatcher, 'double-tap-0006', badTrip)).status).toBe(422);
    expect((await db.execute(raw`select 1 from idempotency_keys`)).length).toBe(0);
    const fixed = await post(dispatcher, 'double-tap-0006', sampleTrip());
    expect(fixed.status).toBe(201);
    expect(fixed.raw.headers['idempotent-replayed']).toBeUndefined();
    expect(await tripCount()).toBe(1);
  });

  it('a request still running holds its key; a server error then releases it', async () => {
    const trip = sampleTrip();
    await post(dispatcher, 'double-tap-0012', trip);
    const hash = (await db.execute<{ request_hash: string }>(raw`select request_hash from idempotency_keys where key = 'double-tap-0012'`))[0]!.request_hash;
    const [claim] = await db.execute<{ id: string }>(raw`
      insert into idempotency_keys (user_id, key, method, route, request_hash, expires_at)
      values (${dispatcher.id}, 'double-tap-0007', 'POST', '/api/trips', ${hash}, now() + interval '1 hour')
      returning id`);
    expect((await post(dispatcher, 'double-tap-0007', trip)).status).toBe(409);

    await settleClaim(claim!.id, 500, JSON.stringify({ error: { code: 'internal_error' } }));
    expect((await db.execute(raw`select 1 from idempotency_keys where key = 'double-tap-0007'`)).length).toBe(0);
    const retry = await post(dispatcher, 'double-tap-0007', trip);
    expect(retry.status).toBe(201);
    expect(retry.raw.headers['idempotent-replayed']).toBeUndefined();
  });

  it('stores only successful JSON answers', async () => {
    const cases: Array<[number, unknown]> = [[403, '{}'], [404, '{}'], [409, '{}'], [422, '{}'], [429, '{}'], [500, '{}'], [200, Buffer.from('binary')]];
    for (const [code, payload] of cases) {
      const [row] = await db.execute<{ id: string }>(raw`
        insert into idempotency_keys (user_id, key, method, route, request_hash, expires_at)
        values (${dispatcher.id}, ${'settle-' + code + '-key'}, 'POST', '/x', 'h', now() + interval '1 hour')
        returning id`);
      await settleClaim(row!.id, code, payload);
      expect((await db.execute(raw`select 1 from idempotency_keys where id = ${row!.id}`)).length, String(code)).toBe(0);
    }
  });

  it('runs after the route guard: a refused person never claims a key', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const res = await post(volunteer, 'double-tap-0013', sampleTrip());
    expect(res.status).toBe(403);
    expect((await db.execute(raw`select 1 from idempotency_keys`)).length).toBe(0);
  });

  it('only routes that opt in take part; sign-in and password routes never do', async () => {
    const other = await api('POST', '/api/vehicles', {
      cookie: dispatcher.cookie, payload: { label: 'Van A' }, headers: { 'idempotency-key': 'double-tap-0014' },
    });
    expect(other.status).toBe(201);
    const pw = await api('POST', '/api/auth/change-password', {
      cookie: dispatcher.cookie, payload: { currentPassword: 'wrong-password-1', newPassword: 'AnotherPassword123!' },
      headers: { 'idempotency-key': 'double-tap-0015' },
    });
    expect(pw.status).toBeGreaterThanOrEqual(400);
    expect((await db.execute(raw`select 1 from idempotency_keys`)).length).toBe(0);
  });

  it('the daily cleanup removes every expired answer', async () => {
    await post(dispatcher, 'double-tap-0016', sampleTrip());
    await db.execute(raw`update idempotency_keys set expires_at = now() - interval '1 minute'`);
    expect(await purgeExpiredIdempotencyKeys()).toBe(1);
    expect((await db.execute(raw`select 1 from idempotency_keys`)).length).toBe(0);
  });

  it('a request that died mid-way is taken over after five minutes, once', async () => {
    const trip = sampleTrip();
    // A claim that never got its answer: the process was killed.
    const first = await post(dispatcher, 'double-tap-0008', trip);
    const hash = (await db.execute<{ request_hash: string }>(raw`select request_hash from idempotency_keys where key = 'double-tap-0008'`))[0]!.request_hash;
    await db.execute(raw`delete from trips`);
    await db.execute(raw`delete from idempotency_keys`);
    await db.execute(raw`
      insert into idempotency_keys (user_id, key, method, route, request_hash, claimed_at, expires_at)
      values (${dispatcher.id}, 'double-tap-0008', 'POST', '/api/trips', ${hash}, now() - interval '10 minutes', now() + interval '1 hour')`);
    expect(first.status).toBe(201);
    const retries = await Promise.all([post(dispatcher, 'double-tap-0008', trip), post(dispatcher, 'double-tap-0008', trip)]);
    expect(await tripCount()).toBe(1);
    expect(retries.map((r) => r.status).sort()).toEqual([201, 409].sort());
  });

  it('expired answers are not replayed and are purged', async () => {
    const trip = sampleTrip();
    await post(dispatcher, 'double-tap-0009', trip);
    await db.execute(raw`update idempotency_keys set expires_at = now() - interval '1 minute'`);
    const later = await post(dispatcher, 'double-tap-0009', trip);
    expect(later.status).toBe(201);
    expect(later.raw.headers['idempotent-replayed']).toBeUndefined();
    expect(await tripCount()).toBe(2);
    const rows = await db.execute(raw`select 1 from idempotency_keys where expires_at < now()`);
    expect(rows.length).toBe(0);
  });

  it('rejects a malformed key without running the request', async () => {
    const res = await post(dispatcher, 'short', sampleTrip());
    expect(res.status).toBe(422);
    expect(await tripCount()).toBe(0);
  });

  it('does not apply to anonymous requests or reads', async () => {
    const anon = await api('POST', '/api/trips', { payload: sampleTrip(), headers: { 'idempotency-key': 'double-tap-0010' } });
    expect(anon.status).toBe(401);
    const read = await api('GET', '/api/trips?scope=board', { cookie: dispatcher.cookie, headers: { 'idempotency-key': 'double-tap-0011' } });
    expect(read.status).toBe(200);
    const rows = await db.execute(raw`select 1 from idempotency_keys`);
    expect(rows.length).toBe(0);
  });
});

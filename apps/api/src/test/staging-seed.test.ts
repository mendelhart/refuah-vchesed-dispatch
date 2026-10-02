import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { createTestUser, getApp, resetDb, shutdown } from './harness.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { assertSafeStagingTarget, onlySyntheticPeople, seedStaging } from '../db/seed-staging.js';

/**
 * The staging seed fills a throwaway database with invented people. These
 * tests hold it to that: it must refuse anything that could be real.
 */
describe('staging seed guards', () => {
  const local = 'postgres://rvc:rvc@127.0.0.1:5432/rvc_staging';

  it('refuses production', () => {
    expect(() => assertSafeStagingTarget({ databaseUrl: local, nodeEnv: 'production' })).toThrow(/production/);
  });

  it('accepts a database on this machine or a compose service', () => {
    for (const host of ['localhost', '127.0.0.1', 'postgres', 'db']) {
      expect(() => assertSafeStagingTarget({ databaseUrl: `postgres://u:p@${host}:5432/x`, nodeEnv: 'development' })).not.toThrow();
    }
  });

  it('refuses a remote host unless that exact host is allowed', () => {
    const remote = 'postgres://u:p@pg-abc.example-cloud.com:12345/defaultdb?sslmode=verify-full';
    expect(() => assertSafeStagingTarget({ databaseUrl: remote, nodeEnv: 'development' })).toThrow(/not this machine/);
    expect(() => assertSafeStagingTarget({ databaseUrl: remote, nodeEnv: 'development', allowHost: 'other.example.com' })).toThrow();
    expect(() => assertSafeStagingTarget({ databaseUrl: remote, nodeEnv: 'development', allowHost: 'pg-abc.example-cloud.com' })).not.toThrow();
  });

  it('refuses a malformed URL', () => {
    expect(() => assertSafeStagingTarget({ databaseUrl: 'not a url', nodeEnv: 'development' })).toThrow(/valid URL/);
  });
});

describe('staging seed', () => {
  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await resetDb(); });

  it('refuses a database that holds a real-looking person, and writes nothing', async () => {
    await db.insert(users).values({ email: 'someone@gmail.com', fullName: 'Real Person', role: 'volunteer', phone: '+15145550000', status: 'active' });
    await expect(seedStaging()).rejects.toThrow(/not synthetic/);
    const rows = await db.execute<{ n: number }>(raw`select count(*)::int as n from users`);
    expect(rows[0]!.n).toBe(1);
  });

  it('counts a phone-only account, a real caller or a real passenger as real data', async () => {
    await db.insert(users).values({ fullName: 'No Email', role: 'volunteer', phone: '+14385551234', status: 'active' });
    await expect(seedStaging()).rejects.toThrow(/not synthetic/);
    await resetDb();
    await db.execute(raw`insert into callers (name, primary_phone) values ('Real Caller', '+14385550000')`);
    await expect(seedStaging()).rejects.toThrow(/not synthetic/);
    await resetDb();
    await db.execute(raw`insert into callers (name, primary_phone) values ('Fake Caller', '+15145550190')`);
    expect(await onlySyntheticPeople()).toBe(true);
  });

  it('refuses a database an earlier run left half-seeded', async () => {
    await seedStaging();
    await db.execute(raw`delete from vehicles where label = 'Staging car 2'`);
    await expect(seedStaging()).rejects.toThrow(/partly seeded/);
  });

  it('fills an empty database with invented people only, and is a no-op the second time', async () => {
    await createTestUser({ role: 'admin', groups: [] }); // @test.local counts as synthetic
    const first = await seedStaging();
    expect(first.skipped).toBe(false);
    expect(first.volunteers).toBe(40);
    expect(first.trips).toBeGreaterThan(60);

    const people = await db.execute<{ email: string; phone: string }>(raw`select email, phone from users`);
    for (const p of people) {
      expect(p.email.endsWith('.test') || p.email.endsWith('@test.local'), p.email).toBe(true);
      expect(p.phone, p.email).toMatch(/^\+1514555/);
    }
    const states = await db.execute<{ status: string }>(raw`select distinct status from trips order by 1`);
    expect(states.map((s) => s.status)).toEqual(expect.arrayContaining(['assigned', 'cancelled', 'completed', 'pending']));
    const overdue = await db.execute<{ n: number }>(raw`
      select count(*)::int as n from equipment_loans where returned_at is null and expected_return_at < now()`);
    expect(overdue[0]!.n).toBeGreaterThan(0);

    const before = await db.execute<{ n: number }>(raw`select count(*)::int as n from trips`);
    const second = await seedStaging();
    expect(second.skipped).toBe(true);
    const after = await db.execute<{ n: number }>(raw`select count(*)::int as n from trips`);
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

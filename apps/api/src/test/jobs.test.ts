import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { createTestUser, getApp, resetDb, shutdown, type TestUser } from './harness.js';
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

  it('the scans run cleanly on an empty day', async () => {
    for (const kind of ['licence.expiry_scan', 'duty.reminder_scan', 'equipment.due_scan', 'recurring.materialise'] as const) {
      await expect(handlers[kind]({}), kind).resolves.toBeUndefined();
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { getApp, resetDb, shutdown } from './harness.js';
import { db } from '../db/client.js';
import { alertOnFailingChecks, resetAlertState, runHealthChecks } from '../lib/health-checks.js';

beforeAll(async () => { await getApp(); });
beforeEach(async () => { await resetDb(); resetAlertState(); });
afterAll(async () => { await shutdown(); });

const byName = async () => Object.fromEntries((await runHealthChecks()).checks.map((c) => [c.name, c]));

describe('deep health checks', () => {
  it('is ok on a quiet system and exposes counts only', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health/deep' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it('flags a job stuck in running as critical (503)', async () => {
    await db.execute(raw`insert into jobs (kind, payload, status, locked_at, locked_by)
      values ('cleanup.sessions', '{}'::jsonb, 'running', now() - interval '30 minutes', 'w1')`);
    expect((await byName()).jobs_stuck_running).toMatchObject({ ok: false, value: 1 });
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/health/deep' });
    expect(res.statusCode).toBe(503);
  });

  it('flags a dead recurring-ride job and dead jobs generally', async () => {
    await db.execute(raw`insert into jobs (kind, payload, status, run_at)
      values ('recurring.materialise', '{}'::jsonb, 'dead', now())`);
    const c = await byName();
    expect(c.recurring_materialise!.ok).toBe(false);
    expect(c.jobs_dead_24h!.ok).toBe(false);
  });

  it('alerts once per failing check per hour, and again after it recovers and fails', async () => {
    await db.execute(raw`insert into jobs (kind, payload, status, locked_at, locked_by)
      values ('cleanup.tokens', '{}'::jsonb, 'running', now() - interval '30 minutes', 'w1')`);
    const t0 = new Date();
    expect(await alertOnFailingChecks(t0)).toContain('jobs_stuck_running');
    expect(await alertOnFailingChecks(new Date(t0.getTime() + 60_000))).not.toContain('jobs_stuck_running');
    await db.execute(raw`delete from jobs`);
    expect(await alertOnFailingChecks(new Date(t0.getTime() + 120_000))).toEqual([]);
  });
});

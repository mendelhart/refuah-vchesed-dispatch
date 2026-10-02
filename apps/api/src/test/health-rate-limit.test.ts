import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { api, getApp, resetDb, shutdown } from './harness.js';

/**
 * /health must never be throttled. The rate limiter keeps its counters in
 * Postgres, so when it ran in front of /health a database outage turned the
 * documented 503 into a 500 (scripts/outage-drill.sh, step 1). An uptime
 * monitor polling every minute must also never be told 429.
 */
describe('health is outside the rate limiter', () => {
  beforeAll(async () => { await getApp(); await resetDb(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await db.execute(raw`truncate rate_limit_buckets`); });

  it('answers more requests than the global limit allows, all 200', async () => {
    const codes = new Set<number>();
    for (let i = 0; i < 320; i++) codes.add((await api('GET', '/health')).status);
    expect([...codes]).toEqual([200]);
  });

  it('/health/deep, which runs many queries, is still limited', async () => {
    let limited = false;
    for (let i = 0; i < 320 && !limited; i++) {
      if ((await api('GET', '/health/deep')).status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it('ordinary API routes are still limited', async () => {
    let limited = false;
    for (let i = 0; i < 320 && !limited; i++) {
      if ((await api('GET', '/api/public/signup-options')).status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { handlers } from '../jobs/handlers/index.js';
import { Worker } from '../jobs/worker.js';
import { enqueue, claimJobs } from '../jobs/queue.js';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown } from './harness.js';
import { endExpiredSuspensions } from '../domain/users.service.js';

beforeAll(async () => { await getApp(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

describe('timed catch-up', () => {
  it('fake-clock time advances pause expiry without waiting for a real timer', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const volunteer = await createTestUser({ role: 'volunteer' });
    const until = new Date(Date.now() + 60_000);
    await api('POST', `/api/users/${volunteer.id}/suspend`, { cookie: admin.cookie, payload: { until: until.toISOString(), reason: 'test' } });
    expect(await endExpiredSuspensions()).toBe(0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(until.getTime() + 1));
    try { expect(await endExpiredSuspensions()).toBe(1); } finally { vi.useRealTimers(); }
  });

  it('overdue offer jobs are eligible immediately after wake; future jobs stay pending', async () => {
    const old = await enqueue('cleanup.sessions', {}, { runAt: new Date(Date.now() - 3_600_000) });
    const future = await enqueue('cleanup.tokens', {}, { runAt: new Date(Date.now() + 3_600_000) });
    const claimed = await claimJobs('wake-test', 10);
    expect(claimed.map((job) => job.id)).toContain(old);
    expect(claimed.map((job) => job.id)).not.toContain(future);
  });

  it('drains persisted expired offers after a simulated sleeping interval', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: admin.cookie, payload: sampleTrip() });
    const id = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${id}/offer`, { cookie: admin.cookie, payload: { expiresInMinutes: 1 } });
    await db.execute(raw`update trip_offers set offered_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where trip_id = ${id}`);
    await db.execute(raw`update jobs set run_at = now() - interval '1 minute' where kind = 'offer.expire'`);
    await new Worker().drain();
    const rows = await db.execute(raw`select count(*)::int as n from trip_offers where trip_id = ${id} and status = 'pending'`);
    expect([...rows][0]?.n).toBe(0);
  });

  it('fake-clock advances offer expiry, reminders and escalation without stale nudges', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: admin.cookie, payload: sampleTrip() });
    const id = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${id}/offer`, { cookie: admin.cookie, payload: { expiresInMinutes: 10 } });
    const pending = await db.execute(raw`select id, expires_at from trip_offers where trip_id = ${id} and status = 'pending'`);
    expect(pending.length).toBeGreaterThan(0);
    const expiry = new Date(String(pending[0]!.expires_at));
    const { remindPendingOffers } = await import('../domain/dispatch.service.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(expiry.getTime() - 60_000));
      expect(await remindPendingOffers(id, 1)).toBeGreaterThan(0);
      await handlers['trip.escalate']({ tripId: id, round: 1 });
      const escalated = await db.execute(raw`select escalated_at from trips where id = ${id}`);
      expect(new Date(String(escalated[0]!.escalated_at)).getTime()).toBe(Date.now());
      vi.setSystemTime(new Date(expiry.getTime() + 1));
      expect(await remindPendingOffers(id, 1)).toBe(0);
      await new Worker().drain(20, true);
      const left = await db.execute(raw`select count(*)::int as n from trip_offers where trip_id = ${id} and status = 'pending'`);
      expect(left[0]!.n).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('reminder handler remains safe when offers are already expired', async () => {
    await expect(handlers['trip.reminder']({ tripId: crypto.randomUUID(), round: 1 })).resolves.toBeUndefined();
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { claimJobs, completeJob, enqueue, failJob, reclaimStalledJobs } from '../jobs/queue.js';
import { getApp, resetDb, shutdown } from './harness.js';

/** Spec §11: the Postgres queue under concurrency, crashes and retries. */
describe('job queue reliability', () => {
  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await resetDb(); });

  const job = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

  it('two workers claiming at once never get the same job', async () => {
    for (let i = 0; i < 20; i += 1) await enqueue('cleanup.sessions', { i });
    const [a, b] = await Promise.all([claimJobs('w-a', 15), claimJobs('w-b', 15)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(20);
  });

  it('a duplicate dedupe key is a no-op while the first is pending or running, allowed again after done', async () => {
    const first = await enqueue('cleanup.tokens', {}, { dedupeKey: 'k1' });
    expect(first).toBeTruthy();
    expect(await enqueue('cleanup.tokens', {}, { dedupeKey: 'k1' })).toBeNull();
    const [c] = await claimJobs('w', 5);
    expect(await enqueue('cleanup.tokens', {}, { dedupeKey: 'k1' })).toBeNull();
    await completeJob(c!.id, 'w');
    expect(await enqueue('cleanup.tokens', {}, { dedupeKey: 'k1' })).toBeTruthy();
  });

  it('retries with backoff, then goes dead after max attempts', async () => {
    const id = (await enqueue('cleanup.sessions', {}, { maxAttempts: 2 }))!;
    const [c1] = await claimJobs('w', 1);
    await failJob(c1!.id, new Error('boom'), c1!.attempts, c1!.maxAttempts, 'w');
    let j = await job(id);
    expect(j.status).toBe('pending');
    expect(j.runAt.getTime()).toBeGreaterThan(Date.now());
    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
    const [c2] = await claimJobs('w', 1);
    await failJob(c2!.id, new Error('boom'), c2!.attempts, c2!.maxAttempts, 'w');
    j = await job(id);
    expect(j.status).toBe('dead');
    expect(j.lastError).toBe('boom');
  });

  it('a worker crash mid-job: the job is reclaimed and runs again', async () => {
    const id = (await enqueue('cleanup.sessions', {}))!;
    await claimJobs('dead-worker', 1);
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 30 * 60_000) }).where(eq(jobs.id, id));
    expect(await reclaimStalledJobs(10)).toBe(1);
    const [again] = await claimJobs('w2', 1);
    expect(again!.id).toBe(id);
  });

  it('a job that crashes the worker on its last attempt goes dead instead of looping', async () => {
    const id = (await enqueue('cleanup.sessions', {}, { maxAttempts: 1 }))!;
    await claimJobs('dead-worker', 1);
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 30 * 60_000) }).where(eq(jobs.id, id));
    await reclaimStalledJobs(10);
    expect((await job(id)).status).toBe('dead');
    expect(await claimJobs('w2', 1)).toHaveLength(0);
  });

  it("a slow worker's late result cannot overwrite the run that reclaimed its job", async () => {
    const id = (await enqueue('cleanup.sessions', {}))!;
    await claimJobs('slow', 1);
    await db.update(jobs).set({ lockedAt: new Date(Date.now() - 30 * 60_000) }).where(eq(jobs.id, id));
    await reclaimStalledJobs(10);
    await claimJobs('fresh', 1);
    await completeJob(id, 'slow'); // the slow one finally returns
    const j = await job(id);
    expect(j.status).toBe('running');
    expect(j.lockedBy).toBe('fresh');
    await completeJob(id, 'fresh');
    expect((await job(id)).status).toBe('done');
  });
});

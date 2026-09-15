import { and, eq, lte, sql as raw } from 'drizzle-orm';
import type { JobKind } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { jobs } from '../db/schema.js';

/**
 * Background work runs on a Postgres-backed queue.
 *
 * Why not Redis/BullMQ/a hosted queue: the database is already the system of
 * record and already has to be backed up and available. `FOR UPDATE SKIP
 * LOCKED` gives safe multi-worker claiming, and one fewer service is one fewer
 * thing to operate, pay for and be locked into. At this volume (hundreds of
 * trips and a few thousand notifications a day) this is comfortably enough;
 * DEPLOYMENT.md records the signal that would justify moving.
 */

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  /** Makes the job at-most-once while pending/running. */
  dedupeKey?: string;
}

export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
  exec: Executor = db,
): Promise<string | null> {
  const [row] = await exec
    .insert(jobs)
    .values({
      kind,
      payload: payload as never,
      runAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? 10,
      dedupeKey: opts.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** Atomically claim up to `limit` due jobs for this worker. */
export async function claimJobs(workerId: string, limit: number): Promise<ClaimedJob[]> {
  const rows = await db.execute<{
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(raw`
    with claimed as (
      select id from jobs
      where status = 'pending' and run_at <= now()
      order by run_at
      for update skip locked
      limit ${limit}
    )
    update jobs j
       set status = 'running',
           locked_at = now(),
           locked_by = ${workerId},
           attempts = j.attempts + 1
      from claimed c
     where j.id = c.id
    returning j.id, j.kind, j.payload, j.attempts, j.max_attempts
  `);
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    kind: String(r.kind) as JobKind,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  }));
}

export async function completeJob(id: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'done', completedAt: new Date(), lockedAt: null, lockedBy: null, dedupeKey: null })
    .where(eq(jobs.id, id));
}

export async function failJob(
  id: string,
  error: unknown,
  attempts: number,
  maxAttempts: number,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const dead = attempts >= maxAttempts;
  // Exponential backoff, capped at an hour.
  const delaySeconds = Math.min(3600, 2 ** Math.min(attempts, 10) * 5);
  await db
    .update(jobs)
    .set({
      status: dead ? 'dead' : 'pending',
      lastError: message.slice(0, 2000),
      runAt: dead ? new Date() : new Date(Date.now() + delaySeconds * 1000),
      lockedAt: null,
      lockedBy: null,
      ...(dead ? { completedAt: new Date(), dedupeKey: null } : {}),
    })
    .where(eq(jobs.id, id));
}

/** Requeue jobs whose worker died mid-run. */
export async function reclaimStalledJobs(olderThanMinutes = 10): Promise<number> {
  const result = await db
    .update(jobs)
    .set({ status: 'pending', lockedAt: null, lockedBy: null })
    .where(
      and(
        eq(jobs.status, 'running'),
        lte(jobs.lockedAt, new Date(Date.now() - olderThanMinutes * 60_000)),
      ),
    )
    .returning({ id: jobs.id });
  return result.length;
}

export async function deadJobCount(): Promise<number> {
  const [row] = await db
    .select({ n: raw<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.status, 'dead'));
  return row?.n ?? 0;
}

import { workerHeartbeat } from '../lib/heartbeat.js';
import { captureException } from '../lib/monitoring.js';
import { alertOnFailingChecks } from '../lib/health-checks.js';
import { randomUUID } from 'node:crypto';
import { endExpiredSuspensions } from '../domain/users.service.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { claimJobs, completeJob, enqueue, failJob, reclaimStalledJobs } from './queue.js';
import { handlers } from './handlers/index.js';
import { localDateString } from '../lib/time.js';

/**
 * Background worker.
 *
 * Runs inside the API process by default (RUN_WORKER_IN_PROCESS) and can be
 * split onto its own machine without a code change. Nothing operationally
 * important depends on a browser being open — the defect that left the legacy
 * app with no expiry, no escalation and no retries at all.
 */
export class Worker {
  private readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private housekeeping: NodeJS.Timeout | null = null;
  private running = false;
  private starting = false;
  private stopping = false;

  start(): void {
    if (this.timer || this.starting) return;
    this.starting = true;
    logger.info({ worker: this.id }, 'background worker started');
    this.stopping = false;
    // Do not race normal polling with the ordered boot catch-up.
    void this.catchUp().finally(() => {
      this.starting = false;
      if (this.stopping) return;
      this.timer = setInterval(() => void this.tick(), env.WORKER_POLL_MS);
      this.housekeeping = setInterval(() => void this.runHousekeeping(), 5 * 60_000);
    });
  }

  /** Reclaim stale work and drain due jobs immediately after boot, not after the first timer. */
  async catchUp(): Promise<number> {
    await this.runHousekeeping();
    return this.drain(100, true);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.housekeeping) clearInterval(this.housekeeping);
    this.timer = null;
    this.housekeeping = null;
    // Let an in-flight batch finish so a job is not left 'running'.
    for (let i = 0; i < 50 && this.running; i += 1) await new Promise((r) => setTimeout(r, 100));
    logger.info({ worker: this.id }, 'background worker stopped');
  }

  /** Exposed for tests: drain the queue synchronously instead of waiting. */
  async drain(maxPasses = 20, sequential = false): Promise<number> {
    let processed = 0;
    for (let i = 0; i < maxPasses; i += 1) {
      const n = await this.tick(sequential);
      processed += n;
      if (n === 0) break;
    }
    return processed;
  }

  private async tick(sequential = false): Promise<number> {
    if (this.running || this.stopping) return 0;
    this.running = true;
    workerHeartbeat.lastTickAt = new Date();
    try {
      const jobs = await claimJobs(this.id, env.WORKER_CONCURRENCY);
      if (jobs.length === 0) return 0;
      const handle = async (job: (typeof jobs)[number]): Promise<void> => {
        const handler = handlers[job.kind];
        if (!handler) {
          await failJob(job.id, new Error(`no handler for ${job.kind}`), job.maxAttempts, job.maxAttempts, this.id);
          return;
        }
        try {
          await handler(job.payload);
          await completeJob(job.id, this.id);
        } catch (err) {
          logger.warn({ err, kind: job.kind, jobId: job.id, attempt: job.attempts }, 'job failed');
          await failJob(job.id, err, job.attempts, job.maxAttempts, this.id);
          if (job.attempts >= job.maxAttempts) {
            captureException(err, { source: 'job.dead', kind: job.kind, jobId: job.id, attempts: job.attempts });
          }
        }
      };
      if (sequential) { for (const job of jobs) await handle(job); }
      else await Promise.all(jobs.map(handle));
      return jobs.length;
    } catch (err) {
      captureException(err, { source: 'worker.tick' });
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async runHousekeeping(): Promise<void> {
    try {
      const reclaimed = await reclaimStalledJobs();
      if (reclaimed) logger.warn({ reclaimed }, 'reclaimed stalled jobs');
      await enqueue('cleanup.sessions', {}, { dedupeKey: 'cleanup:sessions' });
      await enqueue('cleanup.tokens', {}, { dedupeKey: 'cleanup:tokens' });
      await enqueue('cleanup.retention', {}, { dedupeKey: 'cleanup:retention' });

      /**
       * Recurring work.
       *
       * The dedupe key includes the local date, so each of these runs at most
       * once per day however often housekeeping ticks and however many API
       * processes are running. That is the whole scheduler: no cron, no extra
       * container, and no possibility of two machines materialising the same
       * standing ride because both believed they were the leader.
       */
      const resumed = await endExpiredSuspensions();
      if (resumed) logger.info({ resumed }, 'paused volunteers switched back on');
      const today = localDateString(new Date());
      await enqueue('recurring.materialise', {}, { dedupeKey: `recurring:${today}` });
      await enqueue('equipment.due_scan', {}, { dedupeKey: `equipment-due:${today}` });
      await enqueue('licence.expiry_scan', {}, { dedupeKey: `licence-expiry:${today}` });
      // Duty reminders need finer granularity than a day.
      const slot = Math.floor(Date.now() / (15 * 60_000));
      await enqueue('duty.reminder_scan', {}, { dedupeKey: `duty-reminder:${slot}` });
      workerHeartbeat.lastHousekeepingAt = new Date();
      await alertOnFailingChecks();
    } catch (err) {
      captureException(err, { source: 'worker.housekeeping' });
    }
  }
}

export const worker = new Worker();

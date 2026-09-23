/**
 * Operational checks a machine can alert on, so nobody has to read logs to
 * find out dispatch is broken.
 *
 * GET /health        - liveness only (the host restarts on failure). Unchanged.
 * GET /health/deep   - these checks. 200 when everything is ok, 503 when any
 *                      'critical' check fails, so a free uptime monitor
 *                      (UptimeRobot, Better Stack, cron-job.org) pointed at it
 *                      becomes the alert. Counts only, no personal data.
 *
 * The worker also runs these every housekeeping pass and reports each newly
 * failing check to the error aggregator (Sentry when SENTRY_DSN is set), at
 * most once an hour per check.
 */
import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { objectStore } from '../services/providers/index.js';
import { captureMessage } from './monitoring.js';
import { workerHeartbeat } from './heartbeat.js';

export interface HealthCheck {
  name: string;
  ok: boolean;
  severity: 'critical' | 'warning';
  value: number | string | null;
  detail: string;
}

export const THRESHOLDS = {
  workerSilentMinutes: 5,
  stuckRunningMinutes: 15,
  deadJobs24h: 1,
  deliveryFailures1h: 10,
  signatureFailures1h: 20,
  overdueUnassignedMinutes: 15,
};

async function count(q: ReturnType<typeof raw>): Promise<number> {
  const rows = await db.execute<{ n: string | number }>(q);
  return Number([...rows][0]?.n ?? 0);
}

export async function runHealthChecks(now = new Date()): Promise<{ status: 'ok' | 'degraded' | 'down'; checks: HealthCheck[] }> {
  const checks: HealthCheck[] = [];
  const add = (c: HealthCheck) => checks.push(c);

  try {
    await db.execute(raw`select 1`);
    add({ name: 'database', ok: true, severity: 'critical', value: null, detail: 'reachable' });
  } catch {
    add({ name: 'database', ok: false, severity: 'critical', value: null, detail: 'unreachable' });
    return { status: 'down', checks };
  }

  if (env.RUN_WORKER_IN_PROCESS) {
    const last = workerHeartbeat.lastTickAt;
    const silentMin = last ? (now.getTime() - last.getTime()) / 60_000 : null;
    const ok = silentMin !== null && silentMin <= THRESHOLDS.workerSilentMinutes;
    add({ name: 'worker', ok, severity: 'critical', value: silentMin === null ? null : Math.round(silentMin),
      detail: ok ? 'ticking' : `no worker tick for > ${THRESHOLDS.workerSilentMinutes} min` });
  }

  const stuck = await count(raw`select count(*) as n from jobs where status = 'running'
    and locked_at < ${new Date(now.getTime() - THRESHOLDS.stuckRunningMinutes * 60_000).toISOString()}::timestamptz`);
  add({ name: 'jobs_stuck_running', ok: stuck === 0, severity: 'critical', value: stuck,
    detail: `jobs running for more than ${THRESHOLDS.stuckRunningMinutes} min` });

  const dead = await count(raw`select count(*) as n from jobs where status = 'dead'
    and coalesce(completed_at, run_at) > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`);
  add({ name: 'jobs_dead_24h', ok: dead < THRESHOLDS.deadJobs24h, severity: 'warning', value: dead,
    detail: 'jobs that exhausted their retries in the last 24h (includes recurring ride materialisation)' });

  const recurringDead = await count(raw`select count(*) as n from jobs where status = 'dead'
    and kind = 'recurring.materialise' and run_at > ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`);
  add({ name: 'recurring_materialise', ok: recurringDead === 0, severity: 'critical', value: recurringDead,
    detail: 'standing rides failed to be created for today' });

  const failedDeliveries = await count(raw`select count(*) as n from notification_deliveries
    where status = 'failed' and failed_at > ${new Date(now.getTime() - 3_600_000).toISOString()}::timestamptz`);
  add({ name: 'delivery_failures_1h', ok: failedDeliveries < THRESHOLDS.deliveryFailures1h, severity: 'warning',
    value: failedDeliveries, detail: 'failed notification deliveries (SMS, WhatsApp, push, email) in the last hour' });

  const badSigs = await count(raw`select count(*) as n from sms_events where outcome = 'rejected_signature'
    and created_at > ${new Date(now.getTime() - 3_600_000).toISOString()}::timestamptz`);
  add({ name: 'webhook_signature_failures_1h', ok: badSigs < THRESHOLDS.signatureFailures1h, severity: 'warning',
    value: badSigs, detail: 'inbound webhooks rejected for a bad signature in the last hour' });

  const overdue = await count(raw`select count(*) as n from trips where status in ('new', 'pending', 'offered')
    and pickup_at < ${new Date(now.getTime() + THRESHOLDS.overdueUnassignedMinutes * 60_000).toISOString()}::timestamptz
    and pickup_at > ${new Date(now.getTime() - 6 * 3_600_000).toISOString()}::timestamptz`);
  add({ name: 'trips_unassigned_near_pickup', ok: overdue === 0, severity: 'warning', value: overdue,
    detail: `rides with no volunteer and pickup within ${THRESHOLDS.overdueUnassignedMinutes} min (or already past)` });

  try {
    await objectStore.exists('health/probe');
    add({ name: 'object_storage', ok: true, severity: 'critical', value: objectStore.name, detail: 'reachable' });
  } catch {
    add({ name: 'object_storage', ok: false, severity: 'critical', value: objectStore.name, detail: 'unreachable' });
  }

  const critical = checks.some((c) => !c.ok && c.severity === 'critical');
  const warning = checks.some((c) => !c.ok);
  return { status: critical ? 'down' : warning ? 'degraded' : 'ok', checks };
}

const lastAlerted = new Map<string, number>();

/** Report each failing check to the aggregator, at most once an hour per check. */
export async function alertOnFailingChecks(now = new Date()): Promise<string[]> {
  const { checks } = await runHealthChecks(now);
  const fired: string[] = [];
  for (const c of checks) {
    if (c.ok) { lastAlerted.delete(c.name); continue; }
    const prev = lastAlerted.get(c.name);
    if (prev && now.getTime() - prev < 3_600_000) continue;
    lastAlerted.set(c.name, now.getTime());
    captureMessage(`health check failing: ${c.name}`, { check: c });
    fired.push(c.name);
  }
  return fired;
}

export function resetAlertState(): void {
  lastAlerted.clear();
}

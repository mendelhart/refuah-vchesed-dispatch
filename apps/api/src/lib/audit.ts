import type { Role } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { auditEvents } from '../db/schema.js';

/**
 * The audit trail.
 *
 * Two rules make this trustworthy, and both were missing before:
 *
 *  1. The actor comes from the authenticated session, never from the request
 *     body. `AuditActor` can only be built by the request pipeline or by the
 *     scheduler, so a client cannot claim to be someone else.
 *  2. Writes happen inside the same transaction as the change they describe.
 *     A state change that is committed but unlogged is impossible; if the audit
 *     insert fails, the state change rolls back with it.
 *
 * The table itself rejects UPDATE and DELETE (see migration 0001).
 */
export interface AuditActor {
  userId: string | null;
  name: string;
  role: Role | 'system';
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  name: 'Scheduler',
  role: 'system',
};

export interface AuditInput {
  actor: AuditActor;
  action: string;
  entityType: string;
  entityId: string;
  previous?: unknown;
  next?: unknown;
  metadata?: Record<string, unknown>;
}

/** Fields never copied into the audit trail, even as "previous"/"next". */
const SENSITIVE_KEYS = new Set([
  'passwordHash',
  'password_hash',
  'password',
  'tokenHash',
  'token_hash',
  'token',
  'offerToken',
  'p256dh',
  'auth',
]);

function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) continue;
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function recordAudit(input: AuditInput, exec: Executor = db): Promise<void> {
  await exec.insert(auditEvents).values({
    actorUserId: input.actor.userId,
    actorName: input.actor.name,
    actorRole: input.actor.role,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    previous: (scrub(input.previous) ?? null) as never,
    next: (scrub(input.next) ?? null) as never,
    metadata: (scrub(input.metadata ?? null) ?? null) as never,
    ip: input.actor.ip ?? null,
    userAgent: input.actor.userAgent ?? null,
    requestId: input.actor.requestId ?? null,
  });
}

/** Narrow a row down to the fields worth keeping in history. */
export function tripSnapshot(trip: Record<string, unknown> | null | undefined) {
  if (!trip) return null;
  const keys = [
    'id',
    'reference',
    'status',
    'priority',
    'assignmentMode',
    'assignedVolunteerId',
    'groupId',
    'pickupAt',
    'offerExpiresAt',
    'cancellationReason',
    'version',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in trip) out[k] = trip[k];
  return out;
}

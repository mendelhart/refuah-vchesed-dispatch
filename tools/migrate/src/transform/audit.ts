/**
 * Legacy AuditLog -> audit_events.
 *
 * =====================================================================
 * THESE ROWS ARE NOT EVIDENCE.
 * =====================================================================
 *
 * In the legacy app, AuditLog rows were written by the CLIENT. Equipment.jsx
 * calls `base44.entities.AuditLog.create({ ..., performed_by: user?.email })`
 * straight from the browser, which means any signed-in user could have written
 * any row, naming anyone as the actor, at any timestamp, describing any action.
 * The audit trail was forgeable by design.
 *
 * The new `audit_events` table is append-only and server-written, and the rest
 * of the product treats it as trustworthy — it is what you would show a
 * regulator or an insurer. Importing forgeable rows into it without marking
 * them would quietly poison that guarantee: a row written by a volunteer in
 * 2024 would be indistinguishable from one the server wrote yesterday.
 *
 * So every imported row is marked, three ways, and none of them is cosmetic:
 *
 *   1. `actorRole` is 'system'. Not the claimed role. The only entity we can
 *      truthfully say performed this insert is the migration itself.
 *   2. `actorUserId` is NULL — always, even when `performed_by` resolves
 *      cleanly to a person we imported. Populating the foreign key is what
 *      makes an audit row count as attribution, and we cannot attribute a
 *      claim the old system never verified. The resolved person is recorded in
 *      `metadata.claimedActor` instead, where it reads as a claim.
 *   3. `actorName` is suffixed '(claimed, legacy import)', so the bare string
 *      shown in any UI that renders actorName carries the caveat with it.
 *
 * `metadata.trustworthiness` states this in words, so that anyone querying the
 * table rather than reading this file still finds out.
 */
import type { LegacyAuditLog } from '../types.js';
import { IssueCollector, type SkippedRecord } from '../issues.js';
import type { TargetAuditEvent } from '../target.js';
import * as N from '../normalize.js';

export interface AuditResult {
  events: TargetAuditEvent[];
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

/** The exact marker written on every imported row. Asserted by the tests. */
export const LEGACY_AUDIT_MARKER = {
  source: 'base44',
  legacyImported: true,
  clientAsserted: true,
  trustworthiness:
    'UNVERIFIED. Legacy Base44 AuditLog rows were created by the client (see ' +
    'Equipment.jsx, which posts AuditLog.create from the browser with a ' +
    'caller-supplied performed_by). Any signed-in user could forge the actor, ' +
    'the action and the timestamp. Do not rely on these rows as evidence of who ' +
    'did what; they are retained for operational continuity only.',
} as const;

const ACTOR_NAME_SUFFIX = ' (claimed, legacy import)';

export function transformAudit(input: {
  logs: LegacyAuditLog[];
  /** Legacy id -> person key, used only to annotate the claim, never to attribute. */
  byLegacyId: ReadonlyMap<string, string>;
  byEmail: ReadonlyMap<string, string>;
}): AuditResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];
  const events: TargetAuditEvent[] = [];

  for (const l of input.logs) {
    const action = N.text(l.action);
    const entityType = N.text(l.entity_type);
    const entityId = N.text(l.entity_id);

    if (action === null || entityType === null || entityId === null) {
      const missing = [
        action === null ? 'action' : null,
        entityType === null ? 'entity_type' : null,
        entityId === null ? 'entity_id' : null,
      ]
        .filter((x): x is string => x !== null)
        .join(', ');
      const reason =
        `Audit row is missing ${missing}; \`audit_events.action\`, \`.entity_type\` and ` +
        '`.entity_id` are all NOT NULL. A row that does not say what happened to what is not ' +
        'an audit record.';
      skipped.push({ entity: 'AuditLog', legacyId: l.id, reason, code: 'missing_required_field' });
      issues.error('missing_required_field', 'AuditLog', l.id, reason);
      continue;
    }

    const occurredAt = N.timestamp(l.created_date).value;
    if (occurredAt === null) {
      const reason =
        `Audit row has no parsable created_date (${JSON.stringify(N.text(l.created_date))}); ` +
        '`audit_events.occurred_at` is NOT NULL and stamping it with the migration time would ' +
        'assert an event happened when it did not.';
      skipped.push({ entity: 'AuditLog', legacyId: l.id, reason, code: 'unparsable_timestamp' });
      issues.error('unparsable_timestamp', 'AuditLog', l.id, reason, { field: 'occurredAt' });
      continue;
    }

    // Resolve the claimed actor — for the record only. See the header comment:
    // this NEVER becomes actorUserId.
    const claimedEmail = N.emailKey(l.performed_by);
    const claimedName = N.text(l.performed_by_name);
    const resolvedKey =
      (claimedEmail !== null ? input.byEmail.get(claimedEmail) : undefined) ??
      (N.text(l.performed_by) !== null
        ? input.byLegacyId.get(N.text(l.performed_by)!)
        : undefined) ??
      null;

    if (claimedEmail !== null && resolvedKey === null) {
      issues.warn(
        'actor_unresolved',
        'AuditLog',
        l.id,
        `Audit row claims performed_by=${claimedEmail}, which matches no imported person. ` +
          `This changes nothing about how the row is imported — legacy audit rows are never ` +
          `attributed to a user — but it is worth knowing that the claimed actor does not exist.`,
        { detail: { claimedActor: claimedEmail } },
      );
    }

    const actorName =
      (claimedName ?? N.text(l.performed_by) ?? 'unknown actor') + ACTOR_NAME_SUFFIX;

    events.push({
      legacyId: l.id,
      legacyMeta: { legacyEntityType: entityType, legacyEntityId: entityId },
      occurredAt,
      // Non-negotiable: see the header comment.
      actorUserId: null,
      actorName,
      actorRole: 'system',
      action,
      entityType,
      entityId,
      previous: l.previous_value ?? null,
      next: l.new_value ?? null,
      metadata: {
        ...LEGACY_AUDIT_MARKER,
        legacyAuditId: l.id,
        claimedActor: {
          email: claimedEmail,
          name: claimedName,
          /** The person this claim would point at, if the claim were trusted. */
          resolvesTo: resolvedKey,
          verified: false,
        },
        description: N.text(l.description),
        legacyIpAddress: N.text(l.ip_address),
        legacyLocation: N.text(l.location),
      },
      // The legacy `ip_address` was also client-supplied, so it goes in metadata
      // above rather than into the `ip` column, which the new server populates
      // from the connection.
      ip: null,
    });
  }

  return { events, skipped, issues };
}

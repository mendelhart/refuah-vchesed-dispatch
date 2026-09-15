/**
 * The reconciliation report.
 *
 * The contract this file exists to honour: NOTHING IS DROPPED SILENTLY.
 * Every record present in the source is accounted for as imported, merged, or
 * skipped — and every skipped record is listed individually, by legacy id, with
 * the reason it was skipped, in a form an operator can act on. A count without
 * ids is not a reconciliation; it is a rounding error waiting to be discovered
 * six months later.
 *
 * Two artefacts, same content:
 *   reports/migration-report.md   — for a human to read and sign off
 *   reports/migration-report.json — for a machine to diff between runs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Issue, SkippedRecord } from './issues.js';
import type { MigrationPlan } from './transform/index.js';
import type { ReadResult } from './read.js';
import type { LoadResult } from './load.js';
import { LEGACY_ENTITY_NAMES } from './types.js';

export interface EntityReconciliation {
  entity: string;
  sourceCount: number;
  imported: number;
  /** Source rows folded into another row (the three-way person merge). */
  mergedDuplicates: number;
  skipped: number;
  invalid: number;
  conflicts: number;
  unresolvedReferences: number;
  /** sourceCount - imported - mergedDuplicates - skipped. Must be 0. */
  unaccounted: number;
}

export interface ReportData {
  generatedAt: string;
  source: string;
  dryRun: boolean;
  committed: boolean;
  summary: {
    sourceRows: number;
    importedRows: number;
    skippedRows: number;
    errors: number;
    warnings: number;
    infos: number;
  };
  reconciliation: EntityReconciliation[];
  mergePrecedence: string[];
  skipped: SkippedRecord[];
  issues: Issue[];
  load: LoadResult | null;
  callIdCollisions: Array<{ callId: string; legacyTripIds: string[] }>;
}

// ---------------------------------------------------------------------------

const CONFLICT_CODES = new Set(['field_conflict', 'phone_collision', 'duplicate_email_collision']);
const UNRESOLVED_CODES = new Set([
  'trip_unresolved_assignee',
  'directory_entry_unresolved',
  'equipment_category_unresolved',
  'actor_unresolved',
]);

export function buildReport(input: {
  read: ReadResult;
  plan: MigrationPlan;
  load: LoadResult | null;
  sourceDir: string;
  dryRun: boolean;
}): ReportData {
  const { read, plan } = input;
  const issues = [...read.issues.all(), ...plan.issues];

  const reconciliation: EntityReconciliation[] = LEGACY_ENTITY_NAMES.map((entity) => {
    const sourceCount = read.sourceCounts[entity] ?? 0;
    const imported = plan.importedCounts[entity] ?? 0;
    const mergedDuplicates = plan.mergedCounts[entity] ?? 0;

    // Skips are counted ONLY for the entity itself. A sub-record skip — an
    // equipment loan that could not be reconstructed, say — is recorded under
    // `Equipment.loan`, and must not be counted against its parent item, which
    // was imported perfectly well. Those appear in the Skipped section below
    // and in their own row; they are not source rows, so they have no
    // denominator to reconcile against.
    const skipped = plan.skipped.filter((s) => s.entity === entity).length;

    // Issues, by contrast, DO roll up: an issue about a loan is an issue about
    // that piece of equipment, and the operator wants to see it on that line.
    const entityIssues = (issues as Array<Issue & { entity: string }>).filter(
      (i) => i.entity === entity || i.entity.startsWith(`${entity}.`),
    );

    return {
      entity,
      sourceCount,
      imported,
      mergedDuplicates,
      skipped,
      invalid: read.invalidCounts[entity] ?? 0,
      conflicts: entityIssues.filter((i) => CONFLICT_CODES.has(i.code)).length,
      unresolvedReferences: entityIssues.filter((i) => UNRESOLVED_CODES.has(i.code)).length,
      unaccounted: sourceCount - imported - mergedDuplicates - skipped,
    };
  });

  const summary = {
    sourceRows: reconciliation.reduce((n, r) => n + r.sourceCount, 0),
    importedRows: reconciliation.reduce((n, r) => n + r.imported + r.mergedDuplicates, 0),
    skippedRows: plan.skipped.length,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    infos: issues.filter((i) => i.severity === 'info').length,
  };

  return {
    generatedAt: new Date().toISOString(),
    source: input.sourceDir,
    dryRun: input.dryRun,
    committed: input.load?.committed ?? false,
    summary,
    reconciliation,
    mergePrecedence: ['User.data', 'User', 'Volunteer', 'PublicVolunteerDirectory'],
    skipped: plan.skipped,
    issues,
    load: input.load,
    callIdCollisions: [...plan.callIdCollisions.entries()].map(([callId, legacyTripIds]) => ({
      callId,
      legacyTripIds,
    })),
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  return [
    line(headers),
    `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ...rows.map(line),
  ].join('\n');
}

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(r: ReportData): string {
  const out: string[] = [];

  out.push('# Base44 → PostgreSQL migration report');
  out.push('');
  out.push(`- **Generated:** ${r.generatedAt}`);
  out.push(`- **Source:** \`${r.source}\``);
  out.push(
    `- **Mode:** ${r.dryRun ? '`--dry-run` (nothing committed)' : r.committed ? 'LIVE — committed' : 'LIVE — **not committed**'}`,
  );
  out.push('');

  // --- verdict ---
  if (r.summary.errors > 0) {
    out.push(
      `> **${r.summary.errors} error${r.summary.errors === 1 ? '' : 's'} must be resolved before this migration can be trusted.**`,
    );
    out.push('> The tool exits non-zero so it can gate a real migration.');
  } else {
    out.push('> No blocking errors. Every source record is accounted for below.');
  }
  out.push('');

  out.push('## Summary');
  out.push('');
  out.push(
    table(
      ['Metric', 'Count'],
      [
        ['Source rows read', String(r.summary.sourceRows)],
        ['Rows imported or merged', String(r.summary.importedRows)],
        ['Rows skipped (all listed below)', String(r.summary.skippedRows)],
        ['Errors', String(r.summary.errors)],
        ['Warnings', String(r.summary.warnings)],
        ['Notes', String(r.summary.infos)],
      ],
    ),
  );
  out.push('');

  // --- reconciliation ---
  out.push('## Reconciliation by entity');
  out.push('');
  out.push(
    'Every source row is imported, merged into another row, or skipped. ' +
      '`Unaccounted` must be zero; a non-zero value is a bug in this tool, not in the data.',
  );
  out.push('');
  out.push(
    table(
      [
        'Entity',
        'Source',
        'Imported',
        'Merged',
        'Skipped',
        'Invalid',
        'Conflicts',
        'Unresolved refs',
        'Unaccounted',
      ],
      r.reconciliation.map((e) => [
        e.entity,
        String(e.sourceCount),
        String(e.imported),
        String(e.mergedDuplicates),
        String(e.skipped),
        String(e.invalid),
        String(e.conflicts),
        String(e.unresolvedReferences),
        e.unaccounted === 0 ? '0' : `**${e.unaccounted}**`,
      ]),
    ),
  );
  out.push('');

  // --- merge rule ---
  out.push('## Identity merge precedence');
  out.push('');
  out.push(
    'One human existed as up to three legacy records (`User`, `Volunteer`, ' +
      '`PublicVolunteerDirectory`). For each field, the first source below holding a ' +
      'non-empty value wins:',
  );
  out.push('');
  r.mergePrecedence.forEach((p, i) => out.push(`${i + 1}. \`${p}\``));
  out.push('');
  out.push(
    'The nested `User.data` copy outranks the top-level columns because the legacy ' +
      'application itself read `u.data?.phone || u.phone` — so the nested value is the one ' +
      'dispatchers saw, the one the SMS webhook matched against, and the one the self-service ' +
      'screens wrote. `Volunteer` and `PublicVolunteerDirectory` rank below `User` because both ' +
      'are mechanically derived copies; the directory ranks last because `syncPublicDirectory` ' +
      'only ever copied top-level fields.',
  );
  out.push('');
  out.push(
    '**Precedence decides what is written, never what is reported.** Every divergence between ' +
      'two sources that both hold a value is listed under Conflicts below.',
  );
  out.push('');

  // --- skipped ---
  out.push('## Skipped records');
  out.push('');
  if (r.skipped.length === 0) {
    out.push('_None. Every source record was imported or merged._');
  } else {
    out.push(
      `${r.skipped.length} record${r.skipped.length === 1 ? '' : 's'} were not imported. ` +
        'Each is listed with its legacy id and the reason.',
    );
    out.push('');
    out.push(
      table(
        ['Entity', 'Legacy id', 'Reason'],
        r.skipped.map((s) => [s.entity, `\`${s.legacyId}\``, escapeCell(s.reason)]),
      ),
    );
  }
  out.push('');

  // --- issues by severity ---
  for (const [severity, heading, blurb] of [
    [
      'error',
      'Errors — resolve before migrating',
      'Data would be lost or wrong. The tool exits non-zero while any of these remain.',
    ],
    [
      'warning',
      'Warnings — decisions made on your behalf',
      'Data is preserved, but this tool chose between competing values or remapped a legacy ' +
        'concept. Review the ones that matter to you.',
    ],
    ['info', 'Notes', 'Bookkeeping: merges and reference re-issues that went exactly as designed.'],
  ] as const) {
    const list = r.issues.filter((i) => i.severity === severity);
    out.push(`## ${heading}`);
    out.push('');
    if (list.length === 0) {
      out.push('_None._');
      out.push('');
      continue;
    }
    out.push(blurb);
    out.push('');

    const grouped = new Map<string, Issue[]>();
    for (const i of list) grouped.set(i.code, [...(grouped.get(i.code) ?? []), i]);

    for (const [code, items] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
      out.push(`### \`${code}\` (${items.length})`);
      out.push('');
      out.push(
        table(
          ['Entity', 'Legacy id', 'Field', 'Detail'],
          items.map((i) => [
            i.entity,
            i.legacyId === null ? '—' : `\`${i.legacyId}\``,
            i.field ?? '—',
            escapeCell(i.message),
          ]),
        ),
      );
      out.push('');
    }
  }

  // --- call id collisions ---
  out.push('## Colliding legacy `call_id`s');
  out.push('');
  if (r.callIdCollisions.length === 0) {
    out.push('_None._');
  } else {
    out.push(
      'The legacy 4-digit `call_id` was generated as `Math.floor(1000 + Math.random()*9000)` ' +
        'with no uniqueness check, and the SMS accept path matched on it. Each trip below has ' +
        'been issued a fresh unique `trips.reference`; the legacy value survives only in the ' +
        'import ledger metadata.',
    );
    out.push('');
    out.push(
      table(
        ['Legacy call_id', 'Trips sharing it'],
        r.callIdCollisions.map((c) => [c.callId, c.legacyTripIds.map((i) => `\`${i}\``).join(', ')]),
      ),
    );
  }
  out.push('');

  // --- load ---
  if (r.load !== null) {
    out.push('## Database');
    out.push('');
    const tables = [
      ...new Set([...Object.keys(r.load.inserted), ...Object.keys(r.load.alreadyPresent)]),
    ].sort();
    out.push(
      table(
        ['Table', 'Inserted', 'Already present (idempotent skip)'],
        tables.map((t) => [
          t,
          String(r.load!.inserted[t] ?? 0),
          String(r.load!.alreadyPresent[t] ?? 0),
        ]),
      ),
    );
    out.push('');
    out.push(
      r.load.dryRun
        ? '_Dry run: every insert above was executed against the database so that constraints, ' +
            'unique indexes and foreign keys were genuinely exercised, then the transaction was ' +
            'rolled back. Nothing was committed._'
        : r.load.committed
          ? '_Committed in a single transaction._'
          : '_The transaction did not commit._',
    );
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    '_Legacy `AuditLog` rows are imported into `audit_events` with `actor_role = \'system\'`, ' +
      '`actor_user_id = NULL`, and metadata marking them client-asserted and unverified. In the ' +
      'legacy app any signed-in browser could write an audit row naming any actor, so these rows ' +
      'are retained for continuity and must not be treated as evidence._',
  );
  out.push('');

  return out.join('\n');
}

// ---------------------------------------------------------------------------

export interface WrittenReport {
  markdownPath: string;
  jsonPath: string;
}

export function writeReport(report: ReportData, reportDir: string): WrittenReport {
  mkdirSync(reportDir, { recursive: true });
  const markdownPath = join(reportDir, 'migration-report.md');
  const jsonPath = join(reportDir, 'migration-report.json');
  writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  return { markdownPath, jsonPath };
}

/** The compact table printed to the terminal at the end of a run. */
export function renderConsoleSummary(r: ReportData): string {
  const rows = r.reconciliation
    .filter((e) => e.sourceCount > 0 || e.imported > 0 || e.skipped > 0)
    .map((e) => [
      e.entity,
      String(e.sourceCount),
      String(e.imported),
      String(e.mergedDuplicates),
      String(e.skipped),
      String(e.conflicts),
      String(e.unresolvedReferences),
    ]);

  return [
    table(
      ['Entity', 'Source', 'Imported', 'Merged', 'Skipped', 'Conflicts', 'Unresolved'],
      rows,
    ),
    '',
    `errors ${r.summary.errors}   warnings ${r.summary.warnings}   notes ${r.summary.infos}`,
  ].join('\n');
}

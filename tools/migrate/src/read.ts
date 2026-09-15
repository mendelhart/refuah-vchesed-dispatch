/**
 * THE SOURCE ADAPTER.
 *
 * This is the only module in the tool that knows anything about how Base44
 * serialises an export. Everything downstream consumes `LegacyExport`, so
 * moving to a different export shape (a single combined JSON file, a SQL dump,
 * a live API pull) is a change to this file and nothing else.
 *
 * Accepted layouts, per entity:
 *   <dir>/Trip.json        — a JSON array, or `{ "records": [...] }`,
 *                            or `{ "Trip": [...] }`, or a single object
 *   <dir>/Trip.ndjson      — one JSON object per line
 *   <dir>/Trip.jsonl       — ditto
 *   <dir>/trip.json        — case-insensitive filename match
 *   <dir>/entities/Trip.json
 *   <dir>/export.json      — one combined file keyed by entity name
 *
 * Rows that fail their zod schema are not dropped: they are counted, reported
 * as `parse_failed` issues carrying whatever id could be recovered, and
 * excluded from the import so a real run exits non-zero.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodTypeAny } from 'zod';

import {
  LEGACY_ENTITIES,
  LEGACY_ENTITY_NAMES,
  emptyExport,
  type LegacyEntityName,
  type LegacyExport,
} from './types.js';
import { IssueCollector } from './issues.js';

export interface ReadResult {
  export: LegacyExport;
  /** Rows found in the source, before validation. Denominator for the report. */
  sourceCounts: Record<LegacyEntityName, number>;
  /** Rows that failed validation and are therefore not imported. */
  invalidCounts: Record<LegacyEntityName, number>;
  /** Where each entity was actually read from, for the report's provenance line. */
  sources: Partial<Record<LegacyEntityName, string>>;
  issues: IssueCollector;
}

const JSON_EXTENSIONS = ['.json', '.ndjson', '.jsonl'];

// ---------------------------------------------------------------------------
// Locating files
// ---------------------------------------------------------------------------

function listCandidateFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (JSON_EXTENSIONS.some((e) => name.toLowerCase().endsWith(e))) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

function fileMatchesEntity(path: string, entity: LegacyEntityName): boolean {
  const base = path.split('/').pop() ?? '';
  const stem = base.replace(/\.(json|ndjson|jsonl)$/i, '');
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(entity);
  // Accept 'Trip', 'trips', 'Trip.records', 'base44_Trip'.
  return norm(stem) === target || norm(stem) === `${target}s` || norm(stem).endsWith(target);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Pull an array of records out of whatever JSON/NDJSON envelope was used. */
function extractRecords(content: string, entity: LegacyEntityName): unknown[] | null {
  const trimmed = content.trim();
  if (trimmed === '') return [];

  // NDJSON: multiple lines, each independently valid JSON.
  if (!trimmed.startsWith('[') && trimmed.includes('\n')) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
    const parsed: unknown[] = [];
    let ok = true;
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        ok = false;
        break;
      }
    }
    if (ok) return parsed;
    // Fall through: it may be pretty-printed JSON that happens to contain newlines.
  }

  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return unwrap(doc, entity);
}

function unwrap(doc: unknown, entity: LegacyEntityName): unknown[] | null {
  if (Array.isArray(doc)) return doc;
  if (doc !== null && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>;
    for (const key of [entity, 'records', 'data', 'items', 'results', 'rows']) {
      const v = obj[key];
      if (Array.isArray(v)) return v;
    }
    // A single record, exported alone.
    if (typeof obj['id'] === 'string') return [obj];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function recoverId(row: unknown): string | null {
  if (row !== null && typeof row === 'object') {
    const id = (row as Record<string, unknown>)['id'];
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return null;
}

function validate<T>(
  rows: unknown[],
  schema: ZodTypeAny,
  entity: LegacyEntityName,
  issues: IssueCollector,
): { valid: T[]; invalid: number } {
  const valid: T[] = [];
  let invalid = 0;
  rows.forEach((row, index) => {
    const parsed = schema.safeParse(row);
    if (parsed.success) {
      valid.push(parsed.data as T);
      return;
    }
    invalid += 1;
    const id = recoverId(row);
    issues.error(
      'parse_failed',
      entity,
      id,
      id === null
        ? `Row ${index} of the ${entity} export could not be parsed and has no recoverable id; it is NOT imported.`
        : `${entity} ${id} failed schema validation and is NOT imported.`,
      { detail: { index, errors: parsed.error.issues.slice(0, 5) } },
    );
  });
  return { valid, invalid };
}

export function readLegacyExport(sourceDir: string): ReadResult {
  const issues = new IssueCollector();
  const result = emptyExport();
  const sourceCounts = {} as Record<LegacyEntityName, number>;
  const invalidCounts = {} as Record<LegacyEntityName, number>;
  const sources: Partial<Record<LegacyEntityName, string>> = {};

  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  const files = listCandidateFiles(sourceDir);

  // A single combined export file, if one is present, seeds every entity.
  const combined: Partial<Record<LegacyEntityName, unknown[]>> = {};
  const combinedPaths: Partial<Record<LegacyEntityName, string>> = {};
  for (const path of files) {
    const base = (path.split('/').pop() ?? '').toLowerCase();
    if (!/^(export|all|base44|backup)\b/.test(base)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const obj = doc as Record<string, unknown>;
    for (const entity of LEGACY_ENTITY_NAMES) {
      const v = obj[entity];
      if (Array.isArray(v)) {
        combined[entity] = v;
        combinedPaths[entity] = path;
      }
    }
  }

  for (const entity of LEGACY_ENTITY_NAMES) {
    let rows: unknown[] | null = combined[entity] ?? null;
    let from = combinedPaths[entity] ?? null;

    if (rows === null) {
      const match = files.find((f) => fileMatchesEntity(f, entity));
      if (match !== undefined) {
        const content = readFileSync(match, 'utf8');
        rows = extractRecords(content, entity);
        from = match;
        if (rows === null) {
          issues.error(
            'parse_failed',
            entity,
            null,
            `${match} is not valid JSON or NDJSON and could not be read. No ${entity} records were imported.`,
          );
          rows = [];
        }
      }
    }

    if (rows === null) {
      // Absent entirely. Not an error — a deployment may never have used it —
      // but it is recorded so the report shows a zero rather than a silence.
      sourceCounts[entity] = 0;
      invalidCounts[entity] = 0;
      continue;
    }

    sourceCounts[entity] = rows.length;
    if (from !== null) sources[entity] = from;

    const { valid, invalid } = validate(rows, LEGACY_ENTITIES[entity], entity, issues);
    invalidCounts[entity] = invalid;
    // Safe: `valid` was produced by this entity's own schema.
    (result[entity] as unknown[]) = valid;
  }

  return { export: result, sourceCounts, invalidCounts, sources, issues };
}

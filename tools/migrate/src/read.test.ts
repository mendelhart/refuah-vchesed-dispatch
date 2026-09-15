/**
 * The source adapter and the report's central guarantee.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readLegacyExport } from './read.js';
import { buildPlan } from './transform/index.js';
import { buildReport, renderMarkdown } from './report.js';
import { FIXTURE_DIR, fixtureExport, fixturePlan, readResult } from './fixtures.test-helpers.js';
import * as N from './normalize.js';

// ---------------------------------------------------------------------------

describe('source adapter', () => {
  it('reads a directory of per-entity JSON arrays', () => {
    const ex = fixtureExport();
    expect(ex.Trip).toHaveLength(8);
    expect(ex.User).toHaveLength(7);
    expect(ex.Volunteer).toHaveLength(4);
  });

  it('reads NDJSON as well as JSON', () => {
    expect(fixtureExport().MaskedCall).toHaveLength(4);
    expect(fixtureExport().MaskedCall[0]!.id).toBe('call_c01');
  });

  it('defaults an absent entity to an empty array rather than failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-empty-'));
    writeFileSync(join(dir, 'Trip.json'), '[]');
    const r = readLegacyExport(dir);
    expect(r.export.Equipment).toEqual([]);
    expect(r.sourceCounts.Equipment).toBe(0);
    expect(r.issues.errorCount).toBe(0);
  });

  it('ignores unknown fields and defaults missing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-tolerant-'));
    writeFileSync(
      join(dir, 'Trip.json'),
      JSON.stringify([
        { id: 't1', some_field_we_have_never_seen: { nested: true }, call_id: 9999 },
      ]),
    );
    const r = readLegacyExport(dir);
    expect(r.export.Trip).toHaveLength(1);
    // A numeric call_id is coerced to a string, not rejected.
    expect(r.export.Trip[0]!.call_id).toBe('9999');
    // An absent array field defaults to [].
    expect(r.export.Trip[0]!.mobility_needs).toEqual([]);
  });

  it('accepts a { records: [...] } envelope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-envelope-'));
    writeFileSync(join(dir, 'Contact.json'), JSON.stringify({ records: [{ id: 'c1', name: 'X', phone: '5145550000' }] }));
    expect(readLegacyExport(dir).export.Contact).toHaveLength(1);
  });

  it('finds entity files in a nested directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-nested-'));
    mkdirSync(join(dir, 'entities'));
    writeFileSync(join(dir, 'entities', 'Vehicle.json'), JSON.stringify([{ id: 'v1', name: 'Van' }]));
    expect(readLegacyExport(dir).export.Vehicle).toHaveLength(1);
  });

  it('reports an unparsable row instead of dropping it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rvc-bad-'));
    // `id` is the one required field; a row without it cannot be validated.
    writeFileSync(join(dir, 'Contact.json'), JSON.stringify([{ name: 'No id' }]));
    const r = readLegacyExport(dir);
    expect(r.export.Contact).toHaveLength(0);
    expect(r.invalidCounts.Contact).toBe(1);
    const issues = r.issues.all().filter((i) => i.code === 'parse_failed');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
  });

  it('records where each entity was read from', () => {
    const r = readResult();
    expect(r.sources.Trip).toContain('Trip.json');
    expect(r.sources.MaskedCall).toContain('MaskedCall.ndjson');
  });

  it('throws a clear error for a missing source directory', () => {
    expect(() => readLegacyExport('/definitely/not/here')).toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------

describe('phone normalisation', () => {
  it.each([
    ['(514) 555-0142', '+15145550142'],
    ['514-555-0142', '+15145550142'],
    ['5145550142', '+15145550142'],
    ['1-514-555-0142', '+15145550142'],
    ['+1 514 555 0142', '+15145550142'],
    ['+15145550142', '+15145550142'],
  ])('normalises %s to %s', (input, expected) => {
    expect(N.phone(input).e164).toBe(expected);
  });

  it.each([
    ['call the office ext 4', 'too_short'],
    ['514-555-0142 ext 12', 'too_long'],
    ['not a number at all', 'non_numeric'],
    ['0145550142', 'invalid_country'],
  ])('refuses to guess at %s (%s)', (input, reason) => {
    const r = N.phone(input);
    expect(r.e164).toBeNull();
    expect(r.reason).toBe(reason);
    // The original is always preserved.
    expect(r.raw).toBe(input);
  });

  it('never silently truncates an extension onto a valid-looking number', () => {
    // The legacy SMS webhook did `phone.replace(/\D/g,'').slice(-10)`, which
    // turns '514-555-0142 ext 12' into '5501 42 12' → the wrong person.
    expect(N.phone('514-555-0142 ext 12').e164).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the reconciliation report', () => {
  const report = () => {
    const read = readResult();
    const plan = buildPlan(read.export);
    return buildReport({ read, plan, load: null, sourceDir: FIXTURE_DIR, dryRun: true });
  };

  it('accounts for EVERY source row — nothing is dropped silently', () => {
    const r = report();
    for (const e of r.reconciliation) {
      expect(
        e.unaccounted,
        `${e.entity}: ${e.sourceCount} source rows, ${e.imported} imported, ` +
          `${e.mergedDuplicates} merged, ${e.skipped} skipped`,
      ).toBe(0);
    }
  });

  it('lists every skipped record individually, with its legacy id and a reason', () => {
    const r = report();
    expect(r.skipped.length).toBeGreaterThan(0);
    for (const s of r.skipped) {
      expect(s.legacyId).toBeTruthy();
      expect(s.reason.length).toBeGreaterThan(20);
      expect(s.entity).toBeTruthy();
    }
  });

  it('reports the documented merge precedence', () => {
    expect(report().mergePrecedence).toEqual([
      'User.data',
      'User',
      'Volunteer',
      'PublicVolunteerDirectory',
    ]);
  });

  it('every issue carries a legacy id, except those about a whole file', () => {
    const r = report();
    for (const i of r.issues) {
      if (i.legacyId === null) expect(i.code).toBe('parse_failed');
    }
  });

  it('surfaces conflicts and unresolved references per entity', () => {
    const r = report();
    const users = r.reconciliation.find((e) => e.entity === 'User')!;
    expect(users.conflicts).toBeGreaterThan(0);
    const trips = r.reconciliation.find((e) => e.entity === 'Trip')!;
    expect(trips.unresolvedReferences).toBeGreaterThan(0);
  });

  it('renders markdown containing every skipped legacy id', () => {
    const r = report();
    const md = renderMarkdown(r);
    for (const s of r.skipped) expect(md).toContain(s.legacyId);
  });

  it('renders the colliding call_id section', () => {
    const md = renderMarkdown(report());
    expect(md).toContain('Colliding legacy `call_id`s');
    expect(md).toContain('4821');
  });

  it('carries the audit-trustworthiness caveat into the rendered report', () => {
    const md = renderMarkdown(report());
    expect(md).toContain('client-asserted');
    expect(md).toContain('must not be treated as evidence');
  });

  it('counts errors so the CLI can gate a real migration', () => {
    const r = report();
    expect(r.summary.errors).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('plan integrity', () => {
  it('assigns a unique legacyId to every row within each target table', () => {
    const plan = fixturePlan();
    const check = (rows: Array<{ legacyId: string }>, label: string): void => {
      const ids = rows.map((r) => r.legacyId);
      expect(new Set(ids).size, `${label} has duplicate legacy ids`).toBe(ids.length);
    };
    check(plan.users, 'users');
    check(plan.trips, 'trips');
    check(plan.equipment, 'equipment');
    check(plan.equipmentLoans, 'equipmentLoans');
    check(plan.contacts, 'contacts');
    check(plan.vehicles, 'vehicles');
    check(plan.auditEvents, 'auditEvents');
    check(plan.calls, 'calls');
  });

  it('honours the one-open-loan-per-item unique index', () => {
    const plan = fixturePlan();
    const openPerItem = new Map<string, number>();
    for (const l of plan.equipmentLoans) {
      if (l.returnedAt === null) {
        openPerItem.set(l.equipmentLegacyId, (openPerItem.get(l.equipmentLegacyId) ?? 0) + 1);
      }
    }
    for (const [item, n] of openPerItem) expect(n, `${item} has ${n} open loans`).toBe(1);
  });

  it('honours the one-live-assignment-per-trip unique index', () => {
    const plan = fixturePlan();
    const livePerTrip = new Map<string, number>();
    for (const a of plan.tripAssignments) {
      if (a.unassignedAt === null) {
        livePerTrip.set(a.tripLegacyId, (livePerTrip.get(a.tripLegacyId) ?? 0) + 1);
      }
    }
    for (const [trip, n] of livePerTrip) expect(n, `${trip} has ${n} live assignments`).toBe(1);
  });

  it('produces globally unique user emails and trip references', () => {
    const plan = fixturePlan();
    const emails = plan.users.map((u) => u.email);
    expect(new Set(emails).size).toBe(emails.length);
    const refs = plan.trips.map((t) => t.reference);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('produces at most one live user per phone number', () => {
    const plan = fixturePlan();
    const phones = plan.users.map((u) => u.phone).filter((p): p is string => p !== null);
    expect(new Set(phones).size).toBe(phones.length);
  });
});

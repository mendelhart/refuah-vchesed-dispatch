/**
 * Equipment: turning loan state smeared across the item row into loan rows.
 */
import { describe, expect, it } from 'vitest';

import { transformEquipment } from './transform/equipment.js';
import { fixtureExport } from './fixtures.test-helpers.js';
import type { Issue } from './issues.js';

function run() {
  const ex = fixtureExport();
  return transformEquipment({ equipment: ex.Equipment, categories: ex.EquipmentCategory });
}

const find = (issues: readonly Issue[], code: string, legacyId?: string): Issue[] =>
  issues.filter((i) => i.code === code && (legacyId === undefined || i.legacyId === legacyId));

const loansFor = (r: ReturnType<typeof run>, equipmentId: string) =>
  r.loans.filter((l) => l.equipmentLegacyId === equipmentId);

// ---------------------------------------------------------------------------

describe('free-text borrowers become equipment_loans rows', () => {
  it('extracts the current loan from the fields smeared onto the item', () => {
    const r = run();
    const open = loansFor(r, 'eq_401').filter((l) => l.returnedAt === null);

    expect(open).toHaveLength(1);
    expect(open[0]!.borrowerName).toBe('Bracha Adler');
    expect(open[0]!.borrowerPhone).toBe('+15145550310');
    expect(open[0]!.borrowerAddress).toBe('5700 Avenue Victoria, Unit 3');
    expect(open[0]!.loanedAt.toISOString()).toBe('2025-01-20T00:00:00.000Z');
    expect(open[0]!.expectedReturnAt?.toISOString()).toBe('2025-02-20T00:00:00.000Z');
  });

  it('does NOT double-count the open loan that also appears in loan_history', () => {
    const r = run();
    // eq_401 has Bracha both on the item row and as the last history entry.
    const bracha = loansFor(r, 'eq_401').filter((l) => l.borrowerName === 'Bracha Adler');
    expect(bracha).toHaveLength(1);
    // Two loans total: the returned one and the open one.
    expect(loansFor(r, 'eq_401')).toHaveLength(2);
  });

  it('reconstructs closed loans from loan_history with their return dates', () => {
    const r = run();
    const closed = loansFor(r, 'eq_401').find((l) => l.borrowerName === 'Shimon Gross')!;
    expect(closed.loanedAt.toISOString()).toBe('2024-11-02T00:00:00.000Z');
    expect(closed.returnedAt?.toISOString()).toBe('2024-12-15T00:00:00.000Z');
  });

  it('keeps loan history for an item that is currently available', () => {
    const r = run();
    const loans = loansFor(r, 'eq_402');
    expect(loans).toHaveLength(1);
    expect(loans[0]!.returnedAt).not.toBeNull();
    expect(r.equipment.find((e) => e.legacyId === 'eq_402')!.status).toBe('available');
  });

  it('honours the one-open-loan-per-item index by closing superseded loans', () => {
    const r = run();
    // eq_406 has two history entries, neither stamped returned — the in-place
    // mutation in Equipment.jsx missed one.
    const loans = loansFor(r, 'eq_406').sort(
      (a, b) => a.loanedAt.getTime() - b.loanedAt.getTime(),
    );
    expect(loans).toHaveLength(2);

    // The earlier one is closed at the moment the later one began.
    expect(loans[0]!.borrowerName).toBe('Miriam Landau');
    expect(loans[0]!.returnedAt?.toISOString()).toBe(loans[1]!.loanedAt.toISOString());
    expect(loans[0]!.notes).toContain('inferred');

    // Only one stays open.
    expect(loans.filter((l) => l.returnedAt === null)).toHaveLength(1);

    const issue = find(r.issues.all(), 'equipment_loan_state_inconsistent', 'eq_406');
    expect(issue.length).toBeGreaterThanOrEqual(1);
  });
});

describe('a loan with no way to contact the borrower is skipped, not invented', () => {
  it('refuses to create a loan row with a fabricated phone', () => {
    const r = run();
    // eq_403 has a borrower name but no phone; borrower_phone is NOT NULL.
    expect(loansFor(r, 'eq_403')).toHaveLength(0);

    const issue = find(r.issues.all(), 'equipment_loan_missing_borrower', 'eq_403');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('error');
    expect(issue[0]!.message).toContain('inventing a placeholder');
  });

  it('lists the skipped loan with an id that points at the parent item', () => {
    const r = run();
    const s = r.skipped.find((x) => x.legacyId.startsWith('eq_403#'));
    expect(s).toBeDefined();
    expect(s!.entity).toBe('Equipment.loan');
  });

  it('still imports the item itself, and reports the state disagreement', () => {
    const r = run();
    const item = r.equipment.find((e) => e.legacyId === 'eq_403')!;
    expect(item).toBeDefined();
    // Legacy said 'loaned', but no loan row could be built.
    expect(item.status).toBe('available');
    const issue = find(r.issues.all(), 'equipment_loan_state_inconsistent', 'eq_403');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('error');
    expect(issue[0]!.message).toContain('somebody may');
  });
});

describe('item status is reconciled against the reconstructed loans', () => {
  it("sets status to 'loaned' when an open loan exists", () => {
    const r = run();
    expect(r.equipment.find((e) => e.legacyId === 'eq_401')!.status).toBe('loaned');
  });

  it('never corrects a disagreement silently', () => {
    const r = run();
    const inconsistencies = find(r.issues.all(), 'equipment_loan_state_inconsistent');
    // Every status change made on the basis of loan evidence is reported.
    expect(inconsistencies.length).toBeGreaterThan(0);
    for (const i of inconsistencies) expect(i.message.length).toBeGreaterThan(40);
  });
});

describe('items and categories', () => {
  it('skips an item with no type and reports it', () => {
    const r = run();
    expect(r.equipment.some((e) => e.legacyId === 'eq_405')).toBe(false);
    const issue = find(r.issues.all(), 'equipment_missing_type', 'eq_405');
    expect(issue).toHaveLength(1);
    expect(r.skipped.some((s) => s.legacyId === 'eq_405')).toBe(true);
  });

  it('merges a duplicate category name and repoints equipment at the survivor', () => {
    const r = run();
    // 'wheelchairs' (cat_503) duplicates 'Wheelchairs' (cat_501) case-insensitively.
    expect(r.categories.map((c) => c.legacyId)).not.toContain('cat_503');
    const issue = find(r.issues.all(), 'duplicate_merged', 'cat_503');
    expect(issue).toHaveLength(1);
  });

  it('imports an item whose category is missing, with the category name kept in notes', () => {
    const r = run();
    const item = r.equipment.find((e) => e.legacyId === 'eq_404')!;
    expect(item.categoryLegacyId).toBeNull();
    expect(item.notes).toContain('Hospital beds');
    expect(find(r.issues.all(), 'equipment_category_unresolved', 'eq_404')).toHaveLength(1);
  });

  it('preserves the damage report and serial number in notes rather than dropping them', () => {
    const r = run();
    const item = r.equipment.find((e) => e.legacyId === 'eq_404')!;
    expect(item.notes).toContain('Side rail latch broken');
    expect(item.notes).toContain('SN-99213');
    expect(item.status).toBe('maintenance');
  });

  it('records the legacy quantity fields that have no column in the new schema', () => {
    const r = run();
    const cat = r.categories.find((c) => c.legacyId === 'cat_501')!;
    expect(cat.legacyMeta!['legacyTotalQuantity']).toBe(12);
    expect(cat.legacyMeta!['legacyAvailableQuantity']).toBe(9);
  });
});

describe('purity', () => {
  it('is a pure function: two runs produce identical output', () => {
    expect(JSON.stringify(run().loans)).toBe(JSON.stringify(run().loans));
    expect(JSON.stringify(run().equipment)).toBe(JSON.stringify(run().equipment));
  });
});

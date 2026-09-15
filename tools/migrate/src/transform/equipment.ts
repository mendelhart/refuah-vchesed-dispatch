/**
 * Equipment, categories, and the extraction of loans into rows.
 *
 * In the legacy app a loan was not a record. Equipment.jsx wrote the borrower's
 * name, phone and address, the date out and the expected return date directly
 * onto the equipment row, flipped `status` to 'loaned', and pushed a shallow
 * copy into a `loan_history` array that it then MUTATED IN PLACE on return
 * (`lastLoan.date_returned = ...`). Consequences we have to unpick:
 *
 *   - Only the current borrower is on the item; everything else is in the array.
 *   - The array entry and the item fields are two copies of the same open loan,
 *     so importing both would double-count it.
 *   - Returning an item nulled the borrower fields, so a returned loan survives
 *     only in the array — and only if the in-place mutation happened to stick.
 *   - `status: 'loaned'` with no borrower, and a borrower with
 *     `status: 'available'`, both occur. Neither is silently corrected.
 *
 * The new schema has `equipment_loans` with a partial unique index allowing at
 * most one open loan per item, so the reconstruction must be exact.
 */
import type { LegacyEquipment, LegacyEquipmentCategory } from '../types.js';
import { IssueCollector, type SkippedRecord } from '../issues.js';
import type {
  TargetEquipment,
  TargetEquipmentCategory,
  TargetEquipmentLoan,
} from '../target.js';
import * as N from '../normalize.js';

const STATUS_MAP: Readonly<Record<string, string>> = {
  available: 'available',
  in_stock: 'available',
  loaned: 'loaned',
  out: 'loaned',
  on_loan: 'loaned',
  maintenance: 'maintenance',
  repair: 'maintenance',
  damaged: 'maintenance',
  retired: 'retired',
  lost: 'retired',
};

const CONDITION_MAP: Readonly<Record<string, string>> = {
  new: 'new',
  good: 'good',
  fair: 'fair',
  poor: 'poor',
  damaged: 'damaged',
  broken: 'damaged',
};

export interface EquipmentResult {
  categories: TargetEquipmentCategory[];
  equipment: TargetEquipment[];
  loans: TargetEquipmentLoan[];
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

export function transformEquipment(input: {
  equipment: LegacyEquipment[];
  categories: LegacyEquipmentCategory[];
}): EquipmentResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];
  const categories: TargetEquipmentCategory[] = [];
  const equipment: TargetEquipment[] = [];
  const loans: TargetEquipmentLoan[] = [];
  /** Category ids merged away by the name-uniqueness guard, mapped to the survivor. */
  const categoryAliases = new Map<string, string>();

  // --- Categories ---------------------------------------------------------

  const categoryIds = new Set<string>();
  const seenCategoryNames = new Map<string, string>();

  for (const c of input.categories) {
    const name = N.text(c.name);
    if (name === null) {
      const reason = '`equipment_categories.name` is NOT NULL and the category has no name.';
      skipped.push({
        entity: 'EquipmentCategory',
        legacyId: c.id,
        reason,
        code: 'missing_required_field',
      });
      issues.error('missing_required_field', 'EquipmentCategory', c.id, reason, { field: 'name' });
      continue;
    }

    const nameKey = name.toLowerCase();
    const prior = seenCategoryNames.get(nameKey);
    if (prior !== undefined) {
      const reason =
        `Category name '${name}' duplicates category ${prior}; ` +
        '`equipment_categories_name_live_uq` forbids two live categories with the same name. ' +
        'Equipment pointing at this category is repointed at the surviving one.';
      skipped.push({
        entity: 'EquipmentCategory',
        legacyId: c.id,
        reason,
        code: 'missing_required_field',
      });
      issues.warn('duplicate_merged', 'EquipmentCategory', c.id, reason, {
        detail: { keptCategoryId: prior, name },
      });
      // Repoint by aliasing the id.
      categoryAliases.set(c.id, prior);
      continue;
    }
    seenCategoryNames.set(nameKey, c.id);
    categoryIds.add(c.id);

    // The legacy quantity fields have no column in the new schema; equipment is
    // now tracked per item. They go to the ledger rather than being dropped.
    categories.push({
      legacyId: c.id,
      legacyMeta: {
        legacyTotalQuantity: N.int(c.total_quantity),
        legacyAvailableQuantity: N.int(c.available_quantity),
        legacyTrackIndividually: N.bool(c.track_individually),
      },
      name,
      description: N.text(c.description),
      createdAt: N.timestamp(c.created_date).value,
    });
  }

  // --- Equipment ----------------------------------------------------------

  const seenItemCodes = new Map<string, string>();
  const seenBarcodes = new Map<string, string>();

  for (const e of input.equipment) {
    const type = N.text(e.type);
    if (type === null) {
      const reason =
        '`equipment.equipment_type` is NOT NULL and the item has no `type`. An item with no ' +
        'type cannot be found in the equipment list or offered for loan.';
      skipped.push({ entity: 'Equipment', legacyId: e.id, reason, code: 'equipment_missing_type' });
      issues.error('equipment_missing_type', 'Equipment', e.id, reason, { field: 'equipmentType' });
      continue;
    }

    // Category reference.
    const rawCat = N.text(e.category_id);
    let categoryLegacyId: string | null = null;
    if (rawCat !== null) {
      const aliased = categoryAliases.get(rawCat) ?? rawCat;
      if (categoryIds.has(aliased)) {
        categoryLegacyId = aliased;
      } else {
        issues.warn(
          'equipment_category_unresolved',
          'Equipment',
          e.id,
          `category_id ${rawCat} matches no imported EquipmentCategory. The item is imported ` +
            `with no category (the column is nullable); the legacy category_name ` +
            `${JSON.stringify(N.text(e.category_name))} is kept in the ledger and appended to notes.`,
          { field: 'categoryId', detail: { rawCategoryId: rawCat } },
        );
      }
    }

    // Unique-index guards.
    let itemCode = N.text(e.item_id);
    if (itemCode !== null) {
      const prior = seenItemCodes.get(itemCode);
      if (prior !== undefined) {
        issues.error(
          'missing_required_field',
          'Equipment',
          e.id,
          `item_id '${itemCode}' is already used by equipment ${prior}; ` +
            `\`equipment_item_code_live_uq\` forbids duplicates among live items. The code is ` +
            `removed from this item (kept in the ledger) so both items survive the import.`,
          { field: 'itemCode', detail: { itemCode, keptBy: prior } },
        );
        itemCode = null;
      } else {
        seenItemCodes.set(itemCode, e.id);
      }
    }

    let barcode = N.text(e.barcode);
    if (barcode !== null) {
      const prior = seenBarcodes.get(barcode);
      if (prior !== undefined) {
        issues.error(
          'missing_required_field',
          'Equipment',
          e.id,
          `barcode '${barcode}' is already used by equipment ${prior}; ` +
            `\`equipment_barcode_live_uq\` forbids duplicates. Removed from this item and kept ` +
            `in the ledger.`,
          { field: 'barcode', detail: { barcode, keptBy: prior } },
        );
        barcode = null;
      } else {
        seenBarcodes.set(barcode, e.id);
      }
    }

    const statusRes = N.mapEnum(e.status, STATUS_MAP, 'available');
    if (statusRes.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'Equipment',
        e.id,
        `Unrecognised equipment status ${JSON.stringify(statusRes.raw)}; imported as 'available'.`,
        { field: 'status', detail: { raw: statusRes.raw } },
      );
    }
    const conditionRes = N.mapEnum(e.condition, CONDITION_MAP, 'good');
    if (conditionRes.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'Equipment',
        e.id,
        `Unrecognised equipment condition ${JSON.stringify(conditionRes.raw)}; imported as 'good'.`,
        { field: 'condition', detail: { raw: conditionRes.raw } },
      );
    }

    // --- Loans ------------------------------------------------------------

    const itemLoans = extractLoans(e, issues, skipped);
    loans.push(...itemLoans);

    const hasOpenLoan = itemLoans.some((l) => l.returnedAt === null);
    let status = statusRes.value;

    // Reconcile the smeared loan state against the item status. Never silently:
    // whichever way it disagrees, the operator is told.
    if (hasOpenLoan && status !== 'loaned') {
      issues.warn(
        'equipment_loan_state_inconsistent',
        'Equipment',
        e.id,
        `Item has an open loan to ${JSON.stringify(itemLoans.find((l) => l.returnedAt === null)!.borrowerName)} ` +
          `but its status was '${statusRes.raw}'. Status set to 'loaned' to match the loan row, ` +
          `because the borrower details are the more specific evidence.`,
        { field: 'status', detail: { legacyStatus: statusRes.raw } },
      );
      status = 'loaned';
    } else if (!hasOpenLoan && status === 'loaned') {
      issues.error(
        'equipment_loan_state_inconsistent',
        'Equipment',
        e.id,
        `Item status is 'loaned' but no borrower could be reconstructed (borrower_name ` +
          `${JSON.stringify(N.text(e.borrower_name))}, borrower_phone ` +
          `${JSON.stringify(N.text(e.borrower_phone))}). ` +
          `\`equipment_loans.borrower_name\` and \`.borrower_phone\` are NOT NULL, so no loan row ` +
          `can be created without inventing a borrower. Status set to 'available'; somebody may ` +
          `physically hold this item. Investigate before trusting the equipment list.`,
        { field: 'status' },
      );
      status = 'available';
    }

    const notes = [
      N.text(e.notes),
      categoryLegacyId === null && N.text(e.category_name) !== null
        ? `[migrated] legacy category: ${N.text(e.category_name)}`
        : null,
      N.bool(e.damage_reported) === true && N.text(e.damage_report) !== null
        ? `[migrated] damage reported ${N.text(e.damage_reported_at) ?? ''}: ${N.text(e.damage_report)}`
        : null,
      N.text(e.serial_number) !== null ? `[migrated] serial: ${N.text(e.serial_number)}` : null,
    ].filter((x): x is string => x !== null);

    equipment.push({
      legacyId: e.id,
      legacyMeta: {
        legacyStatus: N.text(e.status),
        legacyCategoryId: rawCat,
        legacyCategoryName: N.text(e.category_name),
        legacySerialNumber: N.text(e.serial_number),
        ...(itemCode === null && N.text(e.item_id) !== null
          ? { droppedDuplicateItemCode: N.text(e.item_id) }
          : {}),
        ...(barcode === null && N.text(e.barcode) !== null
          ? { droppedDuplicateBarcode: N.text(e.barcode) }
          : {}),
      },
      categoryLegacyId,
      itemCode,
      barcode,
      equipmentType: type,
      status,
      condition: conditionRes.value,
      notes: notes.length > 0 ? notes.join('\n') : null,
      createdAt: N.timestamp(e.created_date).value,
    });
  }

  return { categories, equipment, loans, skipped, issues };
}

// ---------------------------------------------------------------------------
// Loan extraction
// ---------------------------------------------------------------------------

/**
 * Reconstruct loan rows for one item.
 *
 * `loan_history` is the primary source (it holds closed loans). The item's own
 * borrower fields describe the CURRENT loan, which normally also appears as the
 * last history entry — so the two are deduplicated on (borrower, date_out)
 * rather than both being emitted, and the item fields win where they disagree
 * because Equipment.jsx updated them and the array copy independently.
 */
function extractLoans(
  e: LegacyEquipment,
  issues: IssueCollector,
  skipped: SkippedRecord[],
): TargetEquipmentLoan[] {
  const out: TargetEquipmentLoan[] = [];
  const dedupe = new Set<string>();

  const dedupeKey = (name: string | null, out_: Date | null): string =>
    `${(name ?? '').toLowerCase()}|${out_?.toISOString().slice(0, 10) ?? ''}`;

  const push = (
    index: number,
    borrowerNameRaw: string | null,
    borrowerPhoneRaw: string | null,
    addressRaw: string | null,
    loanedAtRaw: unknown,
    expectedRaw: unknown,
    returnedRaw: unknown,
    origin: 'item' | 'history',
  ): void => {
    const name = N.text(borrowerNameRaw);
    const ph = N.phone(borrowerPhoneRaw);
    const rawPhone = N.text(borrowerPhoneRaw);

    if (name === null || rawPhone === null) {
      const missing = [name === null ? 'borrower_name' : null, rawPhone === null ? 'borrower_phone' : null]
        .filter((x): x is string => x !== null)
        .join(' and ');
      const reason =
        `Loan (${origin} record ${index}) has no ${missing}. ` +
        '`equipment_loans.borrower_name` and `.borrower_phone` are both NOT NULL — a loan with ' +
        'no way to contact the borrower cannot be chased, and inventing a placeholder would ' +
        'make an unreturnable item look tracked. The loan is NOT imported.';
      skipped.push({
        entity: 'Equipment.loan',
        legacyId: `${e.id}#${origin}:${index}`,
        reason,
        code: 'equipment_loan_missing_borrower',
      });
      issues.error('equipment_loan_missing_borrower', 'Equipment', e.id, reason, {
        detail: { origin, index, borrowerName: name, borrowerPhone: rawPhone },
      });
      return;
    }

    const loanedAt = N.timestamp(loanedAtRaw);
    const created = N.timestamp(e.created_date).value;
    const effectiveLoanedAt = loanedAt.value ?? created;
    if (effectiveLoanedAt === null) {
      const reason =
        `Loan (${origin} record ${index}) to ${name} has no usable date_out and the item has no ` +
        'created_date to fall back on; `equipment_loans.loaned_at` is NOT NULL. Not imported.';
      skipped.push({
        entity: 'Equipment.loan',
        legacyId: `${e.id}#${origin}:${index}`,
        reason,
        code: 'equipment_loan_dropped',
      });
      issues.error('equipment_loan_dropped', 'Equipment', e.id, reason);
      return;
    }
    if (loanedAt.value === null && loanedAt.raw !== null) {
      issues.warn(
        'unparsable_timestamp',
        'Equipment',
        e.id,
        `Loan to ${name}: date_out ${JSON.stringify(loanedAt.raw)} is not parsable; the item's ` +
          `created_date was used for loaned_at and the raw value kept in the ledger.`,
        { field: 'loanedAt', detail: { raw: loanedAt.raw } },
      );
    }

    const key = dedupeKey(name, effectiveLoanedAt);
    if (dedupe.has(key)) return;
    dedupe.add(key);

    if (ph.e164 === null) {
      issues.warn(
        'phone_kept_raw',
        'Equipment',
        e.id,
        `Loan to ${name}: borrower_phone ${JSON.stringify(rawPhone)} could not be normalised to ` +
          `E.164 (${ph.reason}); the raw value is kept because \`borrower_phone\` is NOT NULL and ` +
          `losing the only contact detail for an outstanding item is worse than holding it in a ` +
          `non-canonical format. It is not unique-indexed and is dialled by a human.`,
        { field: 'borrowerPhone', detail: { raw: rawPhone, reason: ph.reason } },
      );
    }

    out.push({
      legacyId: `${e.id}#loan:${origin}:${index}`,
      legacyMeta: {
        equipmentLegacyId: e.id,
        origin,
        ...(ph.e164 === null ? { unnormalisedBorrowerPhone: rawPhone } : {}),
        ...(loanedAt.value === null && loanedAt.raw !== null
          ? { unparsableDateOut: loanedAt.raw }
          : {}),
      },
      equipmentLegacyId: e.id,
      borrowerName: name,
      borrowerPhone: ph.e164 ?? rawPhone,
      borrowerAddress: N.text(addressRaw),
      loanedAt: effectiveLoanedAt,
      expectedReturnAt: N.timestamp(expectedRaw).value,
      returnedAt: N.timestamp(returnedRaw).value,
      notes: null,
    });
  };

  // The item's own borrower fields go FIRST, so that when the same loan also
  // appears as the last `loan_history` entry the item copy is the one kept.
  // That matters: Equipment.jsx wrote only a SHALLOW subset into the history
  // array (borrower_name, borrower_phone, date_out) while writing the full
  // detail — address, expected_return_date — onto the item, and it updated the
  // two independently afterwards. The item row is both more complete and more
  // recent, so it wins and the history duplicate is deduplicated away.
  const itemBorrower = N.text(e.borrower_name);
  const itemPhone = N.text(e.borrower_phone);
  if (itemBorrower !== null || itemPhone !== null) {
    push(
      0,
      itemBorrower,
      itemPhone,
      N.text(e.borrower_address),
      e.date_out,
      e.expected_return_date,
      e.actual_return_date,
      'item',
    );
  }

  // Then the history, which supplies every loan that has already been returned.
  e.loan_history.forEach((h, i) => {
    push(
      i,
      N.text(h.borrower_name),
      N.text(h.borrower_phone),
      N.text(h.borrower_address),
      h.date_out,
      h.expected_return_date,
      h.date_returned,
      'history',
    );
  });

  // `equipment_loans_one_open_uq` permits at most one open loan per item. The
  // in-place mutation of loan_history routinely failed to stamp date_returned,
  // so older open loans are closed at the point the next one began.
  const open = out.filter((l) => l.returnedAt === null).sort(
    (a, b) => a.loanedAt.getTime() - b.loanedAt.getTime(),
  );
  if (open.length > 1) {
    const survivor = open[open.length - 1]!;
    for (const stale of open.slice(0, -1)) {
      issues.warn(
        'equipment_loan_state_inconsistent',
        'Equipment',
        e.id,
        `Item has ${open.length} loans with no return date. ` +
          `\`equipment_loans_one_open_uq\` allows only one open loan per item, and legacy ` +
          `Equipment.jsx mutated loan_history in place so a missed return stamp is the likely ` +
          `cause. The loan to ${stale.borrowerName} is closed at the moment the next loan ` +
          `(to ${survivor.borrowerName}) began; only the most recent stays open.`,
        {
          detail: {
            closedBorrower: stale.borrowerName,
            closedAt: survivor.loanedAt.toISOString(),
            openBorrower: survivor.borrowerName,
          },
        },
      );
      const nextStart = out
        .filter((l) => l !== stale && l.loanedAt.getTime() > stale.loanedAt.getTime())
        .sort((a, b) => a.loanedAt.getTime() - b.loanedAt.getTime())[0];
      stale.returnedAt = nextStart?.loanedAt ?? survivor.loanedAt;
      stale.notes = '[migrated] return date inferred: superseded by a later loan of the same item';
    }
  }

  return out;
}

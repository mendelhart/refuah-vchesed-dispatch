/**
 * The issue model.
 *
 * Everything the migration notices about the legacy data becomes an `Issue`.
 * There is no other channel: a transform may not `console.warn`, may not
 * silently null a field, and may not drop a row. If it did something the
 * operator would want to know about, there is an Issue for it, carrying the
 * legacy id so the record can be found in the source system.
 *
 * Severity decides whether the migration is allowed to proceed:
 *   error   — data would be lost or wrong. `--dry-run` reports it; a real run
 *             exits non-zero so this can gate a production migration.
 *   warning — data is preserved but something was decided for the operator
 *             (a merge precedence applied, a status remapped, a reference
 *             re-issued). Review, but not a blocker.
 *   info    — pure bookkeeping (a duplicate merged as designed).
 */

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  // identity
  | 'user_missing_email'
  | 'user_missing_name'
  | 'field_conflict'
  | 'duplicate_merged'
  | 'directory_entry_unresolved'
  | 'volunteer_without_user'
  | 'duplicate_email_collision'
  | 'phone_collision'
  // phones
  | 'phone_unnormalisable'
  | 'phone_kept_raw'
  // trips
  | 'trip_missing_pickup_time'
  | 'trip_missing_address'
  | 'trip_missing_group'
  | 'trip_unresolved_assignee'
  | 'trip_assignee_resolved_by_fallback'
  | 'trip_status_remapped'
  | 'trip_status_demoted'
  | 'call_id_collision'
  | 'reference_reissued'
  // equipment
  | 'equipment_missing_type'
  | 'equipment_loan_missing_borrower'
  | 'equipment_loan_dropped'
  | 'equipment_category_unresolved'
  | 'equipment_loan_state_inconsistent'
  // generic
  | 'missing_required_field'
  | 'unparsable_timestamp'
  | 'unknown_enum_value'
  | 'group_created'
  | 'entity_not_migrated'
  | 'actor_unresolved'
  | 'parse_failed';

export interface Issue {
  severity: IssueSeverity;
  code: IssueCode;
  /** Legacy entity name, e.g. 'Trip'. */
  entity: string;
  /** Legacy primary key of the offending record. Never omitted where one exists. */
  legacyId: string | null;
  /** The field involved, where the issue is about one field. */
  field?: string;
  message: string;
  /** Machine-readable extras: the competing values of a conflict, etc. */
  detail?: Record<string, unknown>;
}

export class IssueCollector {
  private readonly items: Issue[] = [];

  add(issue: Issue): void {
    this.items.push(issue);
  }

  error(
    code: IssueCode,
    entity: string,
    legacyId: string | null,
    message: string,
    extra?: Partial<Issue>,
  ): void {
    this.add({ severity: 'error', code, entity, legacyId, message, ...extra });
  }

  warn(
    code: IssueCode,
    entity: string,
    legacyId: string | null,
    message: string,
    extra?: Partial<Issue>,
  ): void {
    this.add({ severity: 'warning', code, entity, legacyId, message, ...extra });
  }

  info(
    code: IssueCode,
    entity: string,
    legacyId: string | null,
    message: string,
    extra?: Partial<Issue>,
  ): void {
    this.add({ severity: 'info', code, entity, legacyId, message, ...extra });
  }

  all(): readonly Issue[] {
    return this.items;
  }

  get errorCount(): number {
    return this.items.filter((i) => i.severity === 'error').length;
  }
}

/**
 * A record that was NOT imported. Every one of these is listed individually in
 * the report — the tool never reports an aggregate "n skipped" without the ids.
 */
export interface SkippedRecord {
  entity: string;
  legacyId: string;
  reason: string;
  code: IssueCode;
}

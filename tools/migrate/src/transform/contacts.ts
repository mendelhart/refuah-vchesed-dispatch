/**
 * Contacts, and the other small entities that have no home of their own:
 * MaskedCall -> `calls`, TextTemplate -> `settings`, OrganizationInfo, and
 * RecurringTask (which has no target table at all and is reported rather than
 * dropped).
 */
import type {
  LegacyContact,
  LegacyMaskedCall,
  LegacyOrganizationInfo,
  LegacyRecurringTask,
  LegacyTextTemplate,
} from '../types.js';
import { IssueCollector, type SkippedRecord } from '../issues.js';
import type {
  TargetCall,
  TargetContact,
  TargetOrganizationInfo,
  TargetSetting,
} from '../target.js';
import * as N from '../normalize.js';

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ContactsResult {
  contacts: TargetContact[];
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

export function transformContacts(input: { contacts: LegacyContact[] }): ContactsResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];
  const contacts: TargetContact[] = [];

  for (const c of input.contacts) {
    const name = N.text(c.name);
    const rawPhone = N.text(c.phone);

    if (name === null || rawPhone === null) {
      const missing = [name === null ? 'name' : null, rawPhone === null ? 'phone' : null]
        .filter((x): x is string => x !== null)
        .join(' and ');
      const reason =
        `Contact has no ${missing}; both \`contacts.name\` and \`contacts.phone\` are NOT NULL. ` +
        `A contact you cannot name or cannot reach is not a contact.`;
      skipped.push({ entity: 'Contact', legacyId: c.id, reason, code: 'missing_required_field' });
      issues.error('missing_required_field', 'Contact', c.id, reason, {
        field: name === null ? 'name' : 'phone',
      });
      continue;
    }

    const ph = N.phone(rawPhone);
    if (ph.e164 === null) {
      // `contacts.phone` is NOT NULL but carries no unique index and is dialled
      // by a human reading it off the screen, so the raw string is kept.
      issues.warn(
        'phone_kept_raw',
        'Contact',
        c.id,
        `Contact '${name}': phone ${JSON.stringify(rawPhone)} could not be normalised to E.164 ` +
          `(${ph.reason}). The raw value is kept — \`contacts.phone\` is NOT NULL, is not ` +
          `unique-indexed, and is dialled by hand, so preserving what the admin typed is ` +
          `strictly better than discarding the only way to reach this person.`,
        { field: 'phone', detail: { raw: rawPhone, reason: ph.reason } },
      );
    }

    contacts.push({
      legacyId: c.id,
      legacyMeta: { ...(ph.e164 === null ? { unnormalisedPhone: rawPhone } : {}) },
      name,
      phone: ph.e164 ?? rawPhone,
      role: N.text(c.role),
      notes: N.text(c.notes),
      createdAt: N.timestamp(c.created_date).value,
    });
  }

  return { contacts, skipped, issues };
}

// ---------------------------------------------------------------------------
// MaskedCall -> calls
// ---------------------------------------------------------------------------

const CALL_STATUS_MAP: Readonly<Record<string, string>> = {
  initiated: 'requested',
  requested: 'requested',
  queued: 'requested',
  ringing: 'ringing',
  in_progress: 'in_progress',
  answered: 'in_progress',
  forwarded: 'completed',
  completed: 'completed',
  failed: 'failed',
  busy: 'failed',
  no_answer: 'no_answer',
  noanswer: 'no_answer',
  canceled: 'failed',
  cancelled: 'failed',
  blocked: 'blocked',
};

const COUNTERPARTY_MAP: Readonly<Record<string, string>> = {
  trip_caller: 'caller',
  caller: 'caller',
  volunteer: 'volunteer',
  admin: 'volunteer',
  contact: 'contact',
  arbitrary_number: 'contact',
};

export interface CallsResult {
  calls: TargetCall[];
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

export function transformCalls(input: {
  calls: LegacyMaskedCall[];
  byLegacyId: ReadonlyMap<string, string>;
  byEmail: ReadonlyMap<string, string>;
  /** Legacy trip ids that were actually imported. */
  importedTripIds: ReadonlySet<string>;
}): CallsResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];
  const calls: TargetCall[] = [];

  for (const c of input.calls) {
    // `calls.initiated_by_id` is a NOT NULL foreign key. Resolve by legacy id,
    // then by the email the call log recorded.
    const rawCaller = N.text(c.caller_id);
    const byId = rawCaller !== null ? input.byLegacyId.get(rawCaller) : undefined;
    const mail = N.emailKey(c.caller_email);
    const byMail = mail !== null ? input.byEmail.get(mail) : undefined;
    const initiatedByKey = byId ?? byMail;

    if (initiatedByKey === undefined) {
      const reason =
        `Call was initiated by caller_id ${JSON.stringify(rawCaller)} / email ` +
        `${JSON.stringify(mail)}, neither of which resolves to an imported person. ` +
        '`calls.initiated_by_id` is a NOT NULL foreign key, and attributing a phone call to an ' +
        'arbitrary user would put someone else\'s call on their record. Not imported.';
      skipped.push({ entity: 'MaskedCall', legacyId: c.id, reason, code: 'actor_unresolved' });
      issues.error('actor_unresolved', 'MaskedCall', c.id, reason, {
        field: 'initiatedById',
        detail: { callerId: rawCaller, callerEmail: mail },
      });
      continue;
    }

    const startedAt = N.timestamp(c.initiated_at).value ?? N.timestamp(c.created_date).value;
    if (startedAt === null) {
      const reason =
        'Call has neither a parsable initiated_at nor created_date; `calls.started_at` is NOT NULL.';
      skipped.push({ entity: 'MaskedCall', legacyId: c.id, reason, code: 'unparsable_timestamp' });
      issues.error('unparsable_timestamp', 'MaskedCall', c.id, reason, { field: 'startedAt' });
      continue;
    }

    const rawTrip = N.text(c.trip_id);
    let tripLegacyId: string | null = null;
    if (rawTrip !== null) {
      if (input.importedTripIds.has(rawTrip)) {
        tripLegacyId = rawTrip;
      } else {
        issues.warn(
          'missing_required_field',
          'MaskedCall',
          c.id,
          `Call references trip ${rawTrip}, which was not imported. The call is kept with a null ` +
            `trip_id (the column is nullable) and the legacy trip id preserved in the ledger.`,
          { field: 'tripId', detail: { tripId: rawTrip } },
        );
      }
    }

    const cpType = N.mapEnum(c.recipient_type ?? c.call_type, COUNTERPARTY_MAP, 'contact');
    if (cpType.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'MaskedCall',
        c.id,
        `Unrecognised recipient_type ${JSON.stringify(cpType.raw)}; imported as 'contact'.`,
        { field: 'counterpartyType', detail: { raw: cpType.raw } },
      );
    }

    const rawRecipient = N.text(c.recipient_id);
    const counterpartyUserKey =
      rawRecipient !== null ? (input.byLegacyId.get(rawRecipient) ?? null) : null;

    const statusRes = N.mapEnum(c.status, CALL_STATUS_MAP, 'requested');
    if (statusRes.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'MaskedCall',
        c.id,
        `Unrecognised call status ${JSON.stringify(statusRes.raw)}; imported as 'requested'.`,
        { field: 'status', detail: { raw: statusRes.raw } },
      );
    }

    calls.push({
      legacyId: c.id,
      legacyMeta: {
        legacyTripId: rawTrip,
        legacyStatus: N.text(c.status),
        // Deliberately NOT the full recipient number. `calls.destination_last4`
        // exists because the new schema retains only the last four digits of a
        // called number; copying the whole thing into the import ledger would
        // quietly reinstate the data it was designed to stop holding.
        legacyRecipientLast4: N.last4(c.recipient_phone),
        legacyForwardedAt: N.text(c.forwarded_at),
        legacyForwardedBy: N.text(c.forwarded_by),
      },
      initiatedByKey,
      tripLegacyId,
      direction: 'outbound',
      counterpartyType: cpType.value,
      counterpartyUserKey,
      // Only the last four digits are retained by design; the new schema does
      // not store full counterparty numbers for calls.
      destinationLast4: N.last4(c.recipient_phone),
      counterpartyName: N.text(c.recipient_name),
      failureReason: statusRes.value === 'no_answer' ? 'no_answer' : null,
      providerSid: N.text(c.call_sid),
      status: statusRes.value,
      durationSeconds: N.int(c.duration),
      // `calls.authorization_basis` is NOT NULL. The legacy app recorded no
      // basis at all — createMaskedCall decided authorisation inline and threw
      // the reasoning away — so the honest value is that this is an import,
      // not a reconstruction of why the call was permitted.
      authorizationBasis: 'legacy_import:basis_not_recorded',
      errorMessage: N.text(c.error_message),
      startedAt,
      endedAt: N.timestamp(c.ended_at).value,
    });
  }

  return { calls, skipped, issues };
}

// ---------------------------------------------------------------------------
// TextTemplate -> settings
// ---------------------------------------------------------------------------

export interface TemplatesResult {
  settings: TargetSetting[];
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

export function transformTextTemplates(input: {
  templates: LegacyTextTemplate[];
}): TemplatesResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];
  const settings: TargetSetting[] = [];
  const seen = new Set<string>();

  for (const t of input.templates) {
    const key = N.text(t.template_key);
    const content = N.text(t.template_content);
    if (key === null || content === null) {
      const reason =
        `Template is missing ${key === null ? 'template_key' : 'template_content'}; ` +
        'there is nothing to key it on or nothing to send.';
      skipped.push({ entity: 'TextTemplate', legacyId: t.id, reason, code: 'missing_required_field' });
      issues.error('missing_required_field', 'TextTemplate', t.id, reason);
      continue;
    }

    const settingKey = `templates.${key}`;
    if (seen.has(settingKey)) {
      const reason = `Duplicate template_key '${key}'; \`settings.key\` is the primary key.`;
      skipped.push({ entity: 'TextTemplate', legacyId: t.id, reason, code: 'missing_required_field' });
      issues.warn('duplicate_merged', 'TextTemplate', t.id, reason);
      continue;
    }
    seen.add(settingKey);

    settings.push({
      legacyId: t.id,
      legacyMeta: { templateKey: key },
      key: settingKey,
      value: {
        name: N.text(t.template_name),
        content,
        category: N.text(t.category),
        variables: t.available_variables,
      },
      description: N.text(t.description) ?? `Legacy Base44 text template '${key}'.`,
    });
  }

  return { settings, skipped, issues };
}

// ---------------------------------------------------------------------------
// OrganizationInfo
// ---------------------------------------------------------------------------

export interface OrgResult {
  org: TargetOrganizationInfo | null;
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

export function transformOrganizationInfo(input: {
  rows: LegacyOrganizationInfo[];
}): OrgResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];

  if (input.rows.length === 0) return { org: null, skipped, issues };

  // The legacy screen only ever edited `orgInfo[0]`, so later rows were
  // unreachable in the UI. They are reported rather than silently ignored.
  const [first, ...rest] = input.rows;
  for (const r of rest) {
    const reason =
      'OrganizationInfo held more than one row, but the legacy screen only ever read and wrote ' +
      `orgInfo[0] (${first!.id}), so this row was invisible in the application. ` +
      'Not imported; its contents are listed in the report.';
    skipped.push({ entity: 'OrganizationInfo', legacyId: r.id, reason, code: 'duplicate_merged' });
    issues.warn('duplicate_merged', 'OrganizationInfo', r.id, reason, {
      detail: { organizationName: N.text(r.organization_name) },
    });
  }

  const o = first!;
  const name = N.text(o.organization_name);
  if (name === null) {
    const reason = '`organization_info.name` is NOT NULL and organization_name is empty.';
    skipped.push({
      entity: 'OrganizationInfo',
      legacyId: o.id,
      reason,
      code: 'missing_required_field',
    });
    issues.error('missing_required_field', 'OrganizationInfo', o.id, reason, { field: 'name' });
    return { org: null, skipped, issues };
  }

  const ph = N.phone(o.phone);
  if (N.text(o.phone) !== null && ph.e164 === null) {
    issues.warn(
      'phone_kept_raw',
      'OrganizationInfo',
      o.id,
      `Organisation phone ${JSON.stringify(ph.raw)} could not be normalised to E.164 ` +
        `(${ph.reason}); the raw value is kept for display.`,
      { field: 'phone' },
    );
  }

  const addressLine = [
    [N.text(o.street_number), N.text(o.street_name)].filter((x) => x !== null).join(' ') || null,
    N.text(o.unit) !== null ? `Unit ${N.text(o.unit)}` : null,
    N.text(o.city),
    N.text(o.province),
    N.text(o.postal_code),
  ]
    .filter((x): x is string => x !== null && x !== '')
    .join(', ');

  return {
    org: {
      legacyId: o.id,
      name,
      phone: ph.e164 ?? ph.raw,
      email: N.text(o.email),
      website: N.text(o.website),
      addressLine: addressLine === '' ? null : addressLine,
      emergencyContact: N.text(o.emergency_contact),
      details: {
        charityNumber: N.text(o.charity_number),
        description: N.text(o.description),
        missionStatement: N.text(o.mission_statement),
        hoursOfOperation: N.text(o.hours_of_operation),
        logoUrl: N.text(o.logo_url),
      },
    },
    skipped,
    issues,
  };
}

// ---------------------------------------------------------------------------
// RecurringTask — no target table
// ---------------------------------------------------------------------------

export interface RecurringResult {
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

/**
 * `RecurringTask` has no counterpart in the new schema: recurring dispatch is
 * not in v1, and the legacy implementation stored a cancellation list of bare
 * date strings with no timezone, which cannot be reconstructed faithfully.
 *
 * Nothing is dropped silently — every task is listed in the report with its id
 * and its definition, so the data exists in writing for whoever builds the
 * feature. This raises no error, because it is a known scope decision rather
 * than a data defect.
 */
export function transformRecurringTasks(input: {
  tasks: LegacyRecurringTask[];
}): RecurringResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];

  for (const t of input.tasks) {
    const reason =
      `RecurringTask '${N.text(t.task_name) ?? '(unnamed)'}' (${N.text(t.frequency) ?? 'unknown'} ` +
      `${N.text(t.day_of_week) ?? ''} ${N.text(t.time) ?? ''}) has no target table: recurring ` +
      `dispatch is out of scope for the new schema's first release. The full definition is ` +
      `recorded in the report so no information is lost.`;
    skipped.push({ entity: 'RecurringTask', legacyId: t.id, reason, code: 'entity_not_migrated' });
    issues.warn('entity_not_migrated', 'RecurringTask', t.id, reason, {
      detail: {
        taskName: N.text(t.task_name),
        taskType: N.text(t.task_type),
        frequency: N.text(t.frequency),
        dayOfWeek: N.text(t.day_of_week),
        time: N.text(t.time),
        pickupAddress: N.text(t.pickup_address),
        dropoffAddress: N.text(t.dropoff_address),
        volunteerGroup: N.text(t.volunteer_group),
        assignedVolunteerName: N.text(t.assigned_volunteer_name),
        active: N.bool(t.active),
        cancelledDates: t.cancelled_dates,
      },
    });
  }

  return { skipped, issues };
}

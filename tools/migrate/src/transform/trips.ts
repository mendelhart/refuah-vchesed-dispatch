/**
 * Trips.
 *
 * Three legacy defects are resolved here.
 *
 * 1. `assigned_volunteer_id` HOLDS IDS FROM TWO ENTITIES.
 *    The dispatcher's assign dropdown in Trips.jsx was populated from
 *    `Volunteer.filter({active:true})` and wrote `Volunteer.id`, while the SMS
 *    accept path in handleSMSWebhook.ts wrote `User.id` into the same column.
 *    Neither recorded which it was. Resolution is a cascade, most trustworthy
 *    first, and every step below the first is reported:
 *
 *      a. the id matches a legacy User  -> resolved, silent
 *      b. the id matches a legacy Volunteer -> resolved via that Volunteer's
 *         email, reported as `trip_assignee_resolved_by_fallback`
 *      c. the id matches nothing, but `assigned_volunteer_phone` normalises to
 *         a phone we hold -> resolved, reported
 *      d. `assigned_volunteer_name` matches exactly one person -> resolved,
 *         reported (a name matching several people is NOT resolved — picking
 *         one would assign a stranger's trip history to the wrong volunteer)
 *      e. nothing matches -> `trip_unresolved_assignee` ERROR. The trip is
 *         still imported, with its history and timestamps, but with no
 *         assignee and its status demoted, because a trip that claims to be
 *         'accepted' with nobody accepting it is a lie the new state machine
 *         would propagate.
 *
 * 2. COLLIDING 4-DIGIT `call_id`s.
 *    `generateCallId()` was `Math.floor(1000 + Math.random()*9000)` — 9000
 *    possible values, no uniqueness check, and the SMS accept path matched on
 *    `call_id.slice(-4)`, so a collision meant one volunteer's "1234-YES"
 *    could accept somebody else's trip. Every trip is re-issued a proper
 *    `trips.reference` (RVC-YYMMDD-NNNN, generated from a per-day counter);
 *    the legacy call_id is preserved in the import ledger metadata, never
 *    reused as an identifier, and every collision is reported.
 *
 * 3. THE UNREACHABLE `offered` STATUS.
 *    Nothing in the legacy app ever wrote `status: 'offered'` — sendTripSMS
 *    broadcast the trip without touching the status — yet both the SMS webhook
 *    and the dashboard filtered on it. Any `offered` row in the export is
 *    therefore a stale artefact of an earlier version. In the new schema
 *    `offered` is a real state backed by `trip_offers` rows carrying hashed
 *    single-use tokens and an expiry; we have none of those and will not
 *    fabricate them, so legacy `offered` maps to `pending` (the trip goes back
 *    on the dispatcher's queue) and each one is reported.
 */
import type { LegacyTrip } from '../types.js';
import { IssueCollector, type SkippedRecord } from '../issues.js';
import type { TargetAddress, TargetTrip, TargetTripAssignment } from '../target.js';
import * as N from '../normalize.js';

// ---------------------------------------------------------------------------
// Enum tables
// ---------------------------------------------------------------------------

/**
 * Legacy status -> new status. Only `offered` is re-pointed; everything else
 * either already matches the new vocabulary or is an obvious synonym.
 */
const STATUS_MAP: Readonly<Record<string, string>> = {
  new: 'new',
  pending: 'pending',
  open: 'pending',
  active: 'pending',
  // See note 3 above.
  offered: 'pending',
  sent: 'pending',
  assigned: 'assigned',
  accepted: 'accepted',
  claimed: 'accepted',
  en_route: 'en_route',
  enroute: 'en_route',
  on_the_way: 'en_route',
  in_progress: 'in_progress',
  started: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  finished: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired: 'expired',
};

/** Statuses that assert a specific volunteer is committed to the trip. */
const REQUIRES_ASSIGNEE = new Set([
  'assigned',
  'accepted',
  'en_route',
  'in_progress',
  'completed',
]);

const TRIP_TYPE_MAP: Readonly<Record<string, string>> = {
  ride: 'ride',
  equipment_delivery: 'equipment_delivery',
  equipment: 'equipment_delivery',
  delivery: 'equipment_delivery',
  hospital_food: 'hospital_food',
  food: 'hospital_food',
};

const ASSIGNMENT_MODE_MAP: Readonly<Record<string, string>> = {
  auto: 'auto',
  admin_approval: 'admin_approval',
  manual: 'admin_approval',
};

const MOBILITY_MAP: Readonly<Record<string, string>> = {
  wheelchair: 'wheelchair',
  stretcher: 'stretcher',
  walker: 'walker',
  oxygen: 'oxygen',
  attendant: 'attendant',
  escort: 'attendant',
  none: 'none',
};

// ---------------------------------------------------------------------------

export interface TripLookups {
  /** Legacy User id AND legacy Volunteer id -> person key. */
  byLegacyId: ReadonlyMap<string, string>;
  /** E.164 -> person key. */
  byPhone: ReadonlyMap<string, string>;
  /** lower(full name) -> person keys. */
  byName: ReadonlyMap<string, string[]>;
  /** Person keys that came from a legacy User (used to label resolution path). */
  volunteerLegacyIds: ReadonlySet<string>;
  /** Slugs that already exist. Unknown slugs are created and reported. */
  knownGroupSlugs: ReadonlySet<string>;
}

export interface TripsResult {
  trips: TargetTrip[];
  addresses: TargetAddress[];
  assignments: TargetTripAssignment[];
  /** Slugs encountered on trips that were not already known. */
  newGroups: Array<{ slug: string; name: string }>;
  skipped: SkippedRecord[];
  issues: IssueCollector;
  /** legacy call_id -> the legacy trip ids that shared it. */
  callIdCollisions: Map<string, string[]>;
}

// ---------------------------------------------------------------------------

interface AssigneeResolution {
  key: string | null;
  path: 'user_id' | 'volunteer_id' | 'phone' | 'name' | 'none' | 'absent';
}

function resolveAssignee(t: LegacyTrip, look: TripLookups): AssigneeResolution {
  const raw = N.text(t.assigned_volunteer_id);

  if (raw !== null) {
    const hit = look.byLegacyId.get(raw);
    if (hit !== undefined) {
      return { key: hit, path: look.volunteerLegacyIds.has(raw) ? 'volunteer_id' : 'user_id' };
    }
  }

  // (c) phone
  const ph = N.phone(t.assigned_volunteer_phone);
  if (ph.e164 !== null) {
    const hit = look.byPhone.get(ph.e164);
    if (hit !== undefined) return { key: hit, path: 'phone' };
  }

  // (d) name, only when unambiguous
  const name = N.lower(t.assigned_volunteer_name);
  if (name !== null) {
    const hits = look.byName.get(name) ?? [];
    if (hits.length === 1) return { key: hits[0]!, path: 'name' };
  }

  return { key: null, path: raw === null ? 'absent' : 'none' };
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function buildAddress(
  t: LegacyTrip,
  side: 'pickup' | 'dropoff',
): { address: TargetAddress; ok: true } | { ok: false } {
  const g = (suffix: string): string | null =>
    N.text((t as unknown as Record<string, unknown>)[`${side}_${suffix}`]);

  const streetNumber = g('street_number');
  const streetName = g('street_name');
  const composed = g('address');

  // Prefer the components when both are present; they are what the form
  // captured, and `*_address` is a string the UI concatenated from them.
  let line1: string | null = null;
  if (streetName !== null) {
    line1 = streetNumber !== null ? `${streetNumber} ${streetName}` : streetName;
  } else if (composed !== null) {
    line1 = composed;
  }

  if (line1 === null) return { ok: false };

  return {
    ok: true,
    address: {
      key: `${t.id}:${side}`,
      line1,
      unit: g('unit'),
      city: g('city') ?? 'Montreal',
      province: g('province') ?? 'QC',
      postalCode: g('postal_code'),
      notes: g('notes'),
    },
  };
}

// ---------------------------------------------------------------------------
// Reference generation
// ---------------------------------------------------------------------------

/**
 * Issue `RVC-YYMMDD-NNNN` from a per-day counter, exactly as the production app
 * does from `trip_counters`. Deterministic given a stable input ordering, so a
 * dry run and the real run produce the same references.
 */
function makeReferencer(): (d: Date) => string {
  const counters = new Map<string, number>();
  return (d: Date) => {
    const day = N.torontoDayKey(d);
    const next = (counters.get(day) ?? 0) + 1;
    counters.set(day, next);
    return `RVC-${day}-${String(next).padStart(4, '0')}`;
  };
}

// ---------------------------------------------------------------------------

export function transformTrips(input: {
  trips: LegacyTrip[];
  lookups: TripLookups;
}): TripsResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];
  const trips: TargetTrip[] = [];
  const addresses: TargetAddress[] = [];
  const assignments: TargetTripAssignment[] = [];
  const newGroups = new Map<string, string>();

  // --- call_id collisions, detected across the whole set first -------------
  const callIdOwners = new Map<string, string[]>();
  for (const t of input.trips) {
    const cid = N.text(t.call_id);
    if (cid === null) continue;
    callIdOwners.set(cid, [...(callIdOwners.get(cid) ?? []), t.id]);
  }
  const callIdCollisions = new Map(
    [...callIdOwners.entries()].filter(([, ids]) => ids.length > 1),
  );
  for (const [cid, ids] of callIdCollisions) {
    issues.error(
      'call_id_collision',
      'Trip',
      ids[0] ?? null,
      `call_id ${cid} is shared by ${ids.length} trips (${ids.join(', ')}). ` +
        `Legacy generated it as a 4-digit random number with no uniqueness check, and the SMS ` +
        `accept path matched on it, so a volunteer texting "${cid}-YES" could accept any of ` +
        `these trips. All ${ids.length} receive fresh unique references; the legacy call_id is ` +
        `kept in ledger metadata and is never used as an identifier again.`,
      { detail: { callId: cid, legacyTripIds: ids } },
    );
  }

  // Stable ordering so references are reproducible between dry run and real run.
  const ordered = [...input.trips].sort((a, b) => {
    const ta = N.timestamp(a.created_date).value?.getTime() ?? 0;
    const tb = N.timestamp(b.created_date).value?.getTime() ?? 0;
    return ta !== tb ? ta - tb : a.id.localeCompare(b.id);
  });

  const nextReference = makeReferencer();

  for (const t of ordered) {
    // --- required: pickup time ---
    const pickup = N.timestamp(t.pickup_time);
    if (pickup.value === null) {
      const reason =
        pickup.raw === null
          ? '`trips.pickup_at` is NOT NULL and the trip has no pickup_time.'
          : `pickup_time ${JSON.stringify(pickup.raw)} is not a parsable timestamp, and ` +
            '`trips.pickup_at` is NOT NULL. Guessing a time would put a volunteer at the wrong door.';
      skipped.push({ entity: 'Trip', legacyId: t.id, reason, code: 'trip_missing_pickup_time' });
      issues.error('trip_missing_pickup_time', 'Trip', t.id, reason, {
        detail: { raw: pickup.raw },
      });
      continue;
    }

    // --- required: both addresses ---
    const pick = buildAddress(t, 'pickup');
    const drop = buildAddress(t, 'dropoff');
    if (!pick.ok || !drop.ok) {
      const missing = [!pick.ok ? 'pickup' : null, !drop.ok ? 'dropoff' : null]
        .filter((x): x is string => x !== null)
        .join(' and ');
      const reason =
        `No ${missing} address. Both \`trips.pickup_address_id\` and ` +
        '`trips.dropoff_address_id` are NOT NULL foreign keys; a trip with nowhere to go ' +
        'cannot be dispatched.';
      skipped.push({ entity: 'Trip', legacyId: t.id, reason, code: 'trip_missing_address' });
      issues.error('trip_missing_address', 'Trip', t.id, reason);
      continue;
    }

    // --- required: group ---
    const slug = N.slugify(t.volunteer_group);
    if (slug === null) {
      const reason =
        '`trips.group_id` is a NOT NULL foreign key and the trip has no volunteer_group. ' +
        'Assigning it to an arbitrary group would broadcast this trip to volunteers who were ' +
        'never offered it.';
      skipped.push({ entity: 'Trip', legacyId: t.id, reason, code: 'trip_missing_group' });
      issues.error('trip_missing_group', 'Trip', t.id, reason);
      continue;
    }
    if (!input.lookups.knownGroupSlugs.has(slug) && !newGroups.has(slug)) {
      newGroups.set(slug, N.text(t.volunteer_group) ?? slug);
      issues.warn(
        'group_created',
        'Trip',
        t.id,
        `Trip references volunteer group '${N.text(t.volunteer_group)}' (slug '${slug}') which ` +
          `no user belongs to and which is not seeded. Created so the trip can be imported.`,
        { detail: { slug } },
      );
    }

    // --- status ---
    const statusRes = N.mapEnum(t.status, STATUS_MAP, 'pending');
    if (statusRes.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'Trip',
        t.id,
        `Unrecognised legacy status ${JSON.stringify(statusRes.raw)}; imported as 'pending' so a ` +
          `dispatcher sees it rather than it disappearing into a terminal state.`,
        { field: 'status', detail: { raw: statusRes.raw } },
      );
    } else if (statusRes.raw === 'offered') {
      issues.warn(
        'trip_status_remapped',
        'Trip',
        t.id,
        `Legacy status 'offered' remapped to 'pending'. Nothing in the legacy app ever set ` +
          `'offered' (sendTripSMS broadcast without touching status), so this row is a stale ` +
          `artefact. In the new schema 'offered' requires trip_offers rows with hashed ` +
          `single-use tokens and an expiry; none exist in the export and fabricating them ` +
          `would create acceptable offers out of nothing. The trip returns to the queue.`,
        { field: 'status', detail: { from: 'offered', to: 'pending' } },
      );
    }
    let status = statusRes.value;

    // --- assignee ---
    const res = resolveAssignee(t, input.lookups);
    const rawAssigneeId = N.text(t.assigned_volunteer_id);

    if (res.path === 'volunteer_id') {
      issues.warn(
        'trip_assignee_resolved_by_fallback',
        'Trip',
        t.id,
        `assigned_volunteer_id ${rawAssigneeId} is a legacy Volunteer id, not a User id ` +
          `(the dispatcher's assign dropdown read the Volunteer table). Resolved to ${res.key} ` +
          `via that Volunteer's email.`,
        { field: 'assignedVolunteerId', detail: { rawId: rawAssigneeId, resolvedTo: res.key } },
      );
    } else if (res.path === 'phone' || res.path === 'name') {
      issues.warn(
        'trip_assignee_resolved_by_fallback',
        'Trip',
        t.id,
        `assigned_volunteer_id ${JSON.stringify(rawAssigneeId)} matches neither a User nor a ` +
          `Volunteer. Resolved to ${res.key} by ${res.path === 'phone' ? 'matching the stored ' +
          'assigned_volunteer_phone' : 'an unambiguous assigned_volunteer_name match'}. ` +
          `Verify this assignment before trusting the trip history.`,
        { field: 'assignedVolunteerId', detail: { rawId: rawAssigneeId, via: res.path } },
      );
    } else if (res.path === 'none') {
      const ambiguous = (input.lookups.byName.get(N.lower(t.assigned_volunteer_name) ?? '') ?? [])
        .length;
      issues.error(
        'trip_unresolved_assignee',
        'Trip',
        t.id,
        `assigned_volunteer_id ${JSON.stringify(rawAssigneeId)} resolves to no person: it is ` +
          `neither a User id nor a Volunteer id, the stored phone ` +
          `${JSON.stringify(N.text(t.assigned_volunteer_phone))} matches nobody, and the name ` +
          `${JSON.stringify(N.text(t.assigned_volunteer_name))} ` +
          (ambiguous > 1
            ? `matches ${ambiguous} people, so it cannot disambiguate.`
            : `matches nobody.`) +
          ` The trip IS imported with its timestamps and history, but with no assignee — ` +
          `pointing it at a guessed volunteer would attribute someone else's work to them.`,
        {
          field: 'assignedVolunteerId',
          detail: {
            rawId: rawAssigneeId,
            name: N.text(t.assigned_volunteer_name),
            phone: N.text(t.assigned_volunteer_phone),
            nameMatches: ambiguous,
          },
        },
      );
    }

    // A status that asserts a committed volunteer cannot survive without one.
    if (res.key === null && REQUIRES_ASSIGNEE.has(status)) {
      const demoted = status === 'completed' ? 'completed' : 'pending';
      if (demoted !== status) {
        issues.warn(
          'trip_status_demoted',
          'Trip',
          t.id,
          `Status '${status}' asserts a committed volunteer but none could be resolved; ` +
            `demoted to 'pending' so the trip returns to the dispatcher's queue rather than ` +
            `sitting in a state the new state machine cannot legally leave.`,
          { field: 'status', detail: { from: status, to: demoted } },
        );
        status = demoted;
      } else {
        // A completed trip keeps its status: the work demonstrably happened and
        // erasing that would rewrite history. It just has no attributable
        // volunteer, which the error above already records.
        issues.warn(
          'trip_status_demoted',
          'Trip',
          t.id,
          `Completed trip retains status 'completed' despite an unresolved assignee — the trip ` +
            `demonstrably happened and history is preserved — but it is imported with no ` +
            `volunteer attribution and no trip_assignments row.`,
          { field: 'status' },
        );
      }
    }

    // --- trip type / mode / mobility ---
    const tripType = N.mapEnum(t.trip_type, TRIP_TYPE_MAP, 'ride');
    if (tripType.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'Trip',
        t.id,
        `Unrecognised trip_type ${JSON.stringify(tripType.raw)}; imported as 'ride'.`,
        { field: 'tripType', detail: { raw: tripType.raw } },
      );
    }
    const mode = N.mapEnum(t.assignment_mode, ASSIGNMENT_MODE_MAP, 'auto');

    const mobility: string[] = [];
    for (const m of t.mobility_needs) {
      const mapped = N.mapEnum(m, MOBILITY_MAP, 'none');
      if (mapped.fellBack) {
        issues.warn(
          'unknown_enum_value',
          'Trip',
          t.id,
          `Unrecognised mobility need ${JSON.stringify(m)}; dropped from the structured array ` +
            `and appended to passenger_notes so the information is not lost.`,
          { field: 'mobilityNeeds', detail: { raw: m } },
        );
        continue;
      }
      if (mapped.value !== 'none' && !mobility.includes(mapped.value)) mobility.push(mapped.value);
    }
    const unknownMobility = t.mobility_needs.filter(
      (m) => N.mapEnum(m, MOBILITY_MAP, 'none').fellBack,
    );

    // --- caller phone ---
    const callerPhone = N.phone(t.caller_phone);
    if (N.text(t.caller_phone) !== null && callerPhone.e164 === null) {
      issues.warn(
        'phone_kept_raw',
        'Trip',
        t.id,
        `caller_phone ${JSON.stringify(callerPhone.raw)} could not be normalised to E.164 ` +
          `(${callerPhone.reason}); the raw value is kept. trips.caller_phone is not ` +
          `unique-indexed and is displayed for a dispatcher to dial by hand, so preserving ` +
          `what was typed is better than discarding it.`,
        { field: 'callerPhone', detail: { raw: callerPhone.raw, reason: callerPhone.reason } },
      );
    }

    // --- reference ---
    const createdAt = N.timestamp(t.created_date).value;
    const reference = nextReference(createdAt ?? pickup.value);
    const legacyCallId = N.text(t.call_id);
    if (legacyCallId !== null) {
      issues.info(
        'reference_reissued',
        'Trip',
        t.id,
        `Legacy call_id ${legacyCallId} replaced by reference ${reference}. The legacy value is ` +
          `retained in ledger metadata for cross-referencing paper records, and is not an identifier.`,
        { detail: { legacyCallId, reference } },
      );
    }

    // --- notes ---
    const noteParts = [
      N.text(t.passenger_notes),
      unknownMobility.length > 0
        ? `[migrated] unrecognised mobility needs: ${unknownMobility.join(', ')}`
        : null,
    ].filter((x): x is string => x !== null);

    addresses.push(pick.address, drop.address);

    const cancelledByRaw = N.text(t.cancelled_by_id);
    const cancelledByKey =
      cancelledByRaw !== null ? (input.lookups.byLegacyId.get(cancelledByRaw) ?? null) : null;
    if (cancelledByRaw !== null && cancelledByKey === null) {
      issues.warn(
        'actor_unresolved',
        'Trip',
        t.id,
        `cancelled_by_id ${cancelledByRaw} resolves to no person; cancelled_by_id is left null ` +
          `and the recorded name ${JSON.stringify(N.text(t.cancelled_by_name))} is kept in the ` +
          `cancellation reason instead.`,
        { field: 'cancelledById' },
      );
    }

    const cancellationReason = [
      N.text(t.cancellation_reason),
      cancelledByRaw !== null && cancelledByKey === null && N.text(t.cancelled_by_name) !== null
        ? `[migrated] cancelled by ${N.text(t.cancelled_by_name)} (unresolved legacy id ${cancelledByRaw})`
        : null,
    ]
      .filter((x): x is string => x !== null)
      .join(' — ');

    const acceptedAt = N.timestamp(t.accepted_at).value;
    const completedAt = N.timestamp(t.completed_at).value;
    const cancelledAt = N.timestamp(t.cancelled_at).value;

    const trip: TargetTrip = {
      legacyId: t.id,
      legacyMeta: {
        legacyCallId,
        legacyStatus: N.text(t.status),
        legacyAssignedVolunteerId: rawAssigneeId,
        assigneeResolutionPath: res.path,
        callIdCollided: legacyCallId !== null && callIdCollisions.has(legacyCallId),
        legacyInterestedVolunteers: t.interested_volunteers.length,
        legacyNudgeCount: N.int(t.nudge_count),
        legacySmsSentAt: N.text(t.sms_sent_at),
      },
      reference,
      status,
      // Legacy had no priority field at all. 'routine' is the schema default,
      // not an inference about urgency.
      priority: 'routine',
      tripType: tripType.value,
      assignmentMode: mode.value,
      groupSlug: slug,
      callerName: N.text(t.caller_name),
      callerPhone: callerPhone.e164 ?? callerPhone.raw,
      pickupAddressKey: pick.address.key,
      dropoffAddressKey: drop.address.key,
      pickupAt: pickup.value,
      mobilityNeeds: mobility,
      passengerNotes: noteParts.length > 0 ? noteParts.join('\n') : null,
      assignedVolunteerKey: res.key,
      assignedAt: res.key !== null ? (acceptedAt ?? createdAt) : null,
      acceptedAt,
      completedAt,
      cancelledAt,
      cancelledByKey,
      cancellationReason: cancellationReason === '' ? null : cancellationReason,
      createdAt,
    };
    trips.push(trip);

    // Assignment history. The legacy app kept none, so we can reconstruct
    // exactly one row — the current assignment — and we mark its source
    // 'import' so nobody mistakes it for a recorded dispatcher action.
    if (res.key !== null) {
      assignments.push({
        legacyId: `${t.id}:assignment`,
        legacyMeta: { via: res.path },
        tripLegacyId: t.id,
        volunteerKey: res.key,
        source: 'import',
        assignedAt: acceptedAt ?? createdAt ?? pickup.value,
        unassignedAt: status === 'cancelled' ? (cancelledAt ?? completedAt) : null,
        unassignedReason: status === 'cancelled' ? 'trip cancelled (legacy import)' : null,
      });
    }
  }

  return {
    trips,
    addresses,
    assignments,
    newGroups: [...newGroups.entries()].map(([slug, name]) => ({ slug, name })),
    skipped,
    issues,
    callIdCollisions,
  };
}

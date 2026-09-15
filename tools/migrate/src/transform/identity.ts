/**
 * THE THREE-WAY PERSON MERGE.
 *
 * The legacy system represented one human up to three times:
 *
 *   User                      — the authentication record. Split-brain: every
 *                               profile field exists top-level AND inside `data`.
 *   Volunteer                 — a copy produced by functions/syncVolunteers.ts,
 *                               keyed on email, with NO back-reference to the
 *                               User it came from.
 *   PublicVolunteerDirectory  — a second copy produced by
 *                               functions/syncPublicDirectory.ts, keyed on
 *                               `user_id`, built only from TOP-LEVEL User fields.
 *
 * This module resolves all three into exactly one `users` row, and returns the
 * id maps that let trips, calls and audit rows point at the surviving person.
 *
 * =====================================================================
 * PRECEDENCE RULE
 * =====================================================================
 *
 * For every field, the first source below that holds a non-empty value wins:
 *
 *   1. User.data.<field>                 (nested)
 *   2. User.<field>                      (top-level)
 *   3. Volunteer.<field>
 *   4. PublicVolunteerDirectory.<field>
 *
 * Why this order, and not the other way round:
 *
 *   - The legacy application itself read `u.data?.phone || u.phone`. That
 *     expression appears 32 times across the pages and functions; there is no
 *     screen that reads top-level first for phone. So the NESTED value is the
 *     one dispatchers saw on the directory, the one the SMS webhook matched
 *     inbound texts against, and the one the assign dropdown showed. Choosing
 *     top-level would change what the system believes about a person relative
 *     to what its users believed — a silent behavioural regression during a
 *     migration is the worst possible time for one.
 *
 *   - The nested copy is also the more recent one for any person who ever used
 *     the self-service screens: Settings.jsx, NotificationSettings.jsx and
 *     MyAvailability.jsx all write through `auth.updateMe({ data: {...} })`,
 *     while only the admin screen writes top-level. Where a volunteer corrected
 *     their own phone number, the correction is in `data`.
 *
 *   - Volunteer and PublicVolunteerDirectory rank below User because both are
 *     mechanically derived copies. syncVolunteers reads `user.data?.phone ||
 *     user.phone` (so it is at best a stale snapshot of rule 1), and
 *     syncPublicDirectory reads only `user.phone` (so it is a stale snapshot of
 *     rule 2, and is strictly the least informed source in the system).
 *
 * The rule decides which value is WRITTEN. It never decides what is REPORTED:
 * every divergence between two sources that both hold a non-empty value is
 * emitted as a `field_conflict` issue naming both values and both legacy ids,
 * so a human can check the ones that matter. Merging is not the same as
 * agreeing, and this tool does not pretend it is.
 *
 * =====================================================================
 * KEYING
 * =====================================================================
 *
 * The canonical key is `lower(trim(email))`, because that is the only field all
 * three entities share and the only one the new schema makes unique. A record
 * with no usable email cannot be keyed, cannot satisfy `users.email NOT NULL`,
 * and is skipped and reported rather than given a synthesised address.
 */
import {
  SPLIT_BRAIN_FIELDS,
  type LegacyPublicVolunteerDirectory,
  type LegacyUser,
  type LegacyVolunteer,
} from '../types.js';
import { IssueCollector, type SkippedRecord } from '../issues.js';
import type { TargetGroup, TargetUser } from '../target.js';
import * as N from '../normalize.js';

// ---------------------------------------------------------------------------
// Enum tables
// ---------------------------------------------------------------------------

/** Legacy roles seen in the source: 'admin', 'user', 'volunteer'. */
const ROLE_MAP: Readonly<Record<string, string>> = {
  admin: 'admin',
  dispatcher: 'dispatcher',
  // Base44's default authenticated role. The legacy UI filtered
  // `v.role === 'user'` to mean "ordinary volunteer".
  user: 'volunteer',
  volunteer: 'volunteer',
};

const NOTIFICATION_PREFERENCE_MAP: Readonly<Record<string, string>> = {
  sms: 'sms',
  push: 'push',
  both: 'both',
  none: 'none',
  email: 'none', // legacy 'email' has no channel in the new system; means "not SMS/push"
};

// ---------------------------------------------------------------------------
// Merge candidate: one field value plus where it came from
// ---------------------------------------------------------------------------

interface Candidate<T> {
  value: T | null;
  /** Human-readable origin, e.g. 'User.data' — used in conflict messages. */
  origin: string;
  legacyId: string;
}

export interface ResolvedPerson {
  /** lower(email) — the canonical identity key used everywhere downstream. */
  key: string;
  user: TargetUser;
  legacyUserId: string | null;
  legacyVolunteerId: string | null;
  legacyDirectoryId: string | null;
  /** Which of the three entities contributed, in precedence order. */
  origins: string[];
}

export interface IdentityResult {
  people: ResolvedPerson[];
  groups: TargetGroup[];
  /**
   * Legacy id -> person key, covering BOTH id spaces (User ids and Volunteer
   * ids) plus directory ids. This map is what makes the ambiguous
   * `Trip.assigned_volunteer_id` resolvable.
   */
  byLegacyId: Map<string, string>;
  byEmail: Map<string, string>;
  /** E.164 phone -> person key. The last-resort resolution path for trips. */
  byPhone: Map<string, string>;
  /** Full name (lowercased) -> person keys. Ambiguous names map to several. */
  byName: Map<string, string[]>;
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/**
 * Apply the precedence rule to a list of candidates, and report every
 * divergence between candidates that both hold a value.
 *
 * The first candidate with a non-null value wins. Later candidates that hold a
 * DIFFERENT non-null value produce a `field_conflict` issue. Later candidates
 * that agree are silent — agreement is not news.
 */
function resolveField<T>(
  field: string,
  candidates: Candidate<T>[],
  issues: IssueCollector,
  personKey: string,
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
): T | null {
  const present = candidates.filter((c) => c.value !== null && c.value !== undefined);
  if (present.length === 0) return null;

  const winner = present[0]!;

  for (const other of present.slice(1)) {
    if (!eq(winner.value as T, other.value as T)) {
      issues.warn(
        'field_conflict',
        'User',
        winner.legacyId,
        `${personKey}: '${field}' differs between ${winner.origin} and ${other.origin}. ` +
          `Kept ${JSON.stringify(winner.value)} from ${winner.origin} (higher precedence); ` +
          `${JSON.stringify(other.value)} from ${other.origin} was NOT applied.`,
        {
          field,
          detail: {
            personKey,
            kept: { value: winner.value, origin: winner.origin, legacyId: winner.legacyId },
            discarded: { value: other.value, origin: other.origin, legacyId: other.legacyId },
          },
        },
      );
    }
  }

  return winner.value as T;
}

const sameStringArray = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

// ---------------------------------------------------------------------------
// Grouping the three entities by person
// ---------------------------------------------------------------------------

interface Bundle {
  key: string;
  user?: LegacyUser;
  /** More than one Volunteer row may exist for one email (sync ran twice). */
  volunteers: LegacyVolunteer[];
  directories: LegacyPublicVolunteerDirectory[];
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

export function transformIdentity(input: {
  users: LegacyUser[];
  volunteers: LegacyVolunteer[];
  directory: LegacyPublicVolunteerDirectory[];
  /** Slug -> name for groups that already exist (the seed set). */
  knownGroups: ReadonlyArray<{ slug: string; name: string }>;
}): IdentityResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];
  const bundles = new Map<string, Bundle>();

  const bundleFor = (key: string): Bundle => {
    let b = bundles.get(key);
    if (b === undefined) {
      b = { key, volunteers: [], directories: [] };
      bundles.set(key, b);
    }
    return b;
  };

  // --- Pass 1: Users ------------------------------------------------------
  //
  // Users are the only authoritative source, so they seed the bundles.

  const userIdToKey = new Map<string, string>();

  for (const u of input.users) {
    const key = N.emailKey(u.email);
    if (key === null) {
      const reason =
        'User has no usable email address. `users.email` is NOT NULL and email is the ' +
        'only identity key shared by all three legacy person entities; synthesising one ' +
        'would invent data. Fix the source record and re-run.';
      skipped.push({ entity: 'User', legacyId: u.id, reason, code: 'user_missing_email' });
      issues.error('user_missing_email', 'User', u.id, reason);
      continue;
    }

    const existing = bundles.get(key);
    if (existing?.user !== undefined) {
      // Two User rows, same email. The new schema forbids this outright.
      issues.error(
        'duplicate_email_collision',
        'User',
        u.id,
        `Two legacy User rows share the email ${key} (${existing.user.id} and ${u.id}). ` +
          `Only ${existing.user.id} is imported; ${u.id} is NOT, because merging two ` +
          `authentication records would silently grant one person's history to another.`,
        { detail: { email: key, kept: existing.user.id, dropped: u.id } },
      );
      skipped.push({
        entity: 'User',
        legacyId: u.id,
        reason: `Duplicate email ${key}; kept User ${existing.user.id}.`,
        code: 'duplicate_email_collision',
      });
      continue;
    }

    bundleFor(key).user = u;
    userIdToKey.set(u.id, key);
  }

  // --- Pass 2: Volunteers -------------------------------------------------
  //
  // Keyed on email, with no back-reference. A Volunteer whose email matches no
  // User is still a real person the dispatcher could assign trips to, so it
  // becomes a person in its own right — but that is reported, because it means
  // the legacy sync had drifted.

  for (const v of input.volunteers) {
    const key = N.emailKey(v.email);
    if (key === null) {
      const reason =
        'Volunteer has no usable email. Volunteer rows are keyed on email alone and carry ' +
        'no reference to the User they were copied from, so an emailless Volunteer cannot ' +
        'be attached to any person.';
      skipped.push({ entity: 'Volunteer', legacyId: v.id, reason, code: 'user_missing_email' });
      issues.error('user_missing_email', 'Volunteer', v.id, reason);
      continue;
    }

    const bundle = bundleFor(key);
    bundle.volunteers.push(v);

    if (bundle.user === undefined) {
      issues.warn(
        'volunteer_without_user',
        'Volunteer',
        v.id,
        `Volunteer ${v.id} (${key}) has no matching User row. The legacy Volunteer table was ` +
          `synced from User by email with no back-reference, so this is either a person whose ` +
          `User was deleted or a stale sync artefact. Imported as a person in their own right; ` +
          `they will have no password and must be invited.`,
      );
    }
  }

  // --- Pass 3: PublicVolunteerDirectory -----------------------------------
  //
  // Keyed on `user_id`. It is a derived copy and NEVER creates a person: a
  // directory entry pointing at a User that does not exist is a dangling
  // artefact, not evidence of a human.

  for (const d of input.directory) {
    const byId = N.text(d.user_id) !== null ? userIdToKey.get(N.text(d.user_id)!) : undefined;
    const byMail = N.emailKey(d.email);
    const key = byId ?? (byMail !== null && bundles.has(byMail) ? byMail : undefined);

    if (key === undefined) {
      const reason =
        `Directory entry references user_id=${N.text(d.user_id) ?? 'null'} ` +
        `(email ${byMail ?? 'absent'}), which matches no User or Volunteer. ` +
        `PublicVolunteerDirectory is a derived copy, so it is never used to create a person; ` +
        `this entry is dropped.`;
      skipped.push({
        entity: 'PublicVolunteerDirectory',
        legacyId: d.id,
        reason,
        code: 'directory_entry_unresolved',
      });
      issues.error('directory_entry_unresolved', 'PublicVolunteerDirectory', d.id, reason, {
        detail: { userId: N.text(d.user_id), email: byMail },
      });
      continue;
    }

    if (byId !== undefined && byMail !== null && byId !== byMail) {
      issues.error(
        'field_conflict',
        'PublicVolunteerDirectory',
        d.id,
        `Directory entry ${d.id} points at User ${N.text(d.user_id)} (${byId}) but carries ` +
          `email ${byMail}. The user_id is trusted because syncPublicDirectory keys on it; ` +
          `the email on the entry is stale.`,
        { field: 'email', detail: { userIdResolvesTo: byId, entryEmail: byMail } },
      );
    }

    bundles.get(key)!.directories.push(d);
  }

  // --- Merge --------------------------------------------------------------

  const groupSlugs = new Map<string, string>(); // slug -> display name
  for (const g of input.knownGroups) groupSlugs.set(g.slug, g.name);

  const people: ResolvedPerson[] = [];

  for (const bundle of bundles.values()) {
    const u = bundle.user;
    // Where the sync ran more than once, the newest Volunteer copy is the least
    // stale; order deterministically so a re-run produces the same answer.
    const vols = [...bundle.volunteers].sort(
      (a, b) => tsOf(b.updated_date ?? b.created_date) - tsOf(a.updated_date ?? a.created_date),
    );
    const v = vols[0];
    const dirs = [...bundle.directories].sort(
      (a, b) => tsOf(b.updated_date ?? b.created_date) - tsOf(a.updated_date ?? a.created_date),
    );
    const d = dirs[0];

    const key = bundle.key;

    // Report the duplication itself, so the reconciliation report can show
    // "this many humans existed more than once".
    const representations = [u ? 'User' : null, v ? 'Volunteer' : null, d ? 'Directory' : null]
      .filter((x): x is string => x !== null);
    if (representations.length > 1) {
      issues.info(
        'duplicate_merged',
        'User',
        u?.id ?? v?.id ?? d?.id ?? null,
        `${key} existed as ${representations.length} separate legacy records ` +
          `(${representations.join(' + ')}) and was merged into one user row.`,
        {
          detail: {
            personKey: key,
            userId: u?.id ?? null,
            volunteerIds: vols.map((x) => x.id),
            directoryIds: dirs.map((x) => x.id),
          },
        },
      );
    }
    if (vols.length > 1) {
      issues.warn(
        'duplicate_merged',
        'Volunteer',
        vols[0]!.id,
        `${key} has ${vols.length} Volunteer rows (${vols.map((x) => x.id).join(', ')}). ` +
          `The most recently updated one was used; the others contributed nothing.`,
      );
    }

    /** Build the precedence-ordered candidate list for a split-brain field. */
    const cand = <T>(
      fromUserData: T | null,
      fromUser: T | null,
      fromVolunteer: T | null,
      fromDirectory: T | null,
    ): Candidate<T>[] => [
      { value: fromUserData, origin: 'User.data', legacyId: u?.id ?? '' },
      { value: fromUser, origin: 'User', legacyId: u?.id ?? '' },
      { value: fromVolunteer, origin: 'Volunteer', legacyId: v?.id ?? '' },
      { value: fromDirectory, origin: 'PublicVolunteerDirectory', legacyId: d?.id ?? '' },
    ];

    // --- full_name ---
    const fullName = resolveField(
      'full_name',
      cand(
        N.text(u?.data?.full_name),
        N.text(u?.full_name),
        N.text(v?.full_name),
        N.text(d?.full_name),
      ),
      issues,
      key,
    );

    if (fullName === null) {
      const reason =
        '`users.full_name` is NOT NULL and no name is present in any of the User, Volunteer ' +
        'or directory representations. A person with no name cannot be shown to a dispatcher; ' +
        'inventing one from the email local part would be fabricating data.';
      const legacyId = u?.id ?? v?.id ?? d?.id ?? key;
      skipped.push({
        entity: u ? 'User' : v ? 'Volunteer' : 'PublicVolunteerDirectory',
        legacyId,
        reason,
        code: 'user_missing_name',
      });
      issues.error('user_missing_name', 'User', legacyId, `${key}: ${reason}`);
      continue;
    }

    // --- phone ---
    //
    // Resolved on the RAW values so the conflict report shows what was actually
    // typed, then normalised once. Two numbers that differ only in formatting
    // are not a conflict, so comparison is on the normalised form.
    const rawPhone = resolveField(
      'phone',
      cand(N.text(u?.data?.phone), N.text(u?.phone), N.text(v?.phone), N.text(d?.phone)),
      issues,
      key,
      (a, b) => {
        const pa = N.phone(a).e164;
        const pb = N.phone(b).e164;
        return pa !== null && pb !== null ? pa === pb : a === b;
      },
    );

    const ph = N.phone(rawPhone);
    if (rawPhone !== null && ph.e164 === null) {
      issues.error(
        'phone_unnormalisable',
        'User',
        u?.id ?? v?.id ?? key,
        `${key}: phone ${JSON.stringify(rawPhone)} cannot be normalised to E.164 (${ph.reason}). ` +
          `It is NOT imported: users.phone carries a live-unique index and is the key the SMS ` +
          `webhook routes inbound replies on, so a malformed number here would either collide ` +
          `or silently route a volunteer's "YES" to the wrong trip. The raw value is preserved ` +
          `in the import ledger metadata.`,
        { field: 'phone', detail: { raw: rawPhone, reason: ph.reason } },
      );
    }

    // --- role ---
    const roleRaw = resolveField(
      'role',
      cand(N.text(u?.data?.role), N.text(u?.role), N.text(v?.role), N.text(d?.role)),
      issues,
      key,
    );
    const role = N.mapEnum(roleRaw, ROLE_MAP, 'volunteer');
    if (role.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'User',
        u?.id ?? key,
        `${key}: unrecognised legacy role ${JSON.stringify(role.raw)}; imported as 'volunteer' ` +
          `(the least-privileged role). Escalating an unknown role would be a privilege grant.`,
        { field: 'role', detail: { raw: role.raw } },
      );
    }

    // --- active / status ---
    const activeRaw = resolveField(
      'active_volunteer',
      cand(
        N.bool(u?.data?.active_volunteer),
        N.bool(u?.active_volunteer),
        N.bool(v?.active),
        N.bool(d?.active),
      ),
      issues,
      key,
    );
    // Absent means active: the legacy default for a created volunteer was true,
    // and syncVolunteers wrote `active: user.data?.active_volunteer !== false && ...`.
    const status = activeRaw === false ? 'inactive' : 'active';

    // --- groups ---
    //
    // The highest-precedence NON-EMPTY list wins outright. Unioning the lists
    // would grant membership nobody recorded, which in this system means
    // sending a volunteer trip offers for a group they never joined.
    const groups = resolveField(
      'volunteer_groups',
      cand(
        nonEmpty(u?.data?.volunteer_groups),
        nonEmpty(u?.volunteer_groups),
        nonEmpty(v?.groups),
        nonEmpty(d?.groups),
      ),
      issues,
      key,
      sameStringArray,
    );

    const slugs: string[] = [];
    for (const g of groups ?? []) {
      const slug = N.slugify(g);
      if (slug === null) continue;
      if (!groupSlugs.has(slug)) {
        groupSlugs.set(slug, g);
        issues.warn(
          'group_created',
          'User',
          u?.id ?? key,
          `Volunteer group '${g}' (slug '${slug}') is not one of the seeded groups and was ` +
            `created from legacy free text. Legacy stored group membership as free-text keys ` +
            `on both User and Trip, so typos became groups.`,
          { detail: { slug, name: g } },
        );
      }
      if (!slugs.includes(slug)) slugs.push(slug);
    }

    // --- remaining profile fields ---
    const notifRaw = resolveField(
      'notification_preference',
      cand(N.text(u?.data?.notification_preference), N.text(u?.notification_preference), null, null),
      issues,
      key,
    );
    const notif = N.mapEnum(notifRaw, NOTIFICATION_PREFERENCE_MAP, 'sms');
    if (notif.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'User',
        u?.id ?? key,
        `${key}: unrecognised notification_preference ${JSON.stringify(notif.raw)}; imported as 'sms'.`,
        { field: 'notificationPreference', detail: { raw: notif.raw } },
      );
    }

    const preferredVehicle = resolveField(
      'preferred_vehicle_type',
      cand(
        N.text(u?.data?.preferred_vehicle_type) ?? N.text(u?.data?.preferred_vehicle_name),
        N.text(u?.preferred_vehicle_type) ?? N.text(u?.preferred_vehicle_name),
        N.text(v?.vehicle_preference),
        null,
      ),
      issues,
      key,
    );

    const photoUrl = resolveField(
      'photo_url',
      cand(
        N.text(u?.data?.photo_url) ?? N.text(u?.data?.profile_photo_url),
        N.text(u?.photo_url) ?? N.text(u?.profile_photo_url),
        null,
        N.text(d?.photo_url),
      ),
      issues,
      key,
    );

    const addressLine = resolveField(
      'address',
      cand(N.text(u?.data?.address), N.text(u?.address), null, null),
      issues,
      key,
    );

    const ecName = resolveField(
      'emergency_contact_name',
      cand(N.text(u?.data?.emergency_contact_name), N.text(u?.emergency_contact_name), null, null),
      issues,
      key,
    );

    const ecPhoneRaw = resolveField(
      'emergency_contact_phone',
      cand(N.text(u?.data?.emergency_contact_phone), N.text(u?.emergency_contact_phone), null, null),
      issues,
      key,
    );
    const ecPhone = N.phone(ecPhoneRaw);
    if (ecPhoneRaw !== null && ecPhone.e164 === null) {
      // Not unique-indexed and never auto-dialled, so the raw value is kept
      // rather than discarded — losing an emergency contact is worse than
      // holding one in a non-canonical format. Reported either way.
      issues.warn(
        'phone_kept_raw',
        'User',
        u?.id ?? key,
        `${key}: emergency_contact_phone ${JSON.stringify(ecPhoneRaw)} could not be normalised ` +
          `to E.164 (${ecPhone.reason}); the raw value is kept because this field is neither ` +
          `unique-indexed nor dialled automatically.`,
        { field: 'emergencyContactPhone', detail: { raw: ecPhoneRaw, reason: ecPhone.reason } },
      );
    }

    const availabilityRaw =
      (u?.data?.availability as Record<string, unknown> | undefined) ??
      (u?.availability as Record<string, unknown> | undefined) ??
      null;

    const createdAt = N.timestamp(u?.created_date ?? v?.created_date ?? d?.created_date).value;

    const person: ResolvedPerson = {
      key,
      legacyUserId: u?.id ?? null,
      legacyVolunteerId: v?.id ?? null,
      legacyDirectoryId: d?.id ?? null,
      origins: representations,
      user: {
        legacyId: u?.id ?? v?.id ?? d?.id ?? key,
        legacyMeta: {
          legacyUserId: u?.id ?? null,
          legacyVolunteerIds: vols.map((x) => x.id),
          legacyDirectoryIds: dirs.map((x) => x.id),
          mergedFrom: representations,
          ...(rawPhone !== null && ph.e164 === null ? { unnormalisablePhone: rawPhone } : {}),
        },
        email: key,
        fullName,
        phone: ph.e164,
        role: role.value,
        status,
        notificationPreference: notif.value,
        preferredVehicleType: preferredVehicle,
        photoUrl,
        addressLine,
        emergencyContactName: ecName,
        emergencyContactPhone: ecPhone.e164 ?? ecPhoneRaw,
        availability:
          availabilityRaw !== null && typeof availabilityRaw === 'object' ? availabilityRaw : null,
        createdAt,
        groupSlugs: slugs,
      },
    };

    people.push(person);
  }

  // --- Phone uniqueness ---------------------------------------------------
  //
  // `users_phone_live_uq` is a live-unique index. Two distinct people holding
  // the same number would make the insert fail; more importantly it means the
  // SMS webhook could never tell them apart, which is exactly the bug the new
  // index exists to prevent. The number stays with the person created first
  // (the original); later duplicates lose it and are reported.

  const phoneOwner = new Map<string, ResolvedPerson>();
  const ordered = [...people].sort((a, b) => {
    const ta = a.user.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const tb = b.user.createdAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return ta !== tb ? ta - tb : a.key.localeCompare(b.key);
  });

  for (const p of ordered) {
    const e164 = p.user.phone;
    if (e164 === null) continue;
    const owner = phoneOwner.get(e164);
    if (owner === undefined) {
      phoneOwner.set(e164, p);
      continue;
    }
    issues.error(
      'phone_collision',
      'User',
      p.user.legacyId,
      `${p.key} and ${owner.key} both hold the phone number ${e164}. ` +
        `users.phone is live-unique because inbound SMS is routed by it. The number is kept on ` +
        `${owner.key} (created first) and REMOVED from ${p.key}; ${p.key} will not receive SMS ` +
        `until a dispatcher gives them a number of their own. Raw value preserved in the ledger.`,
      { field: 'phone', detail: { phone: e164, keptBy: owner.key, removedFrom: p.key } },
    );
    p.user.legacyMeta = { ...p.user.legacyMeta, collidingPhone: e164 };
    p.user.phone = null;
  }

  // --- Index maps ---------------------------------------------------------

  const byLegacyId = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  const byName = new Map<string, string[]>();

  for (const p of people) {
    byEmail.set(p.key, p.key);
    if (p.legacyUserId !== null) byLegacyId.set(p.legacyUserId, p.key);
    if (p.legacyVolunteerId !== null) byLegacyId.set(p.legacyVolunteerId, p.key);
    if (p.legacyDirectoryId !== null) byLegacyId.set(p.legacyDirectoryId, p.key);
    if (p.user.phone !== null) byPhone.set(p.user.phone, p.key);
    const nk = p.user.fullName.toLowerCase().trim();
    byName.set(nk, [...(byName.get(nk) ?? []), p.key]);
  }

  // Every Volunteer id must be resolvable, not just the newest one per person.
  for (const bundle of bundles.values()) {
    const key = bundle.key;
    if (!people.some((p) => p.key === key)) continue;
    for (const v of bundle.volunteers) byLegacyId.set(v.id, key);
    for (const d of bundle.directories) byLegacyId.set(d.id, key);
  }

  const groups: TargetGroup[] = [...groupSlugs.entries()].map(([slug, name]) => ({
    legacyId: `group:${slug}`,
    slug,
    name,
    active: true,
  }));

  return { people, groups, byLegacyId, byEmail, byPhone, byName, skipped, issues };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function nonEmpty(v: string[] | undefined): string[] | null {
  if (v === undefined || v.length === 0) return null;
  const cleaned = v.map((s) => s.trim()).filter((s) => s !== '');
  return cleaned.length === 0 ? null : cleaned;
}

function tsOf(v: unknown): number {
  return N.timestamp(v).value?.getTime() ?? 0;
}

/** Re-exported so tests can assert the exact precedence order. */
export const FIELD_PRECEDENCE = [
  'User.data',
  'User',
  'Volunteer',
  'PublicVolunteerDirectory',
] as const;

export { SPLIT_BRAIN_FIELDS };

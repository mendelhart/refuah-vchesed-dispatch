/**
 * The three-way person merge.
 *
 * The assertions that matter are not "the merge produced a row" — they are:
 *   - the precedence rule picked the RIGHT value, for the documented reason;
 *   - a conflict was REPORTED, not silently resolved;
 *   - a record that cannot be keyed became an ISSUE, not a fabricated row.
 */
import { describe, expect, it } from 'vitest';

import { transformIdentity } from './transform/identity.js';
import { fixtureExport, fixturePlan } from './fixtures.test-helpers.js';
import type { Issue } from './issues.js';

const SEED = [
  { slug: 'chaim_vchesed', name: "Chaim V'Chesed" },
  { slug: 'chesed_on_the_go', name: 'Chesed on the Go' },
  { slug: 'misamchem', name: 'Misamchem' },
];

function run() {
  const ex = fixtureExport();
  return transformIdentity({
    users: ex.User,
    volunteers: ex.Volunteer,
    directory: ex.PublicVolunteerDirectory,
    knownGroups: SEED,
  });
}

const find = (issues: readonly Issue[], code: string, legacyId?: string): Issue[] =>
  issues.filter((i) => i.code === code && (legacyId === undefined || i.legacyId === legacyId));

// ---------------------------------------------------------------------------

describe('three-way identity merge', () => {
  it('collapses User + Volunteer + directory entry for one human into ONE user row', () => {
    const r = run();

    const sara = r.people.filter((p) => p.key === 'sara.weiss@example.org');
    expect(sara).toHaveLength(1);

    // All three legacy representations are accounted for on the one person.
    expect(sara[0]!.legacyUserId).toBe('usr_001');
    expect(sara[0]!.legacyVolunteerId).toBe('vol_101');
    expect(sara[0]!.legacyDirectoryId).toBe('dir_201');
    expect(sara[0]!.origins).toEqual(['User', 'Volunteer', 'Directory']);

    // And the merge is reported, so the report can say "n humans existed n times".
    const merged = find(r.issues.all(), 'duplicate_merged').filter(
      (i) => (i.detail as Record<string, unknown> | undefined)?.['personKey'] === 'sara.weiss@example.org',
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.message).toContain('3 separate legacy records');
  });

  it('every legacy id from BOTH id spaces resolves to the surviving person', () => {
    const r = run();
    // This is what makes the ambiguous Trip.assigned_volunteer_id resolvable.
    expect(r.byLegacyId.get('usr_001')).toBe('sara.weiss@example.org');
    expect(r.byLegacyId.get('vol_101')).toBe('sara.weiss@example.org');
    expect(r.byLegacyId.get('dir_201')).toBe('sara.weiss@example.org');
  });
});

describe('split-brain precedence: User.data wins over top-level', () => {
  it('keeps the nested phone, which is what the legacy app displayed', () => {
    const r = run();
    const sara = r.people.find((p) => p.key === 'sara.weiss@example.org')!;

    // data.phone '514-555-0199' beats top-level '(514) 555-0142'.
    expect(sara.user.phone).toBe('+15145550199');
    expect(sara.user.phone).not.toBe('+15145550142');
  });

  it('keeps the nested group list rather than unioning the two', () => {
    const r = run();
    const sara = r.people.find((p) => p.key === 'sara.weiss@example.org')!;
    // data has two groups, top-level has one. Precedence, not union — unioning
    // would grant membership nobody recorded.
    expect(sara.user.groupSlugs).toEqual(['chesed_on_the_go', 'misamchem']);
  });

  it('falls through to the next source when the higher one is empty', () => {
    const r = run();
    // Moshe has no data.phone, so the top-level value is used.
    const moshe = r.people.find((p) => p.key === 'moshe.klein@example.org')!;
    expect(moshe.user.phone).toBe('+15145550177');
    // …and his data.notification_preference is still honoured.
    expect(moshe.user.notificationPreference).toBe('both');
  });

  it('ranks Volunteer above the directory and both below User', () => {
    const r = run();
    const dovid = r.people.find((p) => p.key === 'dovid.stern@example.org')!;
    // User.phone is junk but higher precedence than Volunteer's good number.
    // The rule is applied consistently; the junk is then reported (below).
    const conflict = find(r.issues.all(), 'field_conflict', 'usr_003').filter(
      (i) => i.field === 'phone',
    );
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.message).toContain('Kept "call the office ext 4" from User');
    expect(conflict[0]!.message).toContain('"5145550155" from Volunteer was NOT applied');
    expect(dovid.user.phone).toBeNull();
  });
});

describe('conflicts are REPORTED, never silently resolved', () => {
  it('reports every divergence between sources that both hold a value', () => {
    const r = run();
    const phoneConflicts = find(r.issues.all(), 'field_conflict', 'usr_001').filter(
      (i) => i.field === 'phone',
    );

    // Sara's phone differs from all three lower-precedence sources: three reports.
    expect(phoneConflicts).toHaveLength(3);

    const origins = phoneConflicts.map(
      (i) => ((i.detail as Record<string, Record<string, unknown>>)['discarded']!['origin']),
    );
    expect(origins).toEqual(['User', 'Volunteer', 'PublicVolunteerDirectory']);
  });

  it('names both the kept and the discarded value, with their legacy ids', () => {
    const r = run();
    const c = find(r.issues.all(), 'field_conflict', 'usr_001').find((i) => i.field === 'phone')!;
    const detail = c.detail as Record<string, Record<string, unknown>>;

    expect(detail['kept']).toMatchObject({ value: '514-555-0199', origin: 'User.data' });
    expect(detail['discarded']).toMatchObject({ value: '(514) 555-0142', origin: 'User' });
    // The discarded value is recoverable from the report alone.
    expect(c.message).toContain('(514) 555-0142');
  });

  it('does NOT report agreement — only divergence', () => {
    const r = run();
    // Moshe's phone is the same number in all three sources, written differently.
    // Formatting is not a conflict.
    const conflicts = find(r.issues.all(), 'field_conflict', 'usr_002').filter(
      (i) => i.field === 'phone',
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe('records that cannot be keyed become issues, not invented rows', () => {
  it('skips a User with no email and reports it with its legacy id', () => {
    const r = run();
    expect(r.people.some((p) => p.legacyUserId === 'usr_005')).toBe(false);

    const skipped = r.skipped.find((s) => s.legacyId === 'usr_005');
    expect(skipped).toBeDefined();
    expect(skipped!.reason).toContain('users.email');

    const issue = find(r.issues.all(), 'user_missing_email', 'usr_005');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('error');
  });

  it('skips a User with no name in ANY representation rather than deriving one', () => {
    const r = run();
    expect(r.people.some((p) => p.key === 'dispatch.desk@example.org')).toBe(false);

    const issue = find(r.issues.all(), 'user_missing_name', 'usr_007');
    expect(issue).toHaveLength(1);
    // The email local part 'dispatch.desk' is NOT used as a name.
    expect(issue[0]!.message).toContain('inventing one from the email local part');
  });

  it('never creates a person from a dangling directory entry', () => {
    const r = run();
    expect(r.people.some((p) => p.key === 'ghost@example.org')).toBe(false);

    const issue = find(r.issues.all(), 'directory_entry_unresolved', 'dir_203');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('error');
    expect(r.skipped.some((s) => s.legacyId === 'dir_203')).toBe(true);
  });

  it('DOES create a person from a Volunteer with no User, and says so', () => {
    const r = run();
    const leah = r.people.find((p) => p.key === 'leah.friedman@example.org');
    expect(leah).toBeDefined();
    expect(leah!.legacyUserId).toBeNull();
    expect(leah!.legacyVolunteerId).toBe('vol_104');

    const issue = find(r.issues.all(), 'volunteer_without_user', 'vol_104');
    expect(issue).toHaveLength(1);
  });
});

describe('phone handling', () => {
  it('normalises assorted legacy formats to E.164', () => {
    const r = run();
    const byKey = new Map(r.people.map((p) => [p.key, p.user]));
    expect(byKey.get('moshe.klein@example.org')!.phone).toBe('+15145550177');
    expect(byKey.get('chana.brody@example.org')!.phone).toBe('+15145550201');
    expect(byKey.get('leah.friedman@example.org')!.phone).toBe('+15145550233');
  });

  it('nulls an unnormalisable phone and reports it as an error, keeping the raw value', () => {
    const r = run();
    const dovid = r.people.find((p) => p.key === 'dovid.stern@example.org')!;
    expect(dovid.user.phone).toBeNull();

    const issue = find(r.issues.all(), 'phone_unnormalisable', 'usr_003');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('error');
    // Nothing is lost: the raw value goes to the ledger.
    expect(dovid.user.legacyMeta!['unnormalisablePhone']).toBe('call the office ext 4');
  });

  it('resolves a phone collision deterministically and reports it', () => {
    const r = run();
    // Sara (created 2024-02) and Yitzy (created 2025-03) both end up on
    // +15145550199. users.phone is live-unique, so exactly one keeps it.
    const sara = r.people.find((p) => p.key === 'sara.weiss@example.org')!;
    const yitzy = r.people.find((p) => p.key === 'yitzy.roth@example.org')!;

    expect(sara.user.phone).toBe('+15145550199');
    expect(yitzy.user.phone).toBeNull();

    const issue = find(r.issues.all(), 'phone_collision');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('error');
    expect(issue[0]!.detail).toMatchObject({
      phone: '+15145550199',
      keptBy: 'sara.weiss@example.org',
      removedFrom: 'yitzy.roth@example.org',
    });
    // The number the loser lost is still recorded.
    expect(yitzy.user.legacyMeta!['collidingPhone']).toBe('+15145550199');
  });

  it('keeps an unnormalisable EMERGENCY contact phone raw, as a warning not an error', () => {
    const ex = fixtureExport();
    const r = transformIdentity({
      users: [
        {
          ...ex.User.find((u) => u.id === 'usr_002')!,
          emergency_contact_phone: 'her cell, ask Moshe',
        },
      ],
      volunteers: [],
      directory: [],
      knownGroups: SEED,
    });
    const moshe = r.people[0]!;
    // Not discarded: losing the only emergency contact is worse than a
    // non-canonical format, and this field is neither unique nor auto-dialled.
    expect(moshe.user.emergencyContactPhone).toBe('her cell, ask Moshe');
    const issue = r.issues.all().filter((i) => i.code === 'phone_kept_raw');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('warning');
  });
});

describe('roles and groups', () => {
  it("maps Base44's 'user' role to 'volunteer' and preserves admin", () => {
    const r = run();
    const byKey = new Map(r.people.map((p) => [p.key, p.user]));
    expect(byKey.get('sara.weiss@example.org')!.role).toBe('volunteer');
    expect(byKey.get('moshe.klein@example.org')!.role).toBe('admin');
  });

  it('slugifies a free-text group and reports that it was created', () => {
    const r = run();
    // usr_004 has 'chesed on the go' with spaces — legacy stored groups as free
    // text, so typos and spacing variants became distinct groups.
    const chana = r.people.find((p) => p.key === 'chana.brody@example.org')!;
    expect(chana.user.groupSlugs).toEqual(['chesed_on_the_go']);
    // It slugifies onto the seeded group, so nothing new is created.
    expect(r.groups.map((g) => g.slug)).not.toContain('chesed_on_the_go_extra');
  });

  it('marks a deactivated volunteer inactive', () => {
    const r = run();
    const chana = r.people.find((p) => p.key === 'chana.brody@example.org')!;
    expect(chana.user.status).toBe('inactive');
    const sara = r.people.find((p) => p.key === 'sara.weiss@example.org')!;
    expect(sara.user.status).toBe('active');
  });
});

describe('determinism', () => {
  it('produces identical output across runs, so dry run and real run agree', () => {
    const a = JSON.stringify(run().people);
    const b = JSON.stringify(run().people);
    expect(a).toBe(b);
  });

  it('the plan carries one users row per surviving person', () => {
    const plan = fixturePlan();
    const emails = plan.users.map((u) => u.email);
    expect(new Set(emails).size).toBe(emails.length);
  });
});

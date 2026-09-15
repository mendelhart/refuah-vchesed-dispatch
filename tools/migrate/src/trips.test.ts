/**
 * Trips: the ambiguous assignee, colliding call_ids, and the unreachable
 * `offered` status.
 */
import { describe, expect, it } from 'vitest';

import { transformTrips } from './transform/trips.js';
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
  const identity = transformIdentity({
    users: ex.User,
    volunteers: ex.Volunteer,
    directory: ex.PublicVolunteerDirectory,
    knownGroups: SEED,
  });
  return transformTrips({
    trips: ex.Trip,
    lookups: {
      byLegacyId: identity.byLegacyId,
      byPhone: identity.byPhone,
      byName: identity.byName,
      volunteerLegacyIds: new Set(ex.Volunteer.map((v) => v.id)),
      knownGroupSlugs: new Set(identity.groups.map((g) => g.slug)),
    },
  });
}

const find = (issues: readonly Issue[], code: string, legacyId?: string): Issue[] =>
  issues.filter((i) => i.code === code && (legacyId === undefined || i.legacyId === legacyId));

const trip = (r: ReturnType<typeof run>, id: string) =>
  r.trips.find((t) => t.legacyId === id);

// ---------------------------------------------------------------------------

describe('assigned_volunteer_id holds ids from two different entities', () => {
  it('resolves a User id silently — it is the id the column was meant to hold', () => {
    const r = run();
    expect(trip(r, 'trip_302')!.assignedVolunteerKey).toBe('moshe.klein@example.org');
    // No fallback issue: nothing surprising happened.
    expect(
      find(r.issues.all(), 'trip_assignee_resolved_by_fallback', 'trip_302'),
    ).toHaveLength(0);
  });

  it('resolves a VOLUNTEER id via that Volunteer’s email, and reports the fallback', () => {
    const r = run();
    // trip_301 was assigned from the dispatcher dropdown, which wrote a
    // Volunteer id into a column the SMS path filled with User ids.
    expect(trip(r, 'trip_301')!.assignedVolunteerKey).toBe('sara.weiss@example.org');

    const issue = find(r.issues.all(), 'trip_assignee_resolved_by_fallback', 'trip_301');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.message).toContain('is a legacy Volunteer id, not a User id');
    expect(issue[0]!.detail).toMatchObject({ rawId: 'vol_101', resolvedTo: 'sara.weiss@example.org' });
  });

  it('records HOW the assignee was resolved, in the row itself', () => {
    const r = run();
    expect(trip(r, 'trip_301')!.legacyMeta!['assigneeResolutionPath']).toBe('volunteer_id');
    expect(trip(r, 'trip_302')!.legacyMeta!['assigneeResolutionPath']).toBe('user_id');
    expect(trip(r, 'trip_308')!.legacyMeta!['assigneeResolutionPath']).toBe('name');
  });

  it('falls back to an unambiguous name match and flags it for verification', () => {
    const r = run();
    // trip_308's id is dead, but the name identifies exactly one person.
    expect(trip(r, 'trip_308')!.assignedVolunteerKey).toBe('dovid.stern@example.org');

    const issue = find(r.issues.all(), 'trip_assignee_resolved_by_fallback', 'trip_308');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.message).toContain('Verify this assignment');
  });
});

describe('unresolvable references become issues, NOT nulls', () => {
  it('reports an unresolvable assignee as an ERROR rather than quietly nulling it', () => {
    const r = run();
    const t = trip(r, 'trip_303')!;

    // The trip survives — history is preserved — but with no assignee.
    expect(t).toBeDefined();
    expect(t.assignedVolunteerKey).toBeNull();

    const issue = find(r.issues.all(), 'trip_unresolved_assignee', 'trip_303');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('error');
    // The report carries everything needed to chase it down by hand.
    expect(issue[0]!.detail).toMatchObject({
      rawId: 'vol_777_deleted',
      name: 'Someone Who Left',
      phone: '418-555-9999',
    });
    // And the raw id is preserved on the row.
    expect(t.legacyMeta!['legacyAssignedVolunteerId']).toBe('vol_777_deleted');
  });

  it('demotes a status that asserts a volunteer nobody could resolve', () => {
    const r = run();
    // trip_303 was 'accepted' with an unresolvable assignee. 'accepted' with
    // nobody accepting is a lie the new state machine would propagate.
    expect(trip(r, 'trip_303')!.status).toBe('pending');
    expect(find(r.issues.all(), 'trip_status_demoted', 'trip_303')).toHaveLength(1);
  });

  it('never invents an assignee for a resolvable-looking but dead reference', () => {
    const r = run();
    // No trip ends up pointing at a person the legacy data did not name.
    for (const t of r.trips) {
      if (t.assignedVolunteerKey !== null) {
        expect(t.legacyMeta!['assigneeResolutionPath']).not.toBe('none');
      }
    }
  });

  it('creates a trip_assignments row only when the assignee resolved', () => {
    const r = run();
    const assignedTripIds = r.assignments.map((a) => a.tripLegacyId);
    expect(assignedTripIds).toContain('trip_301');
    expect(assignedTripIds).not.toContain('trip_303');
    // Marked 'import' so nobody mistakes it for a recorded dispatcher action.
    expect(r.assignments.every((a) => a.source === 'import')).toBe(true);
  });
});

describe('colliding 4-digit call_ids', () => {
  it('detects the collision and names every trip involved', () => {
    const r = run();
    expect(r.callIdCollisions.get('4821')).toEqual(['trip_301', 'trip_302']);

    const issue = find(r.issues.all(), 'call_id_collision');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('error');
    expect(issue[0]!.detail).toMatchObject({ callId: '4821' });
  });

  it('re-issues a unique reference to every trip', () => {
    const r = run();
    const refs = r.trips.map((t) => t.reference);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs.every((ref) => /^RVC-\d{6}-\d{4}$/.test(ref))).toBe(true);
  });

  it('keeps the legacy call_id in metadata, never as an identifier', () => {
    const r = run();
    const t = trip(r, 'trip_301')!;
    expect(t.legacyMeta!['legacyCallId']).toBe('4821');
    expect(t.legacyMeta!['callIdCollided']).toBe(true);
    // The reference does not embed the legacy value.
    expect(t.reference).not.toContain('4821');
  });

  it('gives colliding trips DIFFERENT references', () => {
    const r = run();
    expect(trip(r, 'trip_301')!.reference).not.toBe(trip(r, 'trip_302')!.reference);
  });

  it('generates the same references on a second run (dry run == real run)', () => {
    const a = run().trips.map((t) => `${t.legacyId}:${t.reference}`);
    const b = run().trips.map((t) => `${t.legacyId}:${t.reference}`);
    expect(a).toEqual(b);
  });
});

describe('the unreachable `offered` status', () => {
  it("maps legacy 'offered' onto 'pending' rather than fabricating offer records", () => {
    const r = run();
    const t = trip(r, 'trip_304')!;
    expect(t.status).toBe('pending');
    expect(t.legacyMeta!['legacyStatus']).toBe('offered');
  });

  it('reports the remap, explaining why offers cannot be reconstructed', () => {
    const r = run();
    const issue = find(r.issues.all(), 'trip_status_remapped', 'trip_304');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.message).toContain('hashed');
    expect(issue[0]!.message).toContain('fabricating them');
  });
});

describe('history is preserved', () => {
  it('imports completed and cancelled trips with their timestamps', () => {
    const r = run();

    const completed = trip(r, 'trip_302')!;
    expect(completed.status).toBe('completed');
    expect(completed.completedAt?.toISOString()).toBe('2025-01-14T10:25:00.000Z');
    expect(completed.acceptedAt?.toISOString()).toBe('2025-01-13T20:10:00.000Z');
    expect(completed.createdAt?.toISOString()).toBe('2025-01-13T19:50:00.000Z');

    const cancelled = trip(r, 'trip_305')!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt?.toISOString()).toBe('2024-12-08T09:12:00.000Z');
    expect(cancelled.cancelledByKey).toBe('moshe.klein@example.org');
    expect(cancelled.cancellationReason).toContain('Passenger admitted overnight');
  });

  it('keeps a completed trip completed even when its assignee is unresolvable', () => {
    const ex = fixtureExport();
    const identity = transformIdentity({
      users: ex.User,
      volunteers: ex.Volunteer,
      directory: ex.PublicVolunteerDirectory,
      knownGroups: SEED,
    });
    const r = transformTrips({
      trips: [
        {
          ...ex.Trip.find((t) => t.id === 'trip_302')!,
          assigned_volunteer_id: 'nobody_at_all',
          assigned_volunteer_name: 'Nobody At All',
          assigned_volunteer_phone: undefined,
        },
      ],
      lookups: {
        byLegacyId: identity.byLegacyId,
        byPhone: identity.byPhone,
        byName: identity.byName,
        volunteerLegacyIds: new Set(ex.Volunteer.map((v) => v.id)),
        knownGroupSlugs: new Set(identity.groups.map((g) => g.slug)),
      },
    });
    // The work demonstrably happened; erasing that would rewrite history.
    expect(r.trips[0]!.status).toBe('completed');
    expect(r.trips[0]!.assignedVolunteerKey).toBeNull();
    expect(find(r.issues.all(), 'trip_unresolved_assignee')).toHaveLength(1);
  });
});

describe('missing required fields skip the row and report it', () => {
  it('skips a trip with no pickup time', () => {
    const r = run();
    expect(trip(r, 'trip_306')).toBeUndefined();
    const s = r.skipped.find((x) => x.legacyId === 'trip_306');
    expect(s).toBeDefined();
    expect(s!.reason).toContain('pickup_at');
    expect(find(r.issues.all(), 'trip_missing_pickup_time', 'trip_306')[0]!.severity).toBe('error');
  });

  it('skips a trip with no volunteer group rather than guessing one', () => {
    const r = run();
    expect(trip(r, 'trip_307')).toBeUndefined();
    const issue = find(r.issues.all(), 'trip_missing_group', 'trip_307');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.message).toContain('never offered it');
  });
});

describe('addresses and phones', () => {
  it('builds pickup and dropoff address rows from the component fields', () => {
    const r = run();
    const t = trip(r, 'trip_301')!;
    const pickup = r.addresses.find((a) => a.key === t.pickupAddressKey)!;
    expect(pickup.line1).toBe('5700 Avenue Victoria');
    expect(pickup.unit).toBe('3');
    expect(pickup.city).toBe('Montreal');
    expect(pickup.postalCode).toBe('H3W 2R1');
  });

  it('normalises the caller phone to E.164', () => {
    const r = run();
    expect(trip(r, 'trip_301')!.callerPhone).toBe('+15145550310');
  });

  it('preserves an unrecognised mobility need in the notes instead of dropping it', () => {
    const r = run();
    const t = trip(r, 'trip_305')!;
    expect(t.mobilityNeeds).toEqual(['oxygen']);
    expect(t.passengerNotes).toContain('nebulizer');
    expect(find(r.issues.all(), 'unknown_enum_value', 'trip_305')).toHaveLength(1);
  });
});

describe('plan-level integrity', () => {
  it('every trip points at an address key that exists in the plan', () => {
    const plan = fixturePlan();
    const keys = new Set(plan.addresses.map((a) => a.key));
    for (const t of plan.trips) {
      expect(keys.has(t.pickupAddressKey)).toBe(true);
      expect(keys.has(t.dropoffAddressKey)).toBe(true);
    }
  });

  it('every trip points at a group that exists in the plan', () => {
    const plan = fixturePlan();
    const slugs = new Set(plan.groups.map((g) => g.slug));
    for (const t of plan.trips) expect(slugs.has(t.groupSlug)).toBe(true);
  });

  it('every assigned volunteer key corresponds to an imported user', () => {
    const plan = fixturePlan();
    const emails = new Set(plan.users.map((u) => u.email));
    for (const t of plan.trips) {
      if (t.assignedVolunteerKey !== null) expect(emails.has(t.assignedVolunteerKey)).toBe(true);
    }
  });
});

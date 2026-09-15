/**
 * The remaining transforms: contacts, vehicles, calls, templates, org info,
 * recurring tasks, and the legacy audit trail.
 */
import { describe, expect, it } from 'vitest';

import { transformVehicles } from './transform/vehicles.js';
import {
  transformCalls,
  transformContacts,
  transformOrganizationInfo,
  transformRecurringTasks,
  transformTextTemplates,
} from './transform/contacts.js';
import { transformAudit, LEGACY_AUDIT_MARKER } from './transform/audit.js';
import { fixtureExport, fixturePlan } from './fixtures.test-helpers.js';
import type { Issue } from './issues.js';

const find = (issues: readonly Issue[], code: string, legacyId?: string): Issue[] =>
  issues.filter((i) => i.code === code && (legacyId === undefined || i.legacyId === legacyId));

// ---------------------------------------------------------------------------

describe('contacts', () => {
  const run = () => transformContacts({ contacts: fixtureExport().Contact });

  it('normalises a well-formed phone to E.164', () => {
    const r = run();
    expect(r.contacts.find((c) => c.legacyId === 'con_701')!.phone).toBe('+15143408222');
  });

  it('KEEPS an unnormalisable contact phone raw, and warns', () => {
    const r = run();
    const c = r.contacts.find((x) => x.legacyId === 'con_702')!;
    // contacts.phone is NOT NULL, not unique-indexed, and dialled by a human —
    // so preserving what the admin typed beats discarding the only way to reach
    // this person. The opposite call is made for users.phone; both are argued
    // in the code and reported here.
    expect(c.phone).toBe('ask at the office');
    const issue = find(r.issues.all(), 'phone_kept_raw', 'con_702');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.severity).toBe('warning');
    expect(c.legacyMeta!['unnormalisedPhone']).toBe('ask at the office');
  });

  it('skips a nameless contact and reports it with its id', () => {
    const r = run();
    expect(r.contacts.some((c) => c.legacyId === 'con_703')).toBe(false);
    expect(r.skipped.find((s) => s.legacyId === 'con_703')).toBeDefined();
  });
});

describe('vehicles', () => {
  const run = () => transformVehicles({ vehicles: fixtureExport().Vehicle });

  it('maps legacy types and statuses onto the new vocabulary', () => {
    const r = run();
    const v = r.vehicles.find((x) => x.legacyId === 'veh_601')!;
    expect(v.label).toBe('Red Sienna');
    expect(v.vehicleType).toBe('van');
    expect(v.status).toBe('available');
    expect(v.capacity).toBe(7);
    expect(v.plate).toBe('ABC 123');
  });

  it('falls back to the fleet id when a vehicle has no name', () => {
    const r = run();
    expect(r.vehicles.find((x) => x.legacyId === 'veh_603')!.label).toBe('RVC-03');
  });

  it('refuses to import a duplicate label rather than hiding one vehicle', () => {
    const r = run();
    expect(r.vehicles.some((v) => v.legacyId === 'veh_604')).toBe(false);
    const issue = find(r.issues.all(), 'missing_required_field', 'veh_604');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.message).toContain('cannot tell them apart');
  });

  it('does not turn current_driver_name into a relationship', () => {
    const r = run();
    const v = r.vehicles.find((x) => x.legacyId === 'veh_602')!;
    // Creating a second source of truth for who has which vehicle is the exact
    // class of defect the new schema removes. Kept as a note instead.
    expect(v.notes).toContain('Moshe Klein');
    expect(v.notes).toContain('not linked to a user');
  });
});

describe('masked calls', () => {
  const run = () => {
    const plan = fixturePlan();
    return transformCalls({
      calls: fixtureExport().MaskedCall,
      byLegacyId: new Map(
        plan.people.flatMap((p) =>
          [p.legacyUserId, p.legacyVolunteerId, p.legacyDirectoryId]
            .filter((x): x is string => x !== null)
            .map((id) => [id, p.key] as [string, string]),
        ),
      ),
      byEmail: new Map(plan.users.map((u) => [u.email, u.email])),
      importedTripIds: new Set(plan.trips.map((t) => t.legacyId)),
    });
  };

  it('reads the NDJSON fixture at all', () => {
    expect(fixtureExport().MaskedCall).toHaveLength(4);
  });

  it('retains only the last four digits of the destination', () => {
    const r = run();
    const c = r.calls.find((x) => x.legacyId === 'call_c01')!;
    expect(c.destinationLast4).toBe('0310');
    // The full number is not carried into the calls table.
    expect(JSON.stringify(c)).not.toContain('5145550310');
  });

  it('does not claim an authorization basis the legacy app never recorded', () => {
    const r = run();
    expect(r.calls.every((c) => c.authorizationBasis === 'legacy_import:basis_not_recorded')).toBe(
      true,
    );
  });

  it('skips a call whose initiator cannot be resolved', () => {
    const r = run();
    expect(r.calls.some((c) => c.legacyId === 'call_c03')).toBe(false);
    const issue = find(r.issues.all(), 'actor_unresolved', 'call_c03');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.message).toContain("someone else's call");
  });

  it('keeps a call whose trip was skipped, with a null trip reference', () => {
    const r = run();
    // trip_306 was skipped (no pickup time), so the call cannot point at it.
    const c = r.calls.find((x) => x.legacyId === 'call_c04')!;
    expect(c.tripLegacyId).toBeNull();
    expect(c.legacyMeta!['legacyTripId']).toBe('trip_306');
  });

  it("maps 'no-answer' onto the new status and sets a failure reason", () => {
    const r = run();
    const c = r.calls.find((x) => x.legacyId === 'call_c02')!;
    expect(c.status).toBe('no_answer');
    expect(c.failureReason).toBe('no_answer');
  });
});

describe('text templates become settings rows', () => {
  const run = () => transformTextTemplates({ templates: fixtureExport().TextTemplate });

  it('keys each template under templates.<key>', () => {
    const r = run();
    expect(r.settings.map((s) => s.key)).toContain('templates.trip_offer_sms');
    expect(r.settings.map((s) => s.key)).toContain('templates.trip_accepted_sms');
  });

  it('preserves the content verbatim, placeholders and all', () => {
    const r = run();
    const s = r.settings.find((x) => x.key === 'templates.trip_offer_sms')!;
    expect((s.value as Record<string, unknown>)['content']).toContain('{call_id}');
  });

  it('skips a template with no key and reports it', () => {
    const r = run();
    expect(r.skipped.find((s) => s.legacyId === 'tpl_903')).toBeDefined();
  });
});

describe('organization info', () => {
  const run = () => transformOrganizationInfo({ rows: fixtureExport().OrganizationInfo });

  it('imports the row the legacy UI actually used, and composes the address', () => {
    const r = run();
    expect(r.org!.name).toBe("Refuah V'Chesed");
    expect(r.org!.phone).toBe('+15145550100');
    expect(r.org!.addressLine).toBe('5785 Avenue Victoria, Unit 200, Montreal, QC, H3W 2R3');
  });

  it('reports the rows the legacy screen could never reach', () => {
    const r = run();
    const issue = find(r.issues.all(), 'duplicate_merged', 'org_802');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.message).toContain('orgInfo[0]');
    expect(r.skipped.find((s) => s.legacyId === 'org_802')).toBeDefined();
  });

  it('keeps fields with no column in the details blob rather than dropping them', () => {
    const r = run();
    expect(r.org!.details['charityNumber']).toBe('123456789RR0001');
    expect(r.org!.details['missionStatement']).toContain('appointments');
  });
});

describe('recurring tasks have no target table', () => {
  const run = () => transformRecurringTasks({ tasks: fixtureExport().RecurringTask });

  it('lists every task individually with its full definition', () => {
    const r = run();
    expect(r.skipped).toHaveLength(2);
    const issue = find(r.issues.all(), 'entity_not_migrated', 'rec_a01')[0]!;
    expect(issue.detail).toMatchObject({
      taskName: 'Weekly dialysis run — Mr. Gross',
      frequency: 'weekly',
      dayOfWeek: 'tuesday',
    });
  });

  it('is a warning, not an error — a scope decision is not a data defect', () => {
    const r = run();
    expect(r.issues.errorCount).toBe(0);
  });
});

describe('legacy audit rows are imported but NOT presented as trustworthy', () => {
  const run = () => {
    const plan = fixturePlan();
    return transformAudit({
      logs: fixtureExport().AuditLog,
      byLegacyId: new Map(),
      byEmail: new Map(plan.users.map((u) => [u.email, u.email])),
    });
  };

  it("sets actorRole to 'system' on every row", () => {
    const r = run();
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.events.every((e) => e.actorRole === 'system')).toBe(true);
  });

  it('NEVER populates actorUserId, even when the claimed actor resolves cleanly', () => {
    const r = run();
    // aud_b01 claims sara.weiss@example.org, who exists. Attribution is still
    // withheld: the legacy app never verified the claim.
    const e = r.events.find((x) => x.legacyId === 'aud_b01')!;
    expect(e.actorUserId).toBeNull();
    expect(
      (e.metadata['claimedActor'] as Record<string, unknown>)['resolvesTo'],
    ).toBe('sara.weiss@example.org');
    expect((e.metadata['claimedActor'] as Record<string, unknown>)['verified']).toBe(false);

    expect(r.events.every((x) => x.actorUserId === null)).toBe(true);
  });

  it('marks the metadata legacy-imported and client-asserted', () => {
    const r = run();
    for (const e of r.events) {
      expect(e.metadata['legacyImported']).toBe(true);
      expect(e.metadata['clientAsserted']).toBe(true);
      expect(e.metadata['source']).toBe('base44');
      expect(String(e.metadata['trustworthiness'])).toContain('UNVERIFIED');
    }
    expect(LEGACY_AUDIT_MARKER.clientAsserted).toBe(true);
  });

  it('carries the caveat in actorName, so a bare UI render still shows it', () => {
    const r = run();
    const e = r.events.find((x) => x.legacyId === 'aud_b01')!;
    expect(e.actorName).toBe('Sara Weiss (claimed, legacy import)');
  });

  it('does not put the client-supplied ip into the ip column', () => {
    const r = run();
    const e = r.events.find((x) => x.legacyId === 'aud_b01')!;
    expect(e.ip).toBeNull();
    expect(e.metadata['legacyIpAddress']).toBe('203.0.113.7');
  });

  it('refuses to stamp a migration-time timestamp on an undated row', () => {
    const r = run();
    expect(r.events.some((e) => e.legacyId === 'aud_b04')).toBe(false);
    const issue = find(r.issues.all(), 'unparsable_timestamp', 'aud_b04');
    expect(issue).toHaveLength(1);
    expect(issue[0]!.message).toContain('did not');
  });

  it('notes when a claimed actor does not exist, without changing the import', () => {
    const r = run();
    const issue = find(r.issues.all(), 'actor_unresolved', 'aud_b03');
    expect(issue).toHaveLength(1);
    // The row is still imported — the claim is recorded as a claim.
    expect(r.events.some((e) => e.legacyId === 'aud_b03')).toBe(true);
  });

  it('preserves occurredAt from the legacy created_date', () => {
    const r = run();
    const e = r.events.find((x) => x.legacyId === 'aud_b01')!;
    expect(e.occurredAt.toISOString()).toBe('2025-01-13T18:02:05.000Z');
  });
});

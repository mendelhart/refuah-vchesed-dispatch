/**
 * Orchestration: legacy export in, a complete `MigrationPlan` out.
 *
 * Still pure — no database, no filesystem, no clock beyond what the rows
 * themselves carry. The loader turns a plan into SQL; the reporter turns the
 * same plan into a report. Both see exactly what the tests see.
 */
import { SEED_GROUPS } from '@rvc/shared';

import type { LegacyEntityName, LegacyExport } from '../types.js';
import { type Issue, type SkippedRecord } from '../issues.js';
import type {
  TargetAddress,
  TargetAuditEvent,
  TargetCall,
  TargetContact,
  TargetEquipment,
  TargetEquipmentCategory,
  TargetEquipmentLoan,
  TargetGroup,
  TargetOrganizationInfo,
  TargetSetting,
  TargetTrip,
  TargetTripAssignment,
  TargetUser,
  TargetVehicle,
} from '../target.js';

import { transformIdentity, type ResolvedPerson } from './identity.js';
import { transformTrips } from './trips.js';
import { transformEquipment } from './equipment.js';
import { transformVehicles } from './vehicles.js';
import {
  transformCalls,
  transformContacts,
  transformOrganizationInfo,
  transformRecurringTasks,
  transformTextTemplates,
} from './contacts.js';
import { transformAudit } from './audit.js';

export interface MigrationPlan {
  groups: TargetGroup[];
  users: TargetUser[];
  people: ResolvedPerson[];
  addresses: TargetAddress[];
  trips: TargetTrip[];
  tripAssignments: TargetTripAssignment[];
  contacts: TargetContact[];
  vehicles: TargetVehicle[];
  equipmentCategories: TargetEquipmentCategory[];
  equipment: TargetEquipment[];
  equipmentLoans: TargetEquipmentLoan[];
  calls: TargetCall[];
  auditEvents: TargetAuditEvent[];
  settings: TargetSetting[];
  organizationInfo: TargetOrganizationInfo | null;
  issues: Issue[];
  skipped: SkippedRecord[];
  /** Rows imported in their own right, per legacy entity. Denominator comes from the reader. */
  importedCounts: Record<string, number>;
  /** Rows folded into a row another entity created (the three-way person merge). */
  mergedCounts: Record<string, number>;
  /** Legacy call_id -> the trips that shared it. */
  callIdCollisions: Map<string, string[]>;
}

export function buildPlan(input: LegacyExport): MigrationPlan {
  const issues: Issue[] = [];
  const skipped: SkippedRecord[] = [];

  // --- 1. Identity, first: everything else points at people ---------------
  const identity = transformIdentity({
    users: input.User,
    volunteers: input.Volunteer,
    directory: input.PublicVolunteerDirectory,
    knownGroups: SEED_GROUPS.map((g) => ({ slug: g.slug, name: g.name })),
  });
  issues.push(...identity.issues.all());
  skipped.push(...identity.skipped);

  // Which legacy ids belong to the Volunteer id space — lets the trip
  // transform report *how* an ambiguous assignee was resolved.
  const volunteerLegacyIds = new Set<string>(input.Volunteer.map((v) => v.id));

  // --- 2. Trips -----------------------------------------------------------
  const knownGroupSlugs = new Set(identity.groups.map((g) => g.slug));
  const trips = transformTrips({
    trips: input.Trip,
    lookups: {
      byLegacyId: identity.byLegacyId,
      byPhone: identity.byPhone,
      byName: identity.byName,
      volunteerLegacyIds,
      knownGroupSlugs,
    },
  });
  issues.push(...trips.issues.all());
  skipped.push(...trips.skipped);

  const groups: TargetGroup[] = [...identity.groups];
  for (const g of trips.newGroups) {
    if (!groups.some((x) => x.slug === g.slug)) {
      groups.push({ legacyId: `group:${g.slug}`, slug: g.slug, name: g.name, active: true });
    }
  }

  // --- 3. Everything else -------------------------------------------------
  const equipment = transformEquipment({
    equipment: input.Equipment,
    categories: input.EquipmentCategory,
  });
  issues.push(...equipment.issues.all());
  skipped.push(...equipment.skipped);

  const vehicles = transformVehicles({ vehicles: input.Vehicle });
  issues.push(...vehicles.issues.all());
  skipped.push(...vehicles.skipped);

  const contacts = transformContacts({ contacts: input.Contact });
  issues.push(...contacts.issues.all());
  skipped.push(...contacts.skipped);

  const importedTripIds = new Set(trips.trips.map((t) => t.legacyId));
  const calls = transformCalls({
    calls: input.MaskedCall,
    byLegacyId: identity.byLegacyId,
    byEmail: identity.byEmail,
    importedTripIds,
  });
  issues.push(...calls.issues.all());
  skipped.push(...calls.skipped);

  const templates = transformTextTemplates({ templates: input.TextTemplate });
  issues.push(...templates.issues.all());
  skipped.push(...templates.skipped);

  const org = transformOrganizationInfo({ rows: input.OrganizationInfo });
  issues.push(...org.issues.all());
  skipped.push(...org.skipped);

  const recurring = transformRecurringTasks({ tasks: input.RecurringTask });
  issues.push(...recurring.issues.all());
  skipped.push(...recurring.skipped);

  const audit = transformAudit({
    logs: input.AuditLog,
    byLegacyId: identity.byLegacyId,
    byEmail: identity.byEmail,
  });
  issues.push(...audit.issues.all());
  skipped.push(...audit.skipped);

  // Accounting for the three-way merge, per legacy entity:
  //   imported = source rows that produced a users row in their own right
  //   merged   = source rows folded into a users row another entity created
  // A Volunteer with a matching User is merged; a Volunteer with no User is
  // imported. Directory rows are never authoritative, so they are only ever
  // merged or skipped.
  const importedCounts: Record<LegacyEntityName | string, number> = {
    User: identity.people.filter((p) => p.legacyUserId !== null).length,
    Volunteer: identity.people.filter(
      (p) => p.legacyVolunteerId !== null && p.legacyUserId === null,
    ).length,
    PublicVolunteerDirectory: 0,
    Trip: trips.trips.length,
    Equipment: equipment.equipment.length,
    EquipmentCategory: equipment.categories.length,
    Vehicle: vehicles.vehicles.length,
    Contact: contacts.contacts.length,
    MaskedCall: calls.calls.length,
    TextTemplate: templates.settings.length,
    AuditLog: audit.events.length,
    OrganizationInfo: org.org === null ? 0 : 1,
    RecurringTask: 0,
  };

  /** Source rows folded into a users row that another entity created. */
  const mergedCounts: Record<string, number> = {
    Volunteer: identity.people.filter(
      (p) => p.legacyVolunteerId !== null && p.legacyUserId !== null,
    ).length,
    PublicVolunteerDirectory: identity.people.filter((p) => p.legacyDirectoryId !== null).length,
  };

  return {
    mergedCounts,
    groups,
    users: identity.people.map((p) => p.user),
    people: identity.people,
    addresses: trips.addresses,
    trips: trips.trips,
    tripAssignments: trips.assignments,
    contacts: contacts.contacts,
    vehicles: vehicles.vehicles,
    equipmentCategories: equipment.categories,
    equipment: equipment.equipment,
    equipmentLoans: equipment.loans,
    calls: calls.calls,
    auditEvents: audit.events,
    settings: templates.settings,
    organizationInfo: org.org,
    issues,
    skipped,
    importedCounts,
    callIdCollisions: trips.callIdCollisions,
  };
}

export { transformIdentity } from './identity.js';
export { transformTrips } from './trips.js';
export { transformEquipment } from './equipment.js';
export { transformVehicles } from './vehicles.js';
export {
  transformContacts,
  transformCalls,
  transformTextTemplates,
  transformOrganizationInfo,
  transformRecurringTasks,
} from './contacts.js';
export { transformAudit, LEGACY_AUDIT_MARKER } from './audit.js';
export type { ResolvedPerson, IdentityResult } from './identity.js';

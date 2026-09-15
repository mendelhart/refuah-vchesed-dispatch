/**
 * Vehicles.
 *
 * The legacy Vehicle carried two identity fields (`name` and `vehicle_id`) and
 * two capability flags (`wheelchair_accessible`, `stretcher_capable`) that the
 * new schema folds into `vehicle_type`. It also carried `current_driver_name`,
 * a free-text field that duplicated assignment state already held on trips;
 * that is not migrated into any relationship — doing so would create a second
 * source of truth for who has which vehicle, which is the class of defect this
 * whole schema change exists to remove. It is preserved as a note.
 */
import type { LegacyVehicle } from '../types.js';
import { IssueCollector, type SkippedRecord } from '../issues.js';
import type { TargetVehicle } from '../target.js';
import * as N from '../normalize.js';

const STATUS_MAP: Readonly<Record<string, string>> = {
  available: 'available',
  active: 'available',
  in_use: 'in_use',
  inuse: 'in_use',
  assigned: 'in_use',
  maintenance: 'maintenance',
  repair: 'maintenance',
  retired: 'retired',
  inactive: 'retired',
  sold: 'retired',
};

const TYPE_MAP: Readonly<Record<string, string>> = {
  standard: 'standard',
  sedan: 'standard',
  car: 'standard',
  van: 'van',
  minivan: 'van',
  suv: 'suv',
  wheelchair: 'wheelchair_accessible',
  wheelchair_accessible: 'wheelchair_accessible',
  accessible: 'wheelchair_accessible',
  stretcher: 'stretcher',
  ambulette: 'stretcher',
};

export interface VehiclesResult {
  vehicles: TargetVehicle[];
  skipped: SkippedRecord[];
  issues: IssueCollector;
}

export function transformVehicles(input: { vehicles: LegacyVehicle[] }): VehiclesResult {
  const issues = new IssueCollector();
  const skipped: SkippedRecord[] = [];
  const vehicles: TargetVehicle[] = [];
  const seenLabels = new Map<string, string>();

  for (const v of input.vehicles) {
    // `vehicles.label` is NOT NULL. Prefer the human name; fall back to the
    // fleet id, which is still something an operator typed.
    const label = N.text(v.name) ?? N.text(v.vehicle_id) ?? N.text(v.license_plate);
    if (label === null) {
      const reason =
        'Vehicle has no name, vehicle_id or license_plate; `vehicles.label` is NOT NULL and ' +
        'there is nothing to call this vehicle.';
      skipped.push({ entity: 'Vehicle', legacyId: v.id, reason, code: 'missing_required_field' });
      issues.error('missing_required_field', 'Vehicle', v.id, reason, { field: 'label' });
      continue;
    }

    const labelKey = label.toLowerCase();
    const prior = seenLabels.get(labelKey);
    if (prior !== undefined) {
      const reason =
        `Vehicle label '${label}' duplicates vehicle ${prior}; \`vehicles_label_live_uq\` ` +
        'forbids two live vehicles with the same label. Not imported — two vehicles sharing a ' +
        'name means a dispatcher cannot tell them apart, and merging them would hide one.';
      skipped.push({ entity: 'Vehicle', legacyId: v.id, reason, code: 'missing_required_field' });
      issues.error('missing_required_field', 'Vehicle', v.id, reason, {
        field: 'label',
        detail: { label, keptBy: prior },
      });
      continue;
    }
    seenLabels.set(labelKey, v.id);

    // Type: explicit field first, then the capability flags. A stretcher-capable
    // vehicle outranks a wheelchair-accessible one because it is the stronger
    // capability and the trip matcher treats it as a superset.
    const explicit = N.mapEnum(v.vehicle_type, TYPE_MAP, 'standard');
    let vehicleType = explicit.value;
    if (explicit.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'Vehicle',
        v.id,
        `Unrecognised vehicle_type ${JSON.stringify(explicit.raw)}; falling back to the ` +
          `capability flags, then to 'standard'.`,
        { field: 'vehicleType', detail: { raw: explicit.raw } },
      );
    }
    if (explicit.raw === null || explicit.fellBack) {
      if (N.bool(v.stretcher_capable) === true) vehicleType = 'stretcher';
      else if (N.bool(v.wheelchair_accessible) === true) vehicleType = 'wheelchair_accessible';
    } else if (
      vehicleType === 'standard' &&
      (N.bool(v.stretcher_capable) === true || N.bool(v.wheelchair_accessible) === true)
    ) {
      issues.warn(
        'field_conflict',
        'Vehicle',
        v.id,
        `Vehicle '${label}' has vehicle_type '${explicit.raw}' but also carries ` +
          `${N.bool(v.stretcher_capable) === true ? 'stretcher_capable' : 'wheelchair_accessible'}=true. ` +
          `The explicit vehicle_type is kept; the capability flag is recorded in notes so a ` +
          `dispatcher can still see it.`,
        { field: 'vehicleType' },
      );
    }

    const statusRes = N.mapEnum(v.status, STATUS_MAP, 'available');
    if (statusRes.fellBack) {
      issues.warn(
        'unknown_enum_value',
        'Vehicle',
        v.id,
        `Unrecognised vehicle status ${JSON.stringify(statusRes.raw)}; imported as 'available'.`,
        { field: 'status', detail: { raw: statusRes.raw } },
      );
    }

    const notes = [
      N.text(v.maintenance_notes),
      N.text(v.current_driver_name) !== null
        ? `[migrated] legacy current_driver_name: ${N.text(v.current_driver_name)} — not linked ` +
          `to a user; assignment now lives on trips.`
        : null,
      N.bool(v.wheelchair_accessible) === true && vehicleType !== 'wheelchair_accessible'
        ? '[migrated] legacy flag: wheelchair accessible'
        : null,
      N.bool(v.stretcher_capable) === true && vehicleType !== 'stretcher'
        ? '[migrated] legacy flag: stretcher capable'
        : null,
      N.text(v.vehicle_id) !== null && N.text(v.name) !== null
        ? `[migrated] fleet id: ${N.text(v.vehicle_id)}`
        : null,
    ].filter((x): x is string => x !== null);

    vehicles.push({
      legacyId: v.id,
      legacyMeta: {
        legacyVehicleId: N.text(v.vehicle_id),
        legacyStatus: N.text(v.status),
        legacyCurrentDriverName: N.text(v.current_driver_name),
        wheelchairAccessible: N.bool(v.wheelchair_accessible),
        stretcherCapable: N.bool(v.stretcher_capable),
      },
      label,
      vehicleType,
      plate: N.text(v.license_plate),
      capacity: N.int(v.capacity),
      status: statusRes.value,
      notes: notes.length > 0 ? notes.join('\n') : null,
      lastMaintenanceAt: N.timestamp(v.last_maintenance_date).value,
      nextMaintenanceAt: N.timestamp(v.next_maintenance_date).value,
      createdAt: N.timestamp(v.created_date).value,
    });
  }

  return { vehicles, skipped, issues };
}

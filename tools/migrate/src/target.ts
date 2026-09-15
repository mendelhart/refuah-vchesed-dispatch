/**
 * Target row shapes.
 *
 * Deliberately plain objects rather than drizzle `$inferInsert` types: the
 * transforms must be pure and unit-testable without a database or a drizzle
 * import, and the loader is the single place that maps these onto the schema.
 * Every row carries the legacy id that produced it; the loader writes that id
 * into the import ledger, which is what makes re-running idempotent.
 */

export interface WithLegacy {
  /** Legacy Base44 primary key. The idempotency key for this row. */
  legacyId: string;
  /** Extra provenance written to the ledger alongside `legacyId`. */
  legacyMeta?: Record<string, unknown>;
}

export interface TargetGroup extends WithLegacy {
  slug: string;
  name: string;
  active: boolean;
}

export interface TargetUser extends WithLegacy {
  email: string;
  fullName: string;
  phone: string | null;
  role: string;
  status: string;
  notificationPreference: string;
  preferredVehicleType: string | null;
  photoUrl: string | null;
  addressLine: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  availability: Record<string, unknown> | null;
  createdAt: Date | null;
  /** Group slugs this person belongs to; becomes user_groups rows. */
  groupSlugs: string[];
}

export interface TargetAddress {
  /** Synthetic key, unique within the plan; the loader maps it to a uuid. */
  key: string;
  line1: string;
  unit: string | null;
  city: string;
  province: string;
  postalCode: string | null;
  notes: string | null;
}

export interface TargetTrip extends WithLegacy {
  reference: string;
  status: string;
  priority: string;
  tripType: string;
  assignmentMode: string;
  groupSlug: string;
  callerName: string | null;
  callerPhone: string | null;
  pickupAddressKey: string;
  dropoffAddressKey: string;
  pickupAt: Date;
  mobilityNeeds: string[];
  passengerNotes: string | null;
  /** Email key of the assignee, or null when unresolved. */
  assignedVolunteerKey: string | null;
  assignedAt: Date | null;
  acceptedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledByKey: string | null;
  cancellationReason: string | null;
  createdAt: Date | null;
}

export interface TargetTripAssignment extends WithLegacy {
  tripLegacyId: string;
  volunteerKey: string;
  source: string;
  assignedAt: Date;
  unassignedAt: Date | null;
  unassignedReason: string | null;
}

export interface TargetContact extends WithLegacy {
  name: string;
  phone: string;
  role: string | null;
  notes: string | null;
  createdAt: Date | null;
}

export interface TargetVehicle extends WithLegacy {
  label: string;
  vehicleType: string;
  plate: string | null;
  capacity: number | null;
  status: string;
  notes: string | null;
  lastMaintenanceAt: Date | null;
  nextMaintenanceAt: Date | null;
  createdAt: Date | null;
}

export interface TargetEquipmentCategory extends WithLegacy {
  name: string;
  description: string | null;
  createdAt: Date | null;
}

export interface TargetEquipment extends WithLegacy {
  categoryLegacyId: string | null;
  itemCode: string | null;
  barcode: string | null;
  equipmentType: string;
  status: string;
  condition: string;
  notes: string | null;
  createdAt: Date | null;
}

export interface TargetEquipmentLoan extends WithLegacy {
  equipmentLegacyId: string;
  borrowerName: string;
  borrowerPhone: string;
  borrowerAddress: string | null;
  loanedAt: Date;
  expectedReturnAt: Date | null;
  returnedAt: Date | null;
  notes: string | null;
}

export interface TargetCall extends WithLegacy {
  initiatedByKey: string;
  tripLegacyId: string | null;
  direction: string;
  counterpartyType: string;
  counterpartyUserKey: string | null;
  destinationLast4: string | null;
  counterpartyName: string | null;
  failureReason: string | null;
  providerSid: string | null;
  status: string;
  durationSeconds: number | null;
  authorizationBasis: string;
  errorMessage: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface TargetAuditEvent extends WithLegacy {
  occurredAt: Date;
  actorUserId: null;
  actorName: string;
  actorRole: 'system';
  action: string;
  entityType: string;
  entityId: string;
  previous: unknown;
  next: unknown;
  metadata: Record<string, unknown>;
  ip: string | null;
}

export interface TargetSetting extends WithLegacy {
  key: string;
  value: unknown;
  description: string | null;
}

export interface TargetOrganizationInfo extends WithLegacy {
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  addressLine: string | null;
  emergencyContact: string | null;
  details: Record<string, unknown>;
}

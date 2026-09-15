/**
 * Zod schemas describing the LEGACY Base44 export shape.
 *
 * These describe what the old system actually emitted, warts and all — not what
 * we wish it had emitted. Two rules apply throughout:
 *
 *   1. TOLERANT. Unknown fields are ignored (zod object default), and every
 *      field except the primary key is optional. A Base44 export is not a
 *      schema-validated artefact; screens wrote whichever subset of fields they
 *      knew about, so almost nothing is reliably present.
 *   2. NON-DESTRUCTIVE. We never coerce a bad value into a good one here.
 *      `z.coerce` and `.default()` are used only where the absence of a value is
 *      genuinely equivalent to the default (e.g. an absent array is an empty
 *      array). Anything ambiguous is carried through as-is and decided in
 *      `transform/`, where the decision can be reported.
 *
 * Field names were recovered from the legacy application source (pages/,
 * components/, functions/) by reading how each entity is written and read.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Anything the export might put where a string belongs. Kept verbatim. */
const loose = z.unknown().optional();

/**
 * A string field as Base44 emits it: often absent, often null, occasionally a
 * number (phone numbers and item codes were sometimes stored unquoted).
 */
const str = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined ? undefined : String(v)));

/** An ISO-ish timestamp. Kept as a string; parsing happens in transform. */
const ts = str;

const bool = z.union([z.boolean(), z.string(), z.number(), z.null()]).optional();

/** A string array that may arrive as null, a single string, or be absent. */
const strArray = z
  .union([z.array(z.union([z.string(), z.number()])), z.string(), z.null()])
  .optional()
  .transform((v): string[] => {
    if (v === null || v === undefined) return [];
    if (typeof v === 'string') return v.trim() === '' ? [] : [v];
    return v.map(String);
  });

/** Every Base44 record carries these. `id` is the only thing we can rely on. */
const base44Base = {
  id: z.string(),
  created_date: ts,
  updated_date: ts,
  created_by: str,
};

// ---------------------------------------------------------------------------
// User
//
// THE SPLIT-BRAIN ENTITY. Every profile field exists twice: once top-level and
// once inside `data`. Admin screens (VolunteerDirectory) wrote top-level via
// `User.update(id, {...})`; self-service screens (Settings, NotificationSettings,
// MyAvailability) wrote nested via `auth.updateMe({ data: {...} })`. The reading
// code overwhelmingly resolves `u.data?.x || u.x`, so the nested copy is what
// the application actually displayed. See transform/identity.ts for the
// precedence rule and its justification.
// ---------------------------------------------------------------------------

const userProfileFields = {
  full_name: str,
  phone: str,
  role: str,
  active_volunteer: bool,
  volunteer_groups: strArray,
  preferred_vehicle_type: str,
  preferred_vehicle_name: str,
  vehicle_id: str,
  notification_preference: str,
  availability: loose,
  photo_url: str,
  profile_photo_url: str,
  address: str,
  emergency_contact_name: str,
  emergency_contact_phone: str,
  certifications: strArray,
  join_date: ts,
  total_trips_completed: z.union([z.number(), z.string(), z.null()]).optional(),
  push_subscription: loose,
};

export const LegacyUserSchema = z.object({
  ...base44Base,
  email: str,
  ...userProfileFields,
  /** The shadow copy. Same field names, written by a different set of screens. */
  data: z.object(userProfileFields).partial().nullish(),
});
export type LegacyUser = z.infer<typeof LegacyUserSchema>;

/** The names of the fields that exist in both places — drives conflict detection. */
export const SPLIT_BRAIN_FIELDS = Object.keys(userProfileFields) as Array<
  keyof typeof userProfileFields
>;

// ---------------------------------------------------------------------------
// Volunteer
//
// A SECOND representation of the same human, produced by functions/syncVolunteers.ts.
// Keyed on email only; it carries NO back-reference to the User it was copied
// from, which is why `Trip.assigned_volunteer_id` became ambiguous — the
// dispatcher's assign dropdown (Trips.jsx: `Volunteer.filter({active:true})`)
// wrote Volunteer ids into a field the SMS webhook filled with User ids.
// ---------------------------------------------------------------------------

export const LegacyVolunteerSchema = z.object({
  ...base44Base,
  email: str,
  full_name: str,
  phone: str,
  role: str,
  active: bool,
  groups: strArray,
  vehicle_preference: str,
});
export type LegacyVolunteer = z.infer<typeof LegacyVolunteerSchema>;

// ---------------------------------------------------------------------------
// PublicVolunteerDirectory
//
// A THIRD representation, produced by functions/syncPublicDirectory.ts. Keyed on
// `user_id`. It only ever copied TOP-LEVEL User fields, so where the top-level
// and nested copies diverged this directory shows the stale one — which is why
// it ranks last in the merge precedence.
// ---------------------------------------------------------------------------

export const LegacyPublicVolunteerDirectorySchema = z.object({
  ...base44Base,
  user_id: str,
  full_name: str,
  email: str,
  phone: str,
  role: str,
  groups: strArray,
  photo_url: str,
  active: bool,
});
export type LegacyPublicVolunteerDirectory = z.infer<
  typeof LegacyPublicVolunteerDirectorySchema
>;

// ---------------------------------------------------------------------------
// Trip
// ---------------------------------------------------------------------------

/** `interested_volunteers` on a trip in admin_approval mode. */
export const LegacyInterestedVolunteerSchema = z.object({
  volunteer_id: str,
  volunteer_name: str,
  marked_at: ts,
});

export const LegacyTripSchema = z.object({
  ...base44Base,

  /** 4-digit `Math.floor(1000 + Math.random()*9000)`. Collides by construction. */
  call_id: str,

  status: str,
  trip_type: str,
  assignment_mode: str,
  volunteer_group: str,

  caller_name: str,
  caller_phone: str,

  pickup_address: str,
  pickup_street_number: str,
  pickup_street_name: str,
  pickup_unit: str,
  pickup_city: str,
  pickup_province: str,
  pickup_postal_code: str,
  pickup_notes: str,

  dropoff_address: str,
  dropoff_street_number: str,
  dropoff_street_name: str,
  dropoff_unit: str,
  dropoff_city: str,
  dropoff_province: str,
  dropoff_postal_code: str,
  dropoff_notes: str,

  pickup_time: ts,
  mobility_needs: strArray,
  passenger_notes: str,

  /**
   * AMBIGUOUS BY CONSTRUCTION: sometimes a `User.id`, sometimes a `Volunteer.id`.
   * Resolved in transform/trips.ts against both id spaces and, failing that, by
   * name/phone.
   */
  assigned_volunteer_id: str,
  assigned_volunteer_name: str,
  assigned_volunteer_phone: str,

  accepted_at: ts,
  completed_at: ts,
  cancelled_at: ts,
  cancelled_by_id: str,
  cancelled_by_name: str,
  cancellation_reason: str,

  sms_sent_at: ts,
  nudge_count: z.union([z.number(), z.string(), z.null()]).optional(),
  last_nudge_at: ts,

  distance_km: z.union([z.number(), z.string(), z.null()]).optional(),
  street_name_only: str,

  interested_volunteers: z
    .union([z.array(LegacyInterestedVolunteerSchema), z.null()])
    .optional()
    .transform((v) => v ?? []),
});
export type LegacyTrip = z.infer<typeof LegacyTripSchema>;

// ---------------------------------------------------------------------------
// Equipment & categories
//
// Loan state is SMEARED ACROSS THE ITEM ROW (borrower_name, borrower_phone,
// date_out, expected_return_date, actual_return_date) with a parallel
// `loan_history` array that Equipment.jsx mutates in place. Turned into
// equipment_loans rows in transform/equipment.ts.
// ---------------------------------------------------------------------------

export const LegacyLoanHistoryEntrySchema = z.object({
  borrower_name: str,
  borrower_phone: str,
  borrower_address: str,
  date_out: ts,
  date_returned: ts,
  expected_return_date: ts,
  notes: str,
});
export type LegacyLoanHistoryEntry = z.infer<typeof LegacyLoanHistoryEntrySchema>;

export const LegacyEquipmentSchema = z.object({
  ...base44Base,
  category_id: str,
  category_name: str,
  type: str,
  item_id: str,
  barcode: str,
  serial_number: str,
  status: str,
  condition: str,
  notes: str,

  // Loan state smeared onto the item.
  borrower_name: str,
  borrower_phone: str,
  borrower_address: str,
  date_out: ts,
  expected_return_date: ts,
  actual_return_date: ts,

  damage_reported: bool,
  damage_report: str,
  damage_reported_at: ts,

  loan_history: z
    .union([z.array(LegacyLoanHistoryEntrySchema), z.null()])
    .optional()
    .transform((v) => v ?? []),
});
export type LegacyEquipment = z.infer<typeof LegacyEquipmentSchema>;

export const LegacyEquipmentCategorySchema = z.object({
  ...base44Base,
  name: str,
  description: str,
  total_quantity: z.union([z.number(), z.string(), z.null()]).optional(),
  available_quantity: z.union([z.number(), z.string(), z.null()]).optional(),
  track_individually: bool,
});
export type LegacyEquipmentCategory = z.infer<typeof LegacyEquipmentCategorySchema>;

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export const LegacyVehicleSchema = z.object({
  ...base44Base,
  name: str,
  vehicle_id: str,
  vehicle_type: str,
  license_plate: str,
  capacity: z.union([z.number(), z.string(), z.null()]).optional(),
  status: str,
  wheelchair_accessible: bool,
  stretcher_capable: bool,
  current_driver_name: str,
  maintenance_notes: str,
  last_maintenance_date: ts,
  next_maintenance_date: ts,
});
export type LegacyVehicle = z.infer<typeof LegacyVehicleSchema>;

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const LegacyContactSchema = z.object({
  ...base44Base,
  name: str,
  phone: str,
  role: str,
  notes: str,
});
export type LegacyContact = z.infer<typeof LegacyContactSchema>;

// ---------------------------------------------------------------------------
// MaskedCall
// ---------------------------------------------------------------------------

export const LegacyMaskedCallSchema = z.object({
  ...base44Base,
  call_sid: str,
  caller_id: str,
  caller_name: str,
  caller_email: str,
  caller_role: str,
  recipient_type: str,
  recipient_phone: str,
  recipient_name: str,
  recipient_id: str,
  trip_id: str,
  status: str,
  call_type: str,
  duration: z.union([z.number(), z.string(), z.null()]).optional(),
  initiated_at: ts,
  ended_at: ts,
  forwarded_at: ts,
  forwarded_by: str,
  error_message: str,
});
export type LegacyMaskedCall = z.infer<typeof LegacyMaskedCallSchema>;

// ---------------------------------------------------------------------------
// TextTemplate
// ---------------------------------------------------------------------------

export const LegacyTextTemplateSchema = z.object({
  ...base44Base,
  template_key: str,
  template_name: str,
  template_content: str,
  category: str,
  description: str,
  available_variables: strArray,
});
export type LegacyTextTemplate = z.infer<typeof LegacyTextTemplateSchema>;

// ---------------------------------------------------------------------------
// RecurringTask
// ---------------------------------------------------------------------------

export const LegacyRecurringTaskSchema = z.object({
  ...base44Base,
  task_name: str,
  task_type: str,
  frequency: str,
  day_of_week: str,
  time: str,
  pickup_address: str,
  dropoff_address: str,
  volunteer_group: str,
  assigned_volunteer_id: str,
  assigned_volunteer_name: str,
  details: str,
  active: bool,
  cancelled_dates: strArray,
});
export type LegacyRecurringTask = z.infer<typeof LegacyRecurringTaskSchema>;

// ---------------------------------------------------------------------------
// AuditLog
//
// CLIENT-ASSERTED. In the legacy app any signed-in browser could POST an
// AuditLog row with an arbitrary `performed_by`; Equipment.jsx does exactly that
// from the client. These rows are imported for continuity but must never be
// presented as trustworthy attribution. See transform/audit.ts.
// ---------------------------------------------------------------------------

export const LegacyAuditLogSchema = z.object({
  ...base44Base,
  action: str,
  entity_type: str,
  entity_id: str,
  description: str,
  performed_by: str,
  performed_by_name: str,
  previous_value: loose,
  new_value: loose,
  ip_address: str,
  location: str,
});
export type LegacyAuditLog = z.infer<typeof LegacyAuditLogSchema>;

// ---------------------------------------------------------------------------
// OrganizationInfo
// ---------------------------------------------------------------------------

export const LegacyOrganizationInfoSchema = z.object({
  ...base44Base,
  organization_name: str,
  charity_number: str,
  street_number: str,
  street_name: str,
  unit: str,
  city: str,
  province: str,
  postal_code: str,
  phone: str,
  email: str,
  website: str,
  description: str,
  mission_statement: str,
  hours_of_operation: str,
  emergency_contact: str,
  logo_url: str,
});
export type LegacyOrganizationInfo = z.infer<typeof LegacyOrganizationInfoSchema>;

// ---------------------------------------------------------------------------
// The export as a whole
// ---------------------------------------------------------------------------

export const LEGACY_ENTITIES = {
  Trip: LegacyTripSchema,
  User: LegacyUserSchema,
  Volunteer: LegacyVolunteerSchema,
  PublicVolunteerDirectory: LegacyPublicVolunteerDirectorySchema,
  Vehicle: LegacyVehicleSchema,
  Equipment: LegacyEquipmentSchema,
  EquipmentCategory: LegacyEquipmentCategorySchema,
  RecurringTask: LegacyRecurringTaskSchema,
  Contact: LegacyContactSchema,
  MaskedCall: LegacyMaskedCallSchema,
  TextTemplate: LegacyTextTemplateSchema,
  AuditLog: LegacyAuditLogSchema,
  OrganizationInfo: LegacyOrganizationInfoSchema,
} as const;

export type LegacyEntityName = keyof typeof LEGACY_ENTITIES;

export const LEGACY_ENTITY_NAMES = Object.keys(LEGACY_ENTITIES) as LegacyEntityName[];

/** The parsed export: every entity, always present, possibly empty. */
export interface LegacyExport {
  Trip: LegacyTrip[];
  User: LegacyUser[];
  Volunteer: LegacyVolunteer[];
  PublicVolunteerDirectory: LegacyPublicVolunteerDirectory[];
  Vehicle: LegacyVehicle[];
  Equipment: LegacyEquipment[];
  EquipmentCategory: LegacyEquipmentCategory[];
  RecurringTask: LegacyRecurringTask[];
  Contact: LegacyContact[];
  MaskedCall: LegacyMaskedCall[];
  TextTemplate: LegacyTextTemplate[];
  AuditLog: LegacyAuditLog[];
  OrganizationInfo: LegacyOrganizationInfo[];
}

export function emptyExport(): LegacyExport {
  return {
    Trip: [],
    User: [],
    Volunteer: [],
    PublicVolunteerDirectory: [],
    Vehicle: [],
    Equipment: [],
    EquipmentCategory: [],
    RecurringTask: [],
    Contact: [],
    MaskedCall: [],
    TextTemplate: [],
    AuditLog: [],
    OrganizationInfo: [],
  };
}

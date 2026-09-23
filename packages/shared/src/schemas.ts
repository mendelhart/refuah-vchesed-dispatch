/**
 * Validation schemas shared by the API and the web client.
 *
 * The API validates every request body with these; the web client uses the same
 * objects for form validation, so the two cannot drift.
 */
import { z } from 'zod';
import {
  ADDRESS_LABELS,
  RECURRING_RIDE_STATUSES,
  ASSIGNMENT_MODES,
  AVAILABILITY_EXCEPTION_KINDS,
  CALLER_STATUSES,
  DUTY_KINDS,
  EXPORT_KINDS,
  MOBILITY_NEEDS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_PREFERENCES,
  RECURRENCE_FREQUENCIES,
  ROLES,
  THREAD_STATUSES,
  TRIP_PRIORITIES,
  TRIP_STATUSES,
  TRIP_TYPES,
  USER_STATUSES,
  VOLUNTEER_CAPABILITIES,
} from './domain.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const uuidSchema = z.string().uuid();

/**
 * Phone numbers are stored in E.164. Input is tolerant (the dispatcher types
 * what the caller says) but normalisation happens before persistence, and the
 * normalised value must match this.
 */
export const e164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone number must be in international format, e.g. +15145551234');

export const phoneInputSchema = z
  .string()
  .trim()
  .min(7, 'Phone number is too short')
  .max(25, 'Phone number is too long');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200, 'Password is too long');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type Pagination = z.infer<typeof paginationSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(120),
  phone: phoneInputSchema,
});

export const requestPasswordResetSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

// ---------------------------------------------------------------------------
// Addresses
//
// Fixes the legacy defect where a typed address was discarded in favour of
// rebuilt components: `line1` is required and authoritative, components are
// optional enrichment from the geocoder.
// ---------------------------------------------------------------------------

export const addressSchema = z.object({
  line1: z.string().trim().min(3, 'Enter a street address').max(200),
  unit: z.string().trim().max(40).optional().nullable(),
  city: z.string().trim().max(100).default('Montreal'),
  province: z.string().trim().max(40).default('QC'),
  postalCode: z.string().trim().max(20).optional().nullable(),
  country: z.string().trim().max(2).default('CA'),
  notes: z.string().trim().max(500).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});
export type AddressInput = z.infer<typeof addressSchema>;

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

const futureIsh = (d: Date) => d.getTime() > Date.now() - 1000 * 60 * 60 * 24 * 365;

const jobCardFields = {
  /** Existing directory entry, when the dispatcher picked a repeat caller. */
  callerId: uuidSchema.optional().nullable(),
  /** Number to reach about this trip — often a ward desk, not the caller. */
  callbackNumber: phoneInputSchema.optional().nullable(),
  /** The appointment the ride exists for, when it differs from pickup. */
  appointmentAt: z.coerce.date().optional().nullable(),
  pickupEntrance: z.string().trim().max(300).optional().nullable(),
  pickupParking: z.string().trim().max(300).optional().nullable(),
  dropoffEntrance: z.string().trim().max(300).optional().nullable(),
  dropoffParking: z.string().trim().max(300).optional().nullable(),
};

export const createTripSchema = z
  .object({
    ...jobCardFields,
    callerName: z.string().trim().max(120).optional().nullable(),
    callerPhone: phoneInputSchema.optional().nullable(),
    pickup: addressSchema,
    dropoff: addressSchema,
    pickupAt: z.coerce.date().refine(futureIsh, 'Pickup time is implausibly far in the past'),
    tripType: z.enum(TRIP_TYPES).default('ride'),
    priority: z.enum(TRIP_PRIORITIES).default('routine'),
    groupSlug: z.string().trim().min(1).max(60),
    assignmentMode: z.enum(ASSIGNMENT_MODES).default('auto'),
    mobilityNeeds: z.array(z.enum(MOBILITY_NEEDS)).max(6).default([]),
    passengerNotes: z.string().trim().max(2000).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    // Hospital-food runs have no named passenger; every other type must.
    if (val.tripType !== 'hospital_food') {
      if (!val.callerName) {
        ctx.addIssue({ code: 'custom', path: ['callerName'], message: 'Caller name is required' });
      }
      if (!val.callerPhone) {
        ctx.addIssue({ code: 'custom', path: ['callerPhone'], message: 'Caller phone is required' });
      }
    }
  });
export type CreateTripInput = z.infer<typeof createTripSchema>;

export const updateTripSchema = z.object({
  ...jobCardFields,
  callerName: z.string().trim().max(120).optional().nullable(),
  callerPhone: phoneInputSchema.optional().nullable(),
  pickup: addressSchema.optional(),
  dropoff: addressSchema.optional(),
  pickupAt: z.coerce.date().optional(),
  tripType: z.enum(TRIP_TYPES).optional(),
  priority: z.enum(TRIP_PRIORITIES).optional(),
  groupSlug: z.string().trim().min(1).max(60).optional(),
  assignmentMode: z.enum(ASSIGNMENT_MODES).optional(),
  mobilityNeeds: z.array(z.enum(MOBILITY_NEEDS)).max(6).optional(),
  passengerNotes: z.string().trim().max(2000).optional().nullable(),
  /** Optimistic concurrency: the version the editor last saw. */
  version: z.number().int().nonnegative().optional(),
});
export type UpdateTripInput = z.infer<typeof updateTripSchema>;

export const listTripsSchema = paginationSchema.extend({
  status: z
    .union([z.enum(TRIP_STATUSES), z.array(z.enum(TRIP_STATUSES))])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  scope: z.enum(['board', 'mine', 'available', 'history']).default('board'),
  groupSlug: z.string().trim().max(60).optional(),
  search: z.string().trim().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListTripsQuery = z.infer<typeof listTripsSchema>;

// --- transitions -----------------------------------------------------------

export const offerTripSchema = z.object({
  /** Omit to let targeting choose; naming people overrides it. */
  volunteerIds: z.array(uuidSchema).max(500).optional(),
  expiresInMinutes: z.number().int().min(1).max(24 * 60).optional(),
  /** Deliberate override: ask everyone in the group regardless of the filters. */
  ignoreTargeting: z.boolean().optional(),
});

export const duplicateTripSchema = z.object({
  pickupAt: z.coerce.date().optional(),
  priority: z.enum(TRIP_PRIORITIES).optional(),
  passengerNotes: z.string().trim().max(2000).optional().nullable(),
});

export const assignTripSchema = z.object({
  volunteerId: uuidSchema,
  reason: z.string().trim().max(500).optional(),
});

export const claimTripSchema = z.object({
  /** Present when accepting from an SMS/push deep link. */
  offerToken: z.string().min(20).max(120).optional(),
});

export const reassignTripSchema = z.object({
  volunteerId: uuidSchema,
  reason: z.string().trim().min(1, 'Give a reason so the record makes sense later').max(500),
});

export const cancelTripSchema = z.object({
  reason: z.string().trim().min(1, 'A cancellation reason is required').max(500),
});

export const simpleTransitionSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const createUserSchema = z.object({
  email: emailSchema,
  fullName: z.string().trim().min(2).max(120),
  phone: phoneInputSchema.optional().nullable(),
  role: z.enum(ROLES).default('volunteer'),
  groupSlugs: z.array(z.string().trim().max(60)).max(20).default([]),
  status: z.enum(USER_STATUSES).default('active'),
  sendInvite: z.boolean().default(true),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: phoneInputSchema.optional().nullable(),
  groupSlugs: z.array(z.string().trim().max(60)).max(20).optional(),
  status: z.enum(USER_STATUSES).optional(),
  preferredVehicleType: z.string().trim().max(60).optional().nullable(),
  emergencyContactName: z.string().trim().max(120).optional().nullable(),
  emergencyContactPhone: phoneInputSchema.optional().nullable(),
  addressLine: z.string().trim().max(200).optional().nullable(),
  photoUrl: z.string().trim().url().max(500).optional().nullable(),
});

/** Role changes are a separate, admin-only, separately-audited operation. */
export const changeRoleSchema = z.object({ role: z.enum(ROLES) });

export const updateMeSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  navHidden: z.array(z.string().trim().min(1).max(120)).max(80).optional(),
  phone: phoneInputSchema.optional().nullable(),
  notificationPreference: z.enum(NOTIFICATION_PREFERENCES).optional(),
  emergencyContactName: z.string().trim().max(120).optional().nullable(),
  emergencyContactPhone: phoneInputSchema.optional().nullable(),
  addressLine: z.string().trim().max(200).optional().nullable(),
  availability: z
    .record(
      z.enum(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']),
      z.object({
        available: z.boolean(),
        from: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        to: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      }),
    )
    .optional(),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(300), auth: z.string().max(300) }),
  userAgent: z.string().max(300).optional(),
});

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

export const startCallSchema = z.object({
  tripId: uuidSchema.optional(),
  counterparty: z.enum(['caller', 'volunteer', 'contact']),
  /** Only meaningful for `contact`; never a raw caller-supplied phone number. */
  contactId: uuidSchema.optional(),
});
export type StartCallInput = z.infer<typeof startCallSchema>;

// ---------------------------------------------------------------------------
// Contacts, vehicles, equipment
// ---------------------------------------------------------------------------

export const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: phoneInputSchema,
  role: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  /** Optional postal address; one form captures everything known about the contact. */
  address: addressSchema.optional().nullable(),
});

export const vehicleSchema = z.object({
  label: z.string().trim().min(1).max(80),
  vehicleType: z.string().trim().max(60).default('standard'),
  plate: z.string().trim().max(20).optional().nullable(),
  capacity: z.number().int().min(0).max(60).optional().nullable(),
  status: z.string().trim().max(30).default('available'),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const equipmentSchema = z.object({
  categoryId: uuidSchema.optional().nullable(),
  itemCode: z.string().trim().max(60).optional().nullable(),
  barcode: z.string().trim().max(80).optional().nullable(),
  equipmentType: z.string().trim().max(60),
  condition: z.string().trim().max(30).default('good'),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const loanEquipmentSchema = z.object({
  borrowerName: z.string().trim().min(2).max(120),
  borrowerPhone: phoneInputSchema,
  borrowerAddress: z.string().trim().max(200).optional().nullable(),
  expectedReturnAt: z.coerce.date().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const updateSettingSchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean()]),
});

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

export const callerSchema = z.object({
  name: z.string().trim().min(2, 'Enter the caller’s name').max(120),
  primaryPhone: phoneInputSchema.optional().nullable(),
  alternatePhone: phoneInputSchema.optional().nullable(),
  email: emailSchema.optional().nullable(),
  language: z.enum(['en', 'fr', 'yi', 'he']).default('en'),
  notes: z.string().trim().max(2000).optional().nullable(),
  accessNotes: z.string().trim().max(1000).optional().nullable(),
});

export const updateCallerSchema = callerSchema.partial().extend({
  status: z.enum(CALLER_STATUSES).optional(),
});

export const callerAddressSchema = addressSchema.extend({
  label: z.enum(ADDRESS_LABELS).default('home'),
  entrance: z.string().trim().max(300).optional().nullable(),
  parking: z.string().trim().max(300).optional().nullable(),
  isDefaultPickup: z.boolean().default(false),
});

export const callerSearchSchema = z.object({
  q: z.string().trim().min(2, 'Type at least two characters').max(60),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

// ---------------------------------------------------------------------------
// Availability, services and capabilities
// ---------------------------------------------------------------------------

export const availabilityWindowSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .refine((w) => w.endMinute > w.startMinute, {
    message: 'An availability window must end after it starts',
    path: ['endMinute'],
  });

export const setAvailabilitySchema = z.object({
  windows: z.array(availabilityWindowSchema).max(40),
});

export const availabilityExceptionSchema = z
  .object({
    kind: z.enum(AVAILABILITY_EXCEPTION_KINDS).default('unavailable'),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().trim().max(200).optional().nullable(),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'The end must be after the start',
    path: ['endsAt'],
  });

export const setServicesSchema = z.object({
  services: z.array(z.string().trim().min(1).max(60)).max(20),
});

export const setCapabilitiesSchema = z.object({
  capabilities: z.array(z.enum(VOLUNTEER_CAPABILITIES)).max(10),
});

// ---------------------------------------------------------------------------
// Recurring rides
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const recurringRideSchema = z
  .object({
    callerId: uuidSchema.optional().nullable(),
    callerName: z.string().trim().max(120).optional().nullable(),
    callerPhone: phoneInputSchema.optional().nullable(),
    callbackNumber: phoneInputSchema.optional().nullable(),
    pickup: addressSchema,
    dropoff: addressSchema,
    pickupEntrance: z.string().trim().max(300).optional().nullable(),
    pickupParking: z.string().trim().max(300).optional().nullable(),
    dropoffEntrance: z.string().trim().max(300).optional().nullable(),
    dropoffParking: z.string().trim().max(300).optional().nullable(),
    tripType: z.enum(TRIP_TYPES).default('ride'),
    priority: z.enum(TRIP_PRIORITIES).default('routine'),
    groupSlug: z.string().trim().min(1).max(60),
    mobilityNeeds: z.array(z.enum(MOBILITY_NEEDS)).max(6).default([]),
    passengerNotes: z.string().trim().max(2000).optional().nullable(),
    appointmentOffsetMinutes: z.number().int().min(-480).max(480).optional().nullable(),
    frequency: z.enum(RECURRENCE_FREQUENCIES).default('weekly'),
    byWeekday: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    byMonthDay: z.number().int().min(1).max(28).optional().nullable(),
    pickupMinute: z.number().int().min(0).max(1439),
    startDate: isoDate,
    endDate: isoDate.optional().nullable(),
    preferredVolunteerId: uuidSchema.optional().nullable(),
    leadTimeMinutes: z.number().int().min(0).max(20160).default(1440),
  })
  .superRefine((v, ctx) => {
    if (v.frequency === 'monthly') {
      if (!v.byMonthDay) {
        ctx.addIssue({
          code: 'custom',
          path: ['byMonthDay'],
          message: 'Choose a day of the month between 1 and 28',
        });
      }
    } else if (v.byWeekday.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['byWeekday'],
        message: 'Choose at least one day of the week',
      });
    }
    if (v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'The end date is before the start' });
    }
  });

export const endRecurringRideSchema = z.object({
  reason: z.string().trim().min(1, 'Give a reason').max(300),
  cancelFuture: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const replyThreadSchema = z.object({
  body: z.string().trim().min(1, 'Type a message').max(1200),
});

export const threadStatusSchema = z.object({ status: z.enum(THREAD_STATUSES) });

export const listThreadsSchema = z.object({
  status: z.union([z.enum(THREAD_STATUSES), z.literal('all')]).default('open'),
  /**
   * NOT z.coerce.boolean(): `Boolean('false')` is true, so `?mine=false` would
   * have filtered to the caller's own threads — the exact opposite of what the
   * query string asked for. Query strings are text; parse them as text.
   */
  mine: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// ---------------------------------------------------------------------------
// Volunteer applications
// ---------------------------------------------------------------------------

export const applicationSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name').max(120),
  email: emailSchema,
  phone: phoneInputSchema,
  addressLine: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  postalCode: z.string().trim().max(20).optional().nullable(),
  serviceArea: z.string().trim().max(300).optional().nullable(),
  requestedServices: z
    .array(z.string().trim().min(1).max(60))
    .min(1, 'Choose at least one kind of help you would like to give')
    .max(20),
  requestedGroups: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
  capabilities: z.array(z.enum(VOLUNTEER_CAPABILITIES)).max(10).default([]),
  hasVehicle: z.boolean().default(false),
  vehicleType: z.string().trim().max(60).optional().nullable(),
  vehicleSeats: z.number().int().min(1).max(20).optional().nullable(),
  availabilityNote: z.string().trim().max(500).optional().nullable(),
  availability: z.array(availabilityWindowSchema).max(40).optional(),
  languages: z.array(z.string().trim().max(30)).max(8).default([]),
  referredBy: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  notificationPreference: z.enum(NOTIFICATION_PREFERENCES).default('sms'),
  consentContact: z.literal(true, {
    errorMap: () => ({ message: 'We need your agreement to contact you' }),
  }),
  consentBackgroundCheck: z.boolean().default(false),
});

export const reviewApplicationSchema = z.object({
  notes: z.string().trim().max(1000).optional().nullable(),
  message: z.string().trim().max(1000).optional().nullable(),
  role: z.enum(['volunteer', 'dispatcher']).optional(),
  groupSlugs: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  serviceSlugs: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

export const requestInfoSchema = z.object({
  message: z.string().trim().min(1, 'Say what you need from them').max(1000),
});

// ---------------------------------------------------------------------------
// Driver licences
// ---------------------------------------------------------------------------

export const licenceSchema = z.object({
  licenceNumber: z.string().trim().max(40).optional().nullable(),
  province: z.string().trim().max(10).default('QC'),
  country: z.string().trim().max(2).default('CA'),
  expiresOn: isoDate.optional().nullable(),
  /** Base64 image data, at most ~8MB decoded. Checked against magic bytes. */
  frontImage: z.string().max(12_000_000).optional().nullable(),
  backImage: z.string().max(12_000_000).optional().nullable(),
});

export const reviewLicenceSchema = z.object({
  decision: z.enum(['on_file', 'rejected']),
  notes: z.string().trim().max(500).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Templates, duty roster, exports, announcements
// ---------------------------------------------------------------------------

export const updateTemplateSchema = z.object({
  subject: z.string().trim().max(200).optional().nullable(),
  body: z.string().trim().min(1).max(4000).optional(),
  active: z.boolean().optional(),
});

export const dutyShiftSchema = z
  .object({
    kind: z.enum(DUTY_KINDS).default('phone'),
    userId: uuidSchema,
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    notes: z.string().trim().max(300).optional().nullable(),
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'A shift must end after it starts',
    path: ['endsAt'],
  });

export const exportRequestSchema = z.object({
  kind: z.enum(EXPORT_KINDS),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const audienceSchema = z.object({
  groupSlugs: z.array(z.string().trim().max(60)).max(10).optional(),
  serviceSlugs: z.array(z.string().trim().max(60)).max(20).optional(),
  roles: z.array(z.enum(ROLES)).max(3).optional(),
  minCompletedTrips: z.number().int().min(0).max(1000).optional(),
  includeSnoozed: z.boolean().optional(),
});

/** Partial edit of a standing ride. Validated rather than passed through. */
export const updateRecurringRideSchema = z.object({
  status: z.enum(RECURRING_RIDE_STATUSES).optional(),
  callerName: z.string().trim().max(120).optional().nullable(),
  callerPhone: phoneInputSchema.optional().nullable(),
  callbackNumber: phoneInputSchema.optional().nullable(),
  passengerNotes: z.string().trim().max(2000).optional().nullable(),
  pickupEntrance: z.string().trim().max(300).optional().nullable(),
  pickupParking: z.string().trim().max(300).optional().nullable(),
  dropoffEntrance: z.string().trim().max(300).optional().nullable(),
  dropoffParking: z.string().trim().max(300).optional().nullable(),
  priority: z.enum(TRIP_PRIORITIES).optional(),
  mobilityNeeds: z.array(z.enum(MOBILITY_NEEDS)).max(6).optional(),
  frequency: z.enum(RECURRENCE_FREQUENCIES).optional(),
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  byMonthDay: z.number().int().min(1).max(28).optional().nullable(),
  pickupMinute: z.number().int().min(0).max(1439).optional(),
  endDate: isoDate.optional().nullable(),
  preferredVolunteerId: uuidSchema.optional().nullable(),
  leadTimeMinutes: z.number().int().min(0).max(20160).optional(),
  appointmentOffsetMinutes: z.number().int().min(-480).max(480).optional().nullable(),
});

export const announcementSchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(120),
  body: z.string().trim().min(1, 'Write the message').max(1000),
  audience: audienceSchema,
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1, 'Choose at least one channel').max(5),
});

export const sendAnnouncementSchema = z.object({
  confirmRecipientCount: z.number().int().min(0).max(100000),
});

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

export const bulkAssignSchema = z.object({
  tripIds: z.array(uuidSchema).min(1, 'Select at least one trip').max(50),
  volunteerId: uuidSchema,
  reason: z.string().trim().max(300).optional(),
});

export const bulkOfferSchema = z.object({
  tripIds: z.array(uuidSchema).min(1, 'Select at least one trip').max(50),
  expiresInMinutes: z.number().int().min(1).max(1440).optional(),
});

// ---------------------------------------------------------------------------
// Calendar and zmanim
// ---------------------------------------------------------------------------

export const calendarRangeSchema = z.object({
  from: isoDate,
  days: z.coerce.number().int().min(1).max(92).default(31),
});

/**
 * Domain vocabulary for Refuah V'Chesed Dispatch.
 *
 * Terminology is carried over from the original Base44 application deliberately:
 * dispatchers and volunteers already speak this language. Where the legacy app
 * used an unreachable or ambiguous value, it is fixed here and the mapping is
 * recorded in tools/migrate.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = ['volunteer', 'dispatcher', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What each role is called on screen. The stored value stays 'dispatcher' (it
 * is in the database, the API and every permission check); the organisation
 * calls these people coordinators, so that is the word users see.
 */
export const ROLE_LABELS: Record<Role, string> = { volunteer: 'Volunteer', dispatcher: 'Coordinator', admin: 'Admin' };
export const ROLE_LABELS_PLURAL: Record<Role, string> = { volunteer: 'Volunteers', dispatcher: 'Coordinators', admin: 'Admins' };
export function roleLabel(role: string | null | undefined): string {
  return (role && ROLE_LABELS[role as Role]) || (role ?? '');
}

/** Roles that may act on the dispatcher board. */
export const DISPATCH_ROLES: readonly Role[] = ['dispatcher', 'admin'];

export function isDispatchRole(role: Role): boolean {
  return DISPATCH_ROLES.includes(role);
}

export const USER_STATUSES = ['active', 'inactive', 'deactivated'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

// ---------------------------------------------------------------------------
// Volunteer groups
//
// Legacy Base44 stored these as free-text keys on both the User and the Trip.
// They are now rows in volunteer_groups with a foreign key from both sides;
// these slugs are the seed values and remain the stable external identifiers.
// ---------------------------------------------------------------------------

export const SEED_GROUPS = [
  { slug: 'chaim_vchesed', name: "Chaim V'Chesed" },
  { slug: 'chesed_on_the_go', name: 'Chesed on the Go' },
  { slug: 'misamchem', name: 'Misamchem' },
] as const;

// ---------------------------------------------------------------------------
// Trip lifecycle
// ---------------------------------------------------------------------------

export const TRIP_STATUSES = [
  'new',
  'pending',
  'offered',
  'assigned',
  'accepted',
  'en_route',
  'in_progress',
  'completed',
  'cancelled',
  'expired',
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/** Statuses that still need dispatcher attention. */
export const OPEN_TRIP_STATUSES: readonly TripStatus[] = [
  'new',
  'pending',
  'offered',
  'assigned',
  'accepted',
  'en_route',
  'in_progress',
  'expired',
];

/** Statuses in which a volunteer is committed to the trip. */
export const ENGAGED_TRIP_STATUSES: readonly TripStatus[] = [
  'assigned',
  'accepted',
  'en_route',
  'in_progress',
];

export const TERMINAL_TRIP_STATUSES: readonly TripStatus[] = ['completed', 'cancelled'];

export const TRIP_PRIORITIES = ['routine', 'urgent', 'emergency'] as const;
export type TripPriority = (typeof TRIP_PRIORITIES)[number];

export const TRIP_TYPES = ['ride', 'equipment_delivery', 'hospital_food'] as const;
export type TripType = (typeof TRIP_TYPES)[number];

export const ASSIGNMENT_MODES = ['auto', 'admin_approval'] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export const MOBILITY_NEEDS = [
  'wheelchair',
  'stretcher',
  'oxygen',
  'attendant',
  'none',
] as const;
export type MobilityNeed = (typeof MOBILITY_NEEDS)[number];

// ---------------------------------------------------------------------------
// Trip state machine
//
// This table is the single source of truth for what may happen to a trip.
// The API exposes one endpoint per transition; no client can PATCH `status`.
// ---------------------------------------------------------------------------

export const TRIP_TRANSITIONS = [
  'offer',
  'assign',
  'claim',
  'reassign',
  'start_en_route',
  'start_trip',
  'complete',
  'cancel',
  'expire',
  'return_to_pending',
] as const;
export type TripTransition = (typeof TRIP_TRANSITIONS)[number];

export interface TransitionRule {
  /** States the trip must currently be in. */
  readonly from: readonly TripStatus[];
  /** State the trip ends in. */
  readonly to: TripStatus;
  /** Roles permitted to perform the transition. */
  readonly roles: readonly Role[];
  /**
   * When true, a volunteer may perform it only for a trip they are assigned to
   * (or, for `claim`, hold a live offer on).
   */
  readonly volunteerMustOwn: boolean;
  readonly description: string;
}

export const TRIP_STATE_MACHINE: Readonly<Record<TripTransition, TransitionRule>> = {
  offer: {
    from: ['new', 'pending', 'expired'],
    to: 'offered',
    roles: ['dispatcher', 'admin'],
    volunteerMustOwn: false,
    description: 'Broadcast the trip to a volunteer group; creates offer records.',
  },
  assign: {
    from: ['new', 'pending', 'offered', 'expired'],
    to: 'assigned',
    roles: ['dispatcher', 'admin'],
    volunteerMustOwn: false,
    description: 'A coordinator assigns a named volunteer directly.',
  },
  claim: {
    from: ['offered'],
    to: 'accepted',
    roles: ['volunteer', 'dispatcher', 'admin'],
    volunteerMustOwn: true,
    description: 'Volunteer accepts an outstanding offer. Atomic; exactly one wins.',
  },
  reassign: {
    from: ['assigned', 'accepted', 'en_route'],
    to: 'assigned',
    roles: ['dispatcher', 'admin'],
    volunteerMustOwn: false,
    description: 'Move the trip to a different volunteer, preserving history.',
  },
  start_en_route: {
    from: ['assigned', 'accepted'],
    to: 'en_route',
    roles: ['volunteer', 'dispatcher', 'admin'],
    volunteerMustOwn: true,
    description: 'Volunteer is on the way to the pickup.',
  },
  start_trip: {
    from: ['en_route', 'accepted', 'assigned'],
    to: 'in_progress',
    roles: ['volunteer', 'dispatcher', 'admin'],
    volunteerMustOwn: true,
    description: 'Passenger is aboard / delivery under way.',
  },
  complete: {
    from: ['assigned', 'accepted', 'en_route', 'in_progress'],
    to: 'completed',
    roles: ['volunteer', 'dispatcher', 'admin'],
    volunteerMustOwn: true,
    description: 'Trip finished.',
  },
  cancel: {
    from: ['new', 'pending', 'offered', 'assigned', 'accepted', 'en_route', 'in_progress', 'expired'],
    to: 'cancelled',
    roles: ['volunteer', 'dispatcher', 'admin'],
    volunteerMustOwn: true,
    description: 'Trip will not happen. Volunteers may only cancel their own.',
  },
  expire: {
    from: ['offered'],
    to: 'expired',
    roles: ['admin'],
    volunteerMustOwn: false,
    description: 'No volunteer answered within the offer window. Raised by the scheduler.',
  },
  return_to_pending: {
    from: ['offered', 'assigned', 'accepted', 'expired'],
    to: 'pending',
    roles: ['dispatcher', 'admin'],
    volunteerMustOwn: false,
    description: 'Pull the trip back to the queue without cancelling it.',
  },
};

export function canTransition(from: TripStatus, transition: TripTransition): boolean {
  return TRIP_STATE_MACHINE[transition].from.includes(from);
}

export function transitionsFrom(from: TripStatus): TripTransition[] {
  return TRIP_TRANSITIONS.filter((t) => canTransition(from, t));
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export const OFFER_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'expired',
  'superseded',
  'cancelled',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_RESPONSE_CHANNELS = ['app', 'sms', 'whatsapp', 'push', 'dispatcher'] as const;
export type OfferResponseChannel = (typeof OFFER_RESPONSE_CHANNELS)[number];

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = ['sms', 'push', 'email', 'whatsapp', 'voice', 'inapp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DELIVERY_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'failed',
  'skipped',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const NOTIFICATION_PREFERENCES = ['sms', 'push', 'whatsapp', 'voice', 'email', 'both', 'all', 'none'] as const;
export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

export const NOTIFICATION_EVENTS = [
  'trip.offered',
  'trip.offer_reminder',
  'trip.assigned',
  'trip.claimed',
  'trip.reassigned',
  'trip.cancelled',
  'trip.expired',
  'trip.completed',
  'trip.escalated',
  'offer.lost',
  'volunteer.application_received',
  'volunteer.application_approved',
  'volunteer.application_rejected',
  'volunteer.application_info_requested',
  'volunteer.invitation',
  'volunteer.welcome',
  'admin.application_submitted',
  'admin.delivery_failures',
  'admin.export_ready',
  'equipment.loan_confirmed',
  'equipment.due_reminder',
  'equipment.overdue',
  'equipment.returned',
  'announcement.broadcast',
  'duty.shift_reminder',
  'sms.reply_received',
] as const;

/**
 * Events that carry operational urgency. Snooze and channel preference do not
 * apply to these: a volunteer who muted notifications still hears that the trip
 * they already accepted was cancelled. Muting suppresses *offers*, never
 * consequences of a commitment already made.
 */
export const CRITICAL_NOTIFICATION_EVENTS: readonly string[] = [
  'trip.assigned',
  'trip.reassigned',
  'trip.cancelled',
  'volunteer.application_approved',
  'volunteer.application_rejected',
  'volunteer.invitation',
];
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const CALL_COUNTERPARTY_TYPES = ['caller', 'volunteer', 'contact'] as const;
export type CallCounterpartyType = (typeof CALL_COUNTERPARTY_TYPES)[number];

export const CALL_STATUSES = [
  'requested',
  'ringing',
  'in_progress',
  'completed',
  'failed',
  'no_answer',
  'blocked',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JOB_KINDS = [
  'offer.expire',
  'notification.deliver',
  'notification.retry',
  'trip.escalate',
  'trip.reminder',
  'cleanup.sessions',
  'cleanup.tokens',
  'cleanup.retention',
  'recurring.materialise',
  'equipment.due_scan',
  'announcement.send',
  'export.run',
  'licence.expiry_scan',
  'duty.reminder_scan',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

// ---------------------------------------------------------------------------
// Configurable operational timings.
//
// Defaults reproduce the original application's intent; every value is stored
// in the `settings` table so operations can tune them without a deploy.
// ---------------------------------------------------------------------------

export const SETTING_KEYS = {
  offerWindowMinutes: 'dispatch.offer_window_minutes',
  offerReminderMinutes: 'dispatch.offer_reminder_minutes',
  escalationMinutes: 'dispatch.escalation_minutes',
  urgentOfferWindowMinutes: 'dispatch.urgent_offer_window_minutes',
  overdueGraceMinutes: 'dispatch.overdue_grace_minutes',
  notificationMaxAttempts: 'notifications.max_attempts',
  notificationRetryBackoffSeconds: 'notifications.retry_backoff_seconds',
  sessionTtlHours: 'auth.session_ttl_hours',
  callDailyLimitPerUser: 'calling.daily_limit_per_user',
  /** Retention windows, in days. Operational history is kept; the message and
   *  call traffic that carries personal data is not kept indefinitely. */
  notificationRetentionDays: 'retention.notification_days',
  smsEventRetentionDays: 'retention.sms_event_days',
  callLogRetentionDays: 'retention.call_log_days',
  smsMessageRetentionDays: 'retention.sms_message_days',
  /** How far ahead recurring rides are turned into real trips. */
  recurringHorizonDays: 'recurring.horizon_days',
  /** Offers per broadcast round. Targeting narrows the pool; this caps it. */
  offerBatchSize: 'dispatch.offer_batch_size',
  /** Emergency priority ignores availability windows when the pool is empty. */
  emergencyOfferWindowMinutes: 'dispatch.emergency_offer_window_minutes',
  equipmentDueReminderDays: 'equipment.due_reminder_days',
  dutyShiftReminderMinutes: 'duty.shift_reminder_minutes',
  licenceExpiryWarningDays: 'volunteers.licence_expiry_warning_days',
  applicationDuplicateWindowDays: 'volunteers.application_duplicate_window_days',
  broadcastMaxRecipients: 'announcements.max_recipients',
  /** Voice calls: no calls from this hour (org time, 0-23)... */
  voiceQuietStartHour: 'voice.quiet_start_hour',
  /** ...until this hour. Urgent and emergency trips still call. */
  voiceQuietEndHour: 'voice.quiet_end_hour',
  /** Most voice calls one offer round may place; the rest get a text. */
  voiceMaxCallsPerRound: 'voice.max_calls_per_round',
  /** Minutes before an unanswered offer call is tried once more. */
  voiceRetryMinutes: 'voice.retry_minutes',
  /** Announcements screen switched on (1) or off (0) by an administrator. */
  featureAnnouncements: 'features.announcements_enabled',
} as const;

export const DEFAULT_SETTINGS: Record<string, number> = {
  [SETTING_KEYS.offerWindowMinutes]: 30,
  [SETTING_KEYS.offerReminderMinutes]: 10,
  [SETTING_KEYS.escalationMinutes]: 20,
  [SETTING_KEYS.urgentOfferWindowMinutes]: 10,
  [SETTING_KEYS.overdueGraceMinutes]: 15,
  [SETTING_KEYS.notificationMaxAttempts]: 5,
  [SETTING_KEYS.notificationRetryBackoffSeconds]: 30,
  [SETTING_KEYS.sessionTtlHours]: 24 * 14,
  [SETTING_KEYS.callDailyLimitPerUser]: 100,
  [SETTING_KEYS.notificationRetentionDays]: 180,
  [SETTING_KEYS.smsEventRetentionDays]: 365,
  [SETTING_KEYS.callLogRetentionDays]: 365,
  [SETTING_KEYS.smsMessageRetentionDays]: 365,
  [SETTING_KEYS.recurringHorizonDays]: 14,
  [SETTING_KEYS.offerBatchSize]: 40,
  [SETTING_KEYS.emergencyOfferWindowMinutes]: 5,
  [SETTING_KEYS.equipmentDueReminderDays]: 2,
  [SETTING_KEYS.dutyShiftReminderMinutes]: 60,
  [SETTING_KEYS.licenceExpiryWarningDays]: 45,
  [SETTING_KEYS.applicationDuplicateWindowDays]: 365,
  [SETTING_KEYS.broadcastMaxRecipients]: 1000,
  [SETTING_KEYS.voiceQuietStartHour]: 22,
  [SETTING_KEYS.voiceQuietEndHour]: 7,
  [SETTING_KEYS.voiceMaxCallsPerRound]: 10,
  [SETTING_KEYS.voiceRetryMinutes]: 2,
  [SETTING_KEYS.featureAnnouncements]: 1,
};

// ---------------------------------------------------------------------------
// Equipment & vehicles (carried over; secondary to dispatch)
// ---------------------------------------------------------------------------

export const EQUIPMENT_STATUSES = ['available', 'loaned', 'maintenance', 'retired'] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

export const EQUIPMENT_CONDITIONS = ['new', 'good', 'fair', 'poor', 'damaged'] as const;
export type EquipmentCondition = (typeof EQUIPMENT_CONDITIONS)[number];

export const VEHICLE_STATUSES = ['available', 'in_use', 'maintenance', 'retired'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

// ===========================================================================
// PRODUCTION SCOPE — approved additions
//
// Everything below was added for the production build. The ordering rule is
// the same as above: this file is the vocabulary, the database enforces the
// invariants, and no string literal for any of these concepts is written
// anywhere else in the codebase.
// ===========================================================================

// ---------------------------------------------------------------------------
// Services / capabilities
//
// The legacy app offered every trip to every member of a group. Targeting needs
// a concept of "what this volunteer has agreed to do", so services are rows and
// volunteers opt in to them. `slug` deliberately matches TRIP_TYPES for the
// three dispatchable services so a trip maps to a service without a join table.
// ---------------------------------------------------------------------------

export const SEED_SERVICES = [
  { slug: 'ride', name: 'Rides', dispatchable: true, description: 'Driving a passenger to or from an appointment.' },
  { slug: 'equipment_delivery', name: 'Equipment delivery', dispatchable: true, description: 'Delivering or collecting loaned medical equipment.' },
  { slug: 'hospital_food', name: 'Hospital food', dispatchable: true, description: 'Bringing meals to patients and families.' },
  { slug: 'phone_duty', name: 'Phone duty', dispatchable: false, description: 'Taking the organisation line during a rostered shift.' },
] as const;

/** Physical capabilities a volunteer can cover, mirroring MOBILITY_NEEDS. */
export const VOLUNTEER_CAPABILITIES = [
  'wheelchair',
  'stretcher',
  'oxygen',
  'attendant',
] as const;
export type VolunteerCapability = (typeof VOLUNTEER_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Availability
//
// Weekly recurring windows plus dated exceptions. The rule that matters:
// a volunteer with NO availability rules is treated as always available.
// Anything else would silently mute the entire roster the day this ships.
// ---------------------------------------------------------------------------

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const AVAILABILITY_EXCEPTION_KINDS = ['unavailable', 'available'] as const;
export type AvailabilityExceptionKind = (typeof AVAILABILITY_EXCEPTION_KINDS)[number];

/** Operating timezone. Every wall-clock rule in the product is evaluated here. */
export const ORG_TIMEZONE = 'America/Toronto';

// ---------------------------------------------------------------------------
// Recurring rides
// ---------------------------------------------------------------------------

export const RECURRENCE_FREQUENCIES = ['weekly', 'biweekly', 'monthly'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export const RECURRING_RIDE_STATUSES = ['active', 'paused', 'ended'] as const;
export type RecurringRideStatus = (typeof RECURRING_RIDE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

export const CALLER_STATUSES = ['active', 'archived'] as const;
export type CallerStatus = (typeof CALLER_STATUSES)[number];

export const ADDRESS_LABELS = ['home', 'clinic', 'hospital', 'work', 'other'] as const;
export type AddressLabel = (typeof ADDRESS_LABELS)[number];

// ---------------------------------------------------------------------------
// Conversations (two-way SMS)
// ---------------------------------------------------------------------------

export const THREAD_STATUSES = ['open', 'snoozed', 'closed'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const THREAD_PARTY_TYPES = ['volunteer', 'caller', 'unknown'] as const;
export type ThreadPartyType = (typeof THREAD_PARTY_TYPES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// Volunteer applications
// ---------------------------------------------------------------------------

export const APPLICATION_STATUSES = [
  'submitted',
  'info_requested',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// ---------------------------------------------------------------------------
// Driver licences
//
// `on_file` means an image and/or number was supplied and an administrator has
// looked at it. It is NOT a claim of validity. `verified` is written only by a
// real verification provider returning a positive result, and the provider and
// its reference are recorded alongside. There is no code path that sets
// `verified` from a human opinion or from the absence of a provider.
// ---------------------------------------------------------------------------

export const LICENCE_STATUSES = [
  'pending_review',
  'on_file',
  'verified',
  'rejected',
  'expired',
] as const;
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

export const TEMPLATE_CHANNELS = ['sms', 'email', 'whatsapp', 'push'] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

export const TEMPLATE_LOCALES = ['en', 'fr'] as const;
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

/**
 * Every message the system can send. A template key that is not in this list
 * cannot be rendered, so a typo fails at the call site rather than sending an
 * empty SMS to 500 people.
 */
export const TEMPLATE_KEYS = [
  'trip.offered',
  'trip.offer_reminder',
  'trip.assigned',
  'trip.claimed',
  'trip.claim_lost',
  'trip.reassigned',
  'trip.cancelled',
  'trip.expired',
  'trip.completed',
  'trip.escalated',
  'sms.accept_confirmed',
  'sms.accept_too_late',
  'sms.accept_invalid',
  'sms.decline_confirmed',
  'sms.help',
  'sms.unknown_sender',
  'sms.muted',
  'volunteer.application_received',
  'volunteer.application_approved',
  'volunteer.application_rejected',
  'volunteer.application_info_requested',
  'volunteer.invitation',
  'volunteer.password_reset',
  'volunteer.welcome',
  'admin.application_submitted',
  'admin.delivery_failures',
  'admin.export_ready',
  'equipment.loan_confirmed',
  'equipment.due_reminder',
  'equipment.overdue',
  'equipment.returned',
  'announcement.broadcast',
  'duty.shift_reminder',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

// ---------------------------------------------------------------------------
// Duty roster
// ---------------------------------------------------------------------------

export const DUTY_KINDS = ['phone', 'dispatcher', 'backup'] as const;
export type DutyKind = (typeof DUTY_KINDS)[number];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const EXPORT_KINDS = [
  'trips',
  'volunteers',
  'monthly_board',
  'equipment_loans',
  'audit',
  'notification_deliveries',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

// ---------------------------------------------------------------------------
// Announcements / bulk broadcast
// ---------------------------------------------------------------------------

export const ANNOUNCEMENT_STATUSES = ['draft', 'sending', 'sent', 'failed'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

/**
 * Relational schema for Refuah V'Chesed Dispatch.
 *
 * Design rules that this schema exists to enforce, each of which was a defect
 * in the Base44 implementation:
 *
 *  1. ONE authoritative identity. `users` is the only representation of a
 *     person. There is no parallel Volunteer table and no public directory
 *     copy; group membership is a join table, not a text array.
 *  2. No field lives in two places. There is no `data` JSON blob shadowing
 *     top-level columns.
 *  3. Offers are rows, not side effects of sending an SMS.
 *  4. Assignment history is preserved in `trip_assignments`; the current
 *     assignee on `trips` is a denormalised convenience with an FK.
 *  5. Nothing operational is hard-deleted; `deleted_at` plus partial unique
 *     indexes.
 *  6. `audit_events` is append-only and server-written.
 */
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const now = () => timestamp('', { withTimezone: true });
void now;

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const deletedAt = () => timestamp('deleted_at', { withTimezone: true });

// ===========================================================================
// Identity
// ===========================================================================

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Optional for volunteers added with only a name and phone. */
    email: text('email'),
    passwordHash: text('password_hash'),
    fullName: text('full_name').notNull(),
    /** E.164. Unique among live users so SMS can resolve exactly one person. */
    phone: text('phone'),
    role: text('role').notNull().default('volunteer'),
    status: text('status').notNull().default('active'),

    notificationPreference: text('notification_preference').notNull().default('sms'),
    preferredVehicleType: text('preferred_vehicle_type'),
    photoUrl: text('photo_url'),
    /** A volunteer's requested photo change, applied only when a dispatcher/admin approves it. */
    pendingPhoto: text('pending_photo'),
    pendingPhotoAction: text('pending_photo_action'),
    pendingPhotoAt: timestamp('pending_photo_at', { withTimezone: true }),
    addressLine: text('address_line'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    availability: jsonb('availability').$type<Record<string, unknown>>(),
    /**
     * Snooze. Volunteers in the reference product were inventing this over SMS
     * ("#Mute"), which is the failure mode that turns notifications off
     * permanently at scale. A muted volunteer is skipped when offering and is
     * told when the mute lapses.
     */
    mutedUntil: timestamp('muted_until', { withTimezone: true }),
    /** Paused by a coordinator (status 'inactive'). Null = until reactivated by hand. */
    suspendedUntil: timestamp('suspended_until', { withTimezone: true }),
    suspensionReason: text('suspension_reason'),

    /** Physical needs this volunteer can handle. Empty = plain rides only. */
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
    /**
     * Sidebar/feature-list entries this person chose to hide (route paths).
     * Per-dispatcher simplification: everyone keeps only the screens they
     * actually use in view. Empty = show everything. Settings is never hidden
     * (enforced client-side) so the preference stays recoverable.
     */
    navHidden: text('nav_hidden').array().notNull().default(sql`'{}'::text[]`),
    languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
    hasVehicle: boolean('has_vehicle').notNull().default(true),
    vehicleSeats: integer('vehicle_seats'),
    serviceArea: text('service_area'),
    locale: text('locale').notNull().default('en'),
    /** Printed on the volunteer ID card. Assigned once, never reused. */
    volunteerNumber: text('volunteer_number'),
    /**
     * The value behind the ID card's QR code.
     *
     * Deliberately NOT the volunteer number. The number is printed in large
     * type on a badge that gets photographed at hospital desks, and if it were
     * also the verification key then anyone who saw one card could enumerate
     * the whole roster by counting upwards. This is 20 random characters.
     */
    cardToken: text('card_token'),
    /** Two-step sign-in: authenticator secret (encrypted), set once confirmed. */
    totpSecret: text('totp_secret'),
    /** Secret shown during setup, before the first code confirms it. */
    totpPendingSecret: text('totp_pending_secret'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** Last accepted 30-second step, so the same code cannot be used twice. */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    /** SHA-256 of unused recovery codes. */
    totpRecoveryHashes: text('totp_recovery_hashes').array().notNull().default(sql`'{}'::text[]`),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedById: uuid('approved_by_id'),
    applicationId: uuid('application_id'),
    /** Last time this volunteer was sent an offer — used to rotate fairly
     *  through a large pool instead of always asking the same first names. */
    lastOfferedAt: timestamp('last_offered_at', { withTimezone: true }),

    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    emailUq: uniqueIndex('users_email_live_uq')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} is null`),
    phoneUq: uniqueIndex('users_phone_live_uq')
      .on(t.phone)
      .where(sql`${t.deletedAt} is null and ${t.phone} is not null`),
    volunteerNumberUq: uniqueIndex('users_volunteer_number_uq')
      .on(t.volunteerNumber)
      .where(sql`${t.volunteerNumber} is not null`),
    cardTokenUq: uniqueIndex('users_card_token_uq')
      .on(t.cardToken)
      .where(sql`${t.cardToken} is not null`),
    roleIdx: index('users_role_idx').on(t.role, t.status),
    nameIdx: index('users_name_idx').on(t.fullName),
  }),
);

export const volunteerGroups = pgTable(
  'volunteer_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ slugUq: uniqueIndex('volunteer_groups_slug_uq').on(t.slug) }),
);

export const userGroups = pgTable(
  'user_groups',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => volunteerGroups.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.groupId] }),
    groupIdx: index('user_groups_group_idx').on(t.groupId),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie value. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Signed in with a password but the two-step code is still owed. */
    mfaPending: boolean('mfa_pending').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenUq: uniqueIndex('sessions_token_uq').on(t.tokenHash),
    userIdx: index('sessions_user_idx').on(t.userId),
    expiryIdx: index('sessions_expiry_idx').on(t.expiresAt),
  }),
);

/** Invite and password-reset tokens. Hashed, single-use, expiring. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'invite' | 'password_reset'
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenUq: uniqueIndex('auth_tokens_token_uq').on(t.tokenHash),
    userIdx: index('auth_tokens_user_idx').on(t.userId, t.kind),
  }),
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    failureCount: integer('failure_count').notNull().default(0),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    endpointUq: uniqueIndex('push_subscriptions_endpoint_uq').on(t.endpoint),
    userIdx: index('push_subscriptions_user_idx').on(t.userId),
  }),
);

// ===========================================================================
// Addresses
// ===========================================================================

export const addresses = pgTable('addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  line1: text('line1').notNull(),
  unit: text('unit'),
  city: text('city').notNull().default('Montreal'),
  province: text('province').notNull().default('QC'),
  postalCode: text('postal_code'),
  country: text('country').notNull().default('CA'),
  notes: text('notes'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  createdAt: createdAt(),
});

// ===========================================================================
// Trips
// ===========================================================================

export const trips = pgTable(
  'trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Human-facing reference, e.g. RVC-260914-0007. Generated server-side from
     * a sequence — never a 4-digit random value, and never used for authorisation.
     */
    reference: text('reference').notNull(),
    isTest: boolean('is_test').notNull().default(false),

    status: text('status').notNull().default('pending'),
    priority: text('priority').notNull().default('routine'),
    tripType: text('trip_type').notNull().default('ride'),
    assignmentMode: text('assignment_mode').notNull().default('auto'),

    groupId: uuid('group_id')
      .notNull()
      .references(() => volunteerGroups.id, { onDelete: 'restrict' }),

    /** Repeat callers resolve to a row; the denormalised name/phone stay so a
     *  one-off caller never forces a directory entry. */
    callerId: uuid('caller_id'),
    callerName: text('caller_name'),
    callerPhone: text('caller_phone'),
    /** Number to reach about THIS trip — often a ward desk, not the caller. */
    callbackNumber: text('callback_number'),
    /** The appointment the ride exists for. Distinct from pickup time. */
    appointmentAt: timestamp('appointment_at', { withTimezone: true }),
    pickupEntrance: text('pickup_entrance'),
    pickupParking: text('pickup_parking'),
    dropoffEntrance: text('dropoff_entrance'),
    dropoffParking: text('dropoff_parking'),
    /** Provenance. Both are informational; neither carries lifecycle state. */
    recurringRideId: uuid('recurring_ride_id'),
    duplicatedFromTripId: uuid('duplicated_from_trip_id'),
    offerRound: integer('offer_round').notNull().default(0),
    escalationCount: integer('escalation_count').notNull().default(0),

    pickupAddressId: uuid('pickup_address_id')
      .notNull()
      .references(() => addresses.id, { onDelete: 'restrict' }),
    dropoffAddressId: uuid('dropoff_address_id')
      .notNull()
      .references(() => addresses.id, { onDelete: 'restrict' }),

    pickupAt: timestamp('pickup_at', { withTimezone: true }).notNull(),
    mobilityNeeds: text('mobility_needs').array().notNull().default(sql`'{}'::text[]`),
    passengerNotes: text('passenger_notes'),

    assignedVolunteerId: uuid('assigned_volunteer_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    enRouteAt: timestamp('en_route_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledById: uuid('cancelled_by_id').references(() => users.id, { onDelete: 'set null' }),
    cancellationReason: text('cancellation_reason'),

    /** When the current broadcast stops being answerable. */
    offerExpiresAt: timestamp('offer_expires_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),

    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
    /** Optimistic concurrency for dispatcher edits. */
    version: integer('version').notNull().default(1),
  },
  (t) => ({
    refUq: uniqueIndex('trips_reference_uq').on(t.reference),
    statusIdx: index('trips_status_pickup_idx').on(t.status, t.pickupAt),
    groupIdx: index('trips_group_status_idx').on(t.groupId, t.status),
    assigneeIdx: index('trips_assignee_idx').on(t.assignedVolunteerId, t.status),
    pickupIdx: index('trips_pickup_at_idx').on(t.pickupAt),
    callerIdx: index('trips_caller_idx').on(t.callerId, t.pickupAt),
    recurringIdx: index('trips_recurring_idx').on(t.recurringRideId),
    openIdx: index('trips_open_idx')
      .on(t.pickupAt)
      .where(sql`${t.deletedAt} is null and ${t.status} not in ('completed','cancelled')`),
    expiryIdx: index('trips_offer_expiry_idx')
      .on(t.offerExpiresAt)
      .where(sql`${t.status} = 'offered'`),
  }),
);

/** Full assignment history. A row is opened on assign/claim and closed on
 *  reassign/cancel, so "who had this trip and when" is always answerable. */
export const tripAssignments = pgTable(
  'trip_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    volunteerId: uuid('volunteer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assignedById: uuid('assigned_by_id').references(() => users.id, { onDelete: 'set null' }),
    source: text('source').notNull().default('dispatcher'), // dispatcher | claim | sms | import
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
    unassignedAt: timestamp('unassigned_at', { withTimezone: true }),
    unassignedReason: text('unassigned_reason'),
  },
  (t) => ({
    tripIdx: index('trip_assignments_trip_idx').on(t.tripId, t.assignedAt),
    volIdx: index('trip_assignments_volunteer_idx').on(t.volunteerId),
    /** At most one live assignment per trip. */
    oneLive: uniqueIndex('trip_assignments_one_live_uq')
      .on(t.tripId)
      .where(sql`${t.unassignedAt} is null`),
  }),
);

export const tripOffers = pgTable(
  'trip_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    volunteerId: uuid('volunteer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    /** SHA-256 of a 32-byte random token. Single-use, expiring, per volunteer. */
    tokenHash: text('token_hash').notNull(),
    offeredAt: timestamp('offered_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    responseChannel: text('response_channel'),
    /** Round number — a re-broadcast of the same trip increments this. */
    round: integer('round').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenUq: uniqueIndex('trip_offers_token_uq').on(t.tokenHash),
    tripVolRoundUq: uniqueIndex('trip_offers_trip_vol_round_uq').on(t.tripId, t.volunteerId, t.round),
    volPendingIdx: index('trip_offers_volunteer_pending_idx')
      .on(t.volunteerId, t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
    tripIdx: index('trip_offers_trip_idx').on(t.tripId, t.status),
    expiryIdx: index('trip_offers_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending'`),
  }),
);

// ===========================================================================
// Notifications
// ===========================================================================

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    offerId: uuid('offer_id').references(() => tripOffers.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index('notifications_user_idx').on(t.userId, t.createdAt),
    tripIdx: index('notifications_trip_idx').on(t.tripId),
  }),
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    lastError: text('last_error'),
    destination: text('destination'),
    /** Network that actually carried it: 'sms' when WhatsApp fell back. */
    carriedBy: text('carried_by'),
    /** Why the WhatsApp -> SMS fallback happened, when it did. */
    fallbackReason: text('fallback_reason'),
    /** Voice calls: accepted, declined, taken, no_choice, no_answer, busy, voicemail, failed. */
    voiceOutcome: text('voice_outcome'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => ({
    notifIdx: index('notification_deliveries_notification_idx').on(t.notificationId),
    pendingIdx: index('notification_deliveries_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('queued','sent')`),
    statusIdx: index('notification_deliveries_status_idx').on(t.status, t.queuedAt),
    providerIdx: index('notification_deliveries_provider_msg_idx').on(t.providerMessageId),
  }),
);

// ===========================================================================
// SMS & calls
// ===========================================================================

export const smsEvents = pgTable(
  'sms_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    direction: text('direction').notNull(), // inbound | outbound
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    body: text('body'),
    providerSid: text('provider_sid'),
    signatureValid: boolean('signature_valid').notNull().default(false),
    matchedUserId: uuid('matched_user_id').references(() => users.id, { onDelete: 'set null' }),
    matchedOfferId: uuid('matched_offer_id').references(() => tripOffers.id, {
      onDelete: 'set null',
    }),
    outcome: text('outcome').notNull(), // accepted | declined | unmatched | rejected_signature | ...
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (t) => ({
    sidUq: uniqueIndex('sms_events_provider_sid_uq')
      .on(t.providerSid)
      .where(sql`${t.providerSid} is not null`),
    createdIdx: index('sms_events_created_idx').on(t.createdAt),
    outcomeIdx: index('sms_events_outcome_idx').on(t.outcome, t.createdAt),
  }),
);

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    initiatedById: uuid('initiated_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    direction: text('direction').notNull().default('outbound'),
    counterpartyType: text('counterparty_type').notNull(),
    counterpartyUserId: uuid('counterparty_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Only the last four digits are retained for display. */
    destinationLast4: text('destination_last4'),
    counterpartyName: text('counterparty_name'),
    contactId: uuid('contact_id'),
    /** 'no_answer' etc. rendered inline beside the direction, as in the benchmark. */
    failureReason: text('failure_reason'),
    providerSid: text('provider_sid'),
    status: text('status').notNull().default('requested'),
    durationSeconds: integer('duration_seconds'),
    authorizationBasis: text('authorization_basis').notNull(),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => ({
    sidIdx: index('calls_provider_sid_idx').on(t.providerSid),
    byIdx: index('calls_initiator_idx').on(t.initiatedById, t.startedAt),
    tripIdx: index('calls_trip_idx').on(t.tripId),
  }),
);

// ===========================================================================
// Audit — append only
// ===========================================================================

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null only for scheduler/system actions, which record actorRole 'system'. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name').notNull(),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    previous: jsonb('previous'),
    next: jsonb('next'),
    metadata: jsonb('metadata'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
  },
  (t) => ({
    entityIdx: index('audit_events_entity_idx').on(t.entityType, t.entityId, t.occurredAt),
    actorIdx: index('audit_events_actor_idx').on(t.actorUserId, t.occurredAt),
    actionIdx: index('audit_events_action_idx').on(t.action, t.occurredAt),
    timeIdx: index('audit_events_time_idx').on(t.occurredAt),
  }),
);

// ===========================================================================
// Jobs & settings
// ===========================================================================

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'), // pending|running|done|failed|dead
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(10),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    /** Set for jobs that must exist at most once, e.g. one expiry per offer. */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    claimIdx: index('jobs_claim_idx')
      .on(t.runAt)
      .where(sql`${t.status} = 'pending'`),
    kindIdx: index('jobs_kind_idx').on(t.kind, t.status),
    dedupeUq: uniqueIndex('jobs_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} in ('pending','running')`),
  }),
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedAt: updatedAt(),
  updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
});

// ===========================================================================
// Supporting operational entities (carried over from the legacy app)
// ===========================================================================

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    role: text('role'),
    notes: text('notes'),
    addressId: uuid('address_id').references(() => addresses.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({ nameIdx: index('contacts_name_idx').on(t.name) }),
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    vehicleType: text('vehicle_type').notNull().default('standard'),
    plate: text('plate'),
    capacity: integer('capacity'),
    status: text('status').notNull().default('available'),
    notes: text('notes'),
    lastMaintenanceAt: timestamp('last_maintenance_at', { withTimezone: true }),
    nextMaintenanceAt: timestamp('next_maintenance_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    labelUq: uniqueIndex('vehicles_label_live_uq')
      .on(t.label)
      .where(sql`${t.deletedAt} is null`),
    statusIdx: index('vehicles_status_idx').on(t.status),
  }),
);

export const equipmentCategories = pgTable(
  'equipment_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    nameUq: uniqueIndex('equipment_categories_name_live_uq')
      .on(t.name)
      .where(sql`${t.deletedAt} is null`),
  }),
);

export const equipment = pgTable(
  'equipment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id').references(() => equipmentCategories.id, {
      onDelete: 'restrict',
    }),
    itemCode: text('item_code'),
    barcode: text('barcode'),
    equipmentType: text('equipment_type').notNull(),
    status: text('status').notNull().default('available'),
    condition: text('condition').notNull().default('good'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    codeUq: uniqueIndex('equipment_item_code_live_uq')
      .on(t.itemCode)
      .where(sql`${t.deletedAt} is null and ${t.itemCode} is not null`),
    barcodeUq: uniqueIndex('equipment_barcode_live_uq')
      .on(t.barcode)
      .where(sql`${t.deletedAt} is null and ${t.barcode} is not null`),
    statusIdx: index('equipment_status_idx').on(t.status),
    categoryIdx: index('equipment_category_idx').on(t.categoryId),
  }),
);

/** Loans are rows, not fields smeared across the item. */
export const equipmentLoans = pgTable(
  'equipment_loans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => equipment.id, { onDelete: 'cascade' }),
    borrowerName: text('borrower_name').notNull(),
    borrowerPhone: text('borrower_phone').notNull(),
    borrowerAddress: text('borrower_address'),
    loanedById: uuid('loaned_by_id').references(() => users.id, { onDelete: 'set null' }),
    returnedById: uuid('returned_by_id').references(() => users.id, { onDelete: 'set null' }),
    loanedAt: timestamp('loaned_at', { withTimezone: true }).notNull().defaultNow(),
    expectedReturnAt: timestamp('expected_return_at', { withTimezone: true }),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (t) => ({
    equipIdx: index('equipment_loans_equipment_idx').on(t.equipmentId, t.loanedAt),
    openUq: uniqueIndex('equipment_loans_one_open_uq')
      .on(t.equipmentId)
      .where(sql`${t.returnedAt} is null`),
    dueIdx: index('equipment_loans_due_idx')
      .on(t.expectedReturnAt)
      .where(sql`${t.returnedAt} is null`),
  }),
);

export const organizationInfo = pgTable('organization_info', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  website: text('website'),
  addressLine: text('address_line'),
  emergencyContact: text('emergency_contact'),
  details: jsonb('details').$type<Record<string, unknown>>(),
  updatedAt: updatedAt(),
  updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
});

/** Sequence backing human-readable trip references. */
export const tripCounters = pgTable('trip_counters', {
  day: text('day').primaryKey(), // YYMMDD in America/Toronto
  lastValue: integer('last_value').notNull().default(0),
});


// ===========================================================================
// PRODUCTION SCOPE — approved additions
// ===========================================================================

// ---------------------------------------------------------------------------
// Services and volunteer capability
// ---------------------------------------------------------------------------

export const serviceTypes = pgTable(
  'service_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Dispatchable services can be the subject of a trip; others (phone duty,
     *  visits) are opt-ins that never produce an offer. */
    dispatchable: boolean('dispatchable').notNull().default(true),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ slugUq: uniqueIndex('service_types_slug_uq').on(t.slug) }),
);

/** A volunteer's own opt-in. Self-serve: the volunteer owns these rows. */
export const volunteerServices = pgTable(
  'volunteer_services',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serviceTypeId: uuid('service_type_id')
      .notNull()
      .references(() => serviceTypes.id, { onDelete: 'cascade' }),
    optedInAt: timestamp('opted_in_at', { withTimezone: true }).notNull().defaultNow(),
    optedInById: uuid('opted_in_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.serviceTypeId] }),
    serviceIdx: index('volunteer_services_service_idx').on(t.serviceTypeId),
  }),
);

// ---------------------------------------------------------------------------
// Availability
//
// A volunteer with no rules is always available (see domain.ts). Rules are
// weekly wall-clock windows in ORG_TIMEZONE; exceptions are dated overrides.
// ---------------------------------------------------------------------------

export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 0 = Sunday, matching Postgres `extract(dow)`. */
    weekday: integer('weekday').notNull(),
    /** Minutes from local midnight. 0..1440; end may equal 1440 for "until midnight". */
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index('availability_rules_user_idx').on(t.userId, t.weekday),
    uq: uniqueIndex('availability_rules_uq').on(t.userId, t.weekday, t.startMinute, t.endMinute),
  }),
);

export const availabilityExceptions = pgTable(
  'availability_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('unavailable'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index('availability_exceptions_user_idx').on(t.userId, t.startsAt, t.endsAt),
  }),
);

// ---------------------------------------------------------------------------
// Callers
//
// The legacy app re-typed the caller's name, phone and address on every single
// ride. Callers are now rows with saved addresses, which is what makes repeat
// callers a lookup instead of a re-interview.
// ---------------------------------------------------------------------------

export const callers = pgTable(
  'callers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** E.164, unique among live callers so an inbound number resolves to one. */
    primaryPhone: text('primary_phone'),
    alternatePhone: text('alternate_phone'),
    email: text('email'),
    language: text('language').notNull().default('en'),
    notes: text('notes'),
    /** Standing operational facts: "needs help to the door", "ring 2B". */
    accessNotes: text('access_notes'),
    status: text('status').notNull().default('active'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    phoneUq: uniqueIndex('callers_primary_phone_live_uq')
      .on(t.primaryPhone)
      .where(sql`${t.deletedAt} is null and ${t.primaryPhone} is not null`),
    nameIdx: index('callers_name_idx').on(t.name),
    altIdx: index('callers_alt_phone_idx').on(t.alternatePhone),
  }),
);

export const callerAddresses = pgTable(
  'caller_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callerId: uuid('caller_id')
      .notNull()
      .references(() => callers.id, { onDelete: 'cascade' }),
    addressId: uuid('address_id')
      .notNull()
      .references(() => addresses.id, { onDelete: 'restrict' }),
    label: text('label').notNull().default('home'),
    /** The operational detail that saves the volunteer a phone call. */
    entrance: text('entrance'),
    parking: text('parking'),
    isDefaultPickup: boolean('is_default_pickup').notNull().default(false),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    callerIdx: index('caller_addresses_caller_idx').on(t.callerId, t.lastUsedAt),
    uq: uniqueIndex('caller_addresses_uq')
      .on(t.callerId, t.addressId)
      .where(sql`${t.deletedAt} is null`),
    defaultUq: uniqueIndex('caller_addresses_one_default_uq')
      .on(t.callerId)
      .where(sql`${t.isDefaultPickup} and ${t.deletedAt} is null`),
  }),
);

// ---------------------------------------------------------------------------
// Recurring rides
//
// A recurring ride is a *template plus a schedule*. It never dispatches on its
// own: a background job materialises occurrences into ordinary trips, which
// then follow the normal state machine. There is no second dispatch path.
// ---------------------------------------------------------------------------

export const recurringRides = pgTable(
  'recurring_rides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    status: text('status').notNull().default('active'),

    groupId: uuid('group_id')
      .notNull()
      .references(() => volunteerGroups.id, { onDelete: 'restrict' }),
    callerId: uuid('caller_id').references(() => callers.id, { onDelete: 'set null' }),
    callerName: text('caller_name'),
    callerPhone: text('caller_phone'),
    callbackNumber: text('callback_number'),

    pickupAddressId: uuid('pickup_address_id')
      .notNull()
      .references(() => addresses.id, { onDelete: 'restrict' }),
    dropoffAddressId: uuid('dropoff_address_id')
      .notNull()
      .references(() => addresses.id, { onDelete: 'restrict' }),
    pickupEntrance: text('pickup_entrance'),
    pickupParking: text('pickup_parking'),
    dropoffEntrance: text('dropoff_entrance'),
    dropoffParking: text('dropoff_parking'),

    tripType: text('trip_type').notNull().default('ride'),
    priority: text('priority').notNull().default('routine'),
    mobilityNeeds: text('mobility_needs').array().notNull().default(sql`'{}'::text[]`),
    passengerNotes: text('passenger_notes'),
    /** Minutes before pickup that the appointment is scheduled for, if any. */
    appointmentOffsetMinutes: integer('appointment_offset_minutes'),

    frequency: text('frequency').notNull().default('weekly'),
    /** 0 = Sunday. Used by weekly/biweekly. */
    byWeekday: integer('by_weekday').array().notNull().default(sql`'{}'::int[]`),
    /** Day of month, used by monthly. */
    byMonthDay: integer('by_month_day'),
    /** Local wall-clock pickup time, minutes from midnight in ORG_TIMEZONE. */
    pickupMinute: integer('pickup_minute').notNull(),
    startDate: text('start_date').notNull(), // YYYY-MM-DD, local
    endDate: text('end_date'),
    /** Preferred volunteer, offered first before the wider pool. */
    preferredVolunteerId: uuid('preferred_volunteer_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** How many minutes before pickup the occurrence should be offered. */
    leadTimeMinutes: integer('lead_time_minutes').notNull().default(1440),

    lastMaterialisedDate: text('last_materialised_date'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    refUq: uniqueIndex('recurring_rides_reference_uq').on(t.reference),
    activeIdx: index('recurring_rides_active_idx')
      .on(t.status)
      .where(sql`${t.deletedAt} is null`),
    callerIdx: index('recurring_rides_caller_idx').on(t.callerId),
  }),
);

/** One row per materialised occurrence, so a date is never produced twice. */
export const recurringRideOccurrences = pgTable(
  'recurring_ride_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recurringRideId: uuid('recurring_ride_id')
      .notNull()
      .references(() => recurringRides.id, { onDelete: 'cascade' }),
    occurrenceDate: text('occurrence_date').notNull(), // YYYY-MM-DD local
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    skipped: boolean('skipped').notNull().default(false),
    skipReason: text('skip_reason'),
    createdAt: createdAt(),
  },
  (t) => ({
    uq: uniqueIndex('recurring_ride_occurrences_uq').on(t.recurringRideId, t.occurrenceDate),
    tripIdx: index('recurring_ride_occurrences_trip_idx').on(t.tripId),
  }),
);

// ---------------------------------------------------------------------------
// Conversations — two-way SMS
//
// The legacy webhook understood four words and threw everything else away. A
// reply that is not a command is a person trying to talk to the organisation,
// so it becomes a message on a thread that somebody owns.
// ---------------------------------------------------------------------------

export const smsThreads = pgTable(
  'sms_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** E.164 of the other party. One live thread per number. */
    phone: text('phone').notNull(),
    partyType: text('party_type').notNull().default('unknown'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    callerId: uuid('caller_id').references(() => callers.id, { onDelete: 'set null' }),
    displayName: text('display_name'),
    status: text('status').notNull().default('open'),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    unreadCount: integer('unread_count').notNull().default(0),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedById: uuid('closed_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    phoneUq: uniqueIndex('sms_threads_phone_open_uq')
      .on(t.phone)
      .where(sql`${t.status} <> 'closed'`),
    queueIdx: index('sms_threads_queue_idx').on(t.status, t.lastMessageAt),
    ownerIdx: index('sms_threads_owner_idx').on(t.ownerId, t.status),
    phoneIdx: index('sms_threads_phone_idx').on(t.phone),
  }),
);

export const smsMessages = pgTable(
  'sms_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => smsThreads.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    body: text('body').notNull(),
    channel: text('channel').notNull().default('sms'),
    providerSid: text('provider_sid'),
    /** Who typed it. Null for inbound and for system-generated outbound. */
    sentById: uuid('sent_by_id').references(() => users.id, { onDelete: 'set null' }),
    deliveryId: uuid('delivery_id').references(() => notificationDeliveries.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('received'),
    failureReason: text('failure_reason'),
    readAt: timestamp('read_at', { withTimezone: true }),
    readById: uuid('read_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => ({
    threadIdx: index('sms_messages_thread_idx').on(t.threadId, t.createdAt),
    sidUq: uniqueIndex('sms_messages_provider_sid_uq')
      .on(t.providerSid)
      .where(sql`${t.providerSid} is not null`),
  }),
);

// ---------------------------------------------------------------------------
// Volunteer applications
//
// Applicants are NOT users. Nothing an applicant submits can reach the
// dispatch board, receive an offer, or log in, until an administrator approves
// it and the record is converted.
// ---------------------------------------------------------------------------

export const volunteerApplications = pgTable(
  'volunteer_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reference: text('reference').notNull(),
    status: text('status').notNull().default('submitted'),

    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    addressLine: text('address_line'),
    city: text('city'),
    postalCode: text('postal_code'),
    /** Free-text neighbourhoods the applicant is willing to serve. */
    serviceArea: text('service_area'),

    /** Slugs from service_types. Validated on submit. */
    requestedServices: text('requested_services').array().notNull().default(sql`'{}'::text[]`),
    requestedGroups: text('requested_groups').array().notNull().default(sql`'{}'::text[]`),
    capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),

    hasVehicle: boolean('has_vehicle').notNull().default(false),
    vehicleType: text('vehicle_type'),
    vehicleSeats: integer('vehicle_seats'),

    availabilityNote: text('availability_note'),
    /** Same shape as availability_rules, applied on approval. */
    availability: jsonb('availability').$type<Array<{ weekday: number; startMinute: number; endMinute: number }>>(),

    languages: text('languages').array().notNull().default(sql`'{}'::text[]`),
    referredBy: text('referred_by'),
    notes: text('notes'),

    notificationPreference: text('notification_preference').notNull().default('sms'),
    consentContact: boolean('consent_contact').notNull().default(false),
    consentBackgroundCheck: boolean('consent_background_check').notNull().default(false),
    consentTextAt: timestamp('consent_text_at', { withTimezone: true }),
    consentTextVersion: text('consent_text_version'),

    /** Anti-abuse. Retained only for the abuse window, then scrubbed. */
    submittedIp: text('submitted_ip'),
    submittedUserAgent: text('submitted_user_agent'),

    duplicateOfUserId: uuid('duplicate_of_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    duplicateOfApplicationId: uuid('duplicate_of_application_id'),

    reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNotes: text('review_notes'),
    infoRequestedAt: timestamp('info_requested_at', { withTimezone: true }),
    infoRequestMessage: text('info_request_message'),
    convertedUserId: uuid('converted_user_id').references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    refUq: uniqueIndex('volunteer_applications_reference_uq').on(t.reference),
    statusIdx: index('volunteer_applications_status_idx').on(t.status, t.createdAt),
    emailIdx: index('volunteer_applications_email_idx').on(sql`lower(${t.email})`),
    phoneIdx: index('volunteer_applications_phone_idx').on(t.phone),
    /** One live application per phone number; re-submission updates it. */
    openUq: uniqueIndex('volunteer_applications_open_phone_uq')
      .on(t.phone)
      .where(sql`${t.status} in ('submitted','info_requested') and ${t.deletedAt} is null`),
  }),
);

// ---------------------------------------------------------------------------
// Stored files
//
// Licence images and export artefacts. Bytes live behind an ObjectStore
// provider (local filesystem by default, S3-compatible in production); this
// table is the authorisation record and the only way to resolve a key.
// ---------------------------------------------------------------------------

export const storedFiles = pgTable(
  'stored_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Opaque storage key. Never derived from user input. */
    storageKey: text('storage_key').notNull(),
    bucket: text('bucket').notNull().default('private'),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    /** Sensitivity gate: 'restricted' files are readable by admins only. */
    sensitivity: text('sensitivity').notNull().default('restricted'),
    encrypted: boolean('encrypted').notNull().default(true),
    originalName: text('original_name'),
    uploadedById: uuid('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    keyUq: uniqueIndex('stored_files_key_uq').on(t.storageKey),
    purgeIdx: index('stored_files_purge_idx').on(t.purgeAfter),
  }),
);

/**
 * File bytes for FILE_STORAGE_DRIVER=db. Keeping the (already encrypted) bytes
 * in Postgres means the nightly database backup is also the file backup, and a
 * host with an ephemeral disk (Render free) cannot silently lose them.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => v,
  fromDriver: (v) => Buffer.from(v),
});

export const storedFileBlobs = pgTable('stored_file_blobs', {
  storageKey: text('storage_key').primaryKey(),
  contentType: text('content_type').notNull(),
  body: bytea('body').notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Driver licences
//
// `status = 'verified'` is written ONLY by a verification provider that
// returned a positive result, together with the provider name and its
// reference. No administrator action and no absence of a provider can produce
// that value — see domain.ts and docs/SECURITY.md.
// ---------------------------------------------------------------------------

export const driverLicences = pgTable(
  'driver_licences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    applicationId: uuid('application_id').references(() => volunteerApplications.id, {
      onDelete: 'cascade',
    }),
    province: text('province').notNull().default('QC'),
    country: text('country').notNull().default('CA'),
    /** AES-256-GCM ciphertext. The plaintext number is never stored or logged. */
    numberCiphertext: text('number_ciphertext'),
    /** Last 4 only, for an administrator to match against the image. */
    numberLast4: text('number_last4'),
    expiresOn: text('expires_on'), // YYYY-MM-DD
    frontFileId: uuid('front_file_id').references(() => storedFiles.id, { onDelete: 'set null' }),
    backFileId: uuid('back_file_id').references(() => storedFiles.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending_review'),
    reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNotes: text('review_notes'),
    /** Populated together, or not at all. */
    verificationProvider: text('verification_provider'),
    verificationReference: text('verification_reference'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    userIdx: index('driver_licences_user_idx').on(t.userId),
    appIdx: index('driver_licences_application_idx').on(t.applicationId),
    expiryIdx: index('driver_licences_expiry_idx').on(t.expiresOn),
    oneLiveUq: uniqueIndex('driver_licences_one_live_per_user_uq')
      .on(t.userId)
      .where(sql`${t.userId} is not null and ${t.deletedAt} is null`),
  }),
);

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    channel: text('channel').notNull(),
    locale: text('locale').notNull().default('en'),
    subject: text('subject'),
    body: text('body').notNull(),
    description: text('description'),
    /** Variable names this template is allowed to reference. */
    variables: text('variables').array().notNull().default(sql`'{}'::text[]`),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    uq: uniqueIndex('message_templates_key_channel_locale_uq').on(t.key, t.channel, t.locale),
    keyIdx: index('message_templates_key_idx').on(t.key),
  }),
);

/** Append-only history, so an edit that breaks a message can be traced. */
export const messageTemplateVersions = pgTable(
  'message_template_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => messageTemplates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    changedById: uuid('changed_by_id').references(() => users.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('message_template_versions_uq').on(t.templateId, t.version),
  }),
);

// ---------------------------------------------------------------------------
// Duty roster
// ---------------------------------------------------------------------------

export const dutyShifts = pgTable(
  'duty_shifts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull().default('phone'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    notes: text('notes'),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    windowIdx: index('duty_shifts_window_idx').on(t.startsAt, t.endsAt),
    userIdx: index('duty_shifts_user_idx').on(t.userId, t.startsAt),
    kindIdx: index('duty_shifts_kind_idx').on(t.kind, t.startsAt),
  }),
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const dataExports = pgTable(
  'data_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('queued'),
    requestedById: uuid('requested_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    rowCount: integer('row_count'),
    fileId: uuid('file_id').references(() => storedFiles.id, { onDelete: 'set null' }),
    error: text('error'),
    /** Exports carry personal data; they self-destruct. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    requesterIdx: index('data_exports_requester_idx').on(t.requestedById, t.createdAt),
    statusIdx: index('data_exports_status_idx').on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// Announcements / bulk broadcast
// ---------------------------------------------------------------------------

export const announcements = pgTable(
  'announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** Optional picture as a data URL; served publicly by id so SMS/WhatsApp/email can show it. */
    imageData: text('image_data'),
    /** Recipient selection, replayed when sending so the audit shows the query. */
    audience: jsonb('audience').$type<Record<string, unknown>>().notNull(),
    channels: text('channels').array().notNull().default(sql`'{}'::text[]`),
    status: text('status').notNull().default('draft'),
    recipientCount: integer('recipient_count').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ statusIdx: index('announcements_status_idx').on(t.status, t.createdAt) }),
);


export type UserRow = typeof users.$inferSelect;
export type TripRow = typeof trips.$inferSelect;
export type TripOfferRow = typeof tripOffers.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

export type CallerRow = typeof callers.$inferSelect;
export type RecurringRideRow = typeof recurringRides.$inferSelect;
export type SmsThreadRow = typeof smsThreads.$inferSelect;
export type SmsMessageRow = typeof smsMessages.$inferSelect;
export type VolunteerApplicationRow = typeof volunteerApplications.$inferSelect;
export type DriverLicenceRow = typeof driverLicences.$inferSelect;
export type MessageTemplateRow = typeof messageTemplates.$inferSelect;
export type DutyShiftRow = typeof dutyShifts.$inferSelect;

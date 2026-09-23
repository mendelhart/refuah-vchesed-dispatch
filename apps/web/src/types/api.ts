/**
 * Response envelopes for the endpoints in apps/api/src/routes.
 *
 * Entity shapes that the API already publishes (TripDto, OfferedTripDto,
 * SessionUser, …) are imported from `@rvc/shared` rather than restated here, so
 * the two cannot drift. What lives in this file is only the wrapper each route
 * returns and the handful of ad-hoc row shapes the routes build inline.
 */
import type {
  InviteChannel,
  AddressDto,
  AuditEventDto,
  BoardSummary,
  DeliveryStatus,
  NotificationChannel,
  OfferedTripDto,
  OfferStatus,
  Role,
  SessionUser,
  TripDto,
  UserStatus,
} from '@rvc/shared';

export type AnyTrip = TripDto | OfferedTripDto;

/** `OfferedTripDto` has no `pickup`; a dispatcher-visible trip always does. */
export function isFullTrip(trip: AnyTrip): trip is TripDto {
  return 'pickup' in trip;
}

export interface TripListResponse {
  items: AnyTrip[];
  nextCursor: string | null;
}
export interface TripResponse {
  trip: AnyTrip;
}
export interface ClaimResponse {
  trip: AnyTrip;
  claimed: true;
}
export interface OfferResponse {
  tripId: string;
  offered: number;
  expiresAt: string;
  skipped: { volunteerId: string; reason: string }[];
  trip: AnyTrip;
}
export interface AcceptOfferResponse {
  tripId: string;
  reference: string;
  claimed: true;
}
export type BoardSummaryResponse = BoardSummary;

export interface TripOfferRow {
  id: string;
  volunteerId: string;
  volunteerName: string;
  status: OfferStatus;
  round: number;
  offeredAt: string;
  expiresAt: string;
  respondedAt: string | null;
  responseChannel: string | null;
}
export interface TripAssignmentRow {
  id: string;
  volunteerId: string;
  volunteerName: string;
  source: string;
  assignedAt: string;
  unassignedAt: string | null;
  unassignedReason: string | null;
}
/** Raw audit row as stored; the audit table columns, not `AuditEventDto`. */
export interface AuditRow {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  previous: unknown;
  next: unknown;
  metadata: unknown;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}
export interface TripHistoryResponse {
  events: {
    events: AuditRow[];
    offers: TripOfferRow[];
    assignments: TripAssignmentRow[];
  };
}
export interface AuditListResponse {
  events: AuditRow[];
}
/** Kept so the shared DTO is referenced somewhere and stays in step. */
export type AuditEvent = AuditEventDto;

export interface SessionResponse {
  user: SessionUser;
}
export interface OkResponse {
  ok: true;
}

export interface DirectoryPerson {
  id: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  photoUrl: string | null;
  groupSlugs: string[];
  /** Null for volunteers: the roster is visible, contact details are not. */
  email: string | null;
  phone: string | null;
  /** False until they set a password (never invited, or invite not used). */
  activated?: boolean;
  /** How offers reach them; null for non-staff viewers. */
  notificationPreference?: string | null;
}
export interface UserListResponse {
  users: DirectoryPerson[];
}
export interface DirectoryResponse {
  volunteers: DirectoryPerson[];
}
export interface CreateUserResponse {
  user: { id: string; email: string | null; fullName: string; role: Role };
  inviteUrl: string | null;
  invitedVia?: InviteChannel[];
}
export interface InviteUrlResponse {
  inviteUrl: string;
  invitedVia?: InviteChannel[];
}
export interface EligibleVolunteersResponse {
  volunteers: { id: string; fullName: string; phone: string | null; role: Role }[];
}
export interface GroupsResponse {
  groups: { id: string; slug: string; name: string }[];
}

export interface ImpactTripRow {
  id: string;
  reference: string;
  status: string;
  pickupAt: string;
  completedAt: string | null;
  tripType: string;
  city: string;
}
export interface ImpactResponse {
  totals: {
    completed: number;
    completedThisMonth: number;
    upcoming: number;
    volunteeringSince: string | null;
  };
  trips: ImpactTripRow[];
}

export interface OrgImpactResponse {
  totals: {
    completed: number;
    completedThisMonth: number;
    completedThisYear: number;
    upcoming: number;
    volunteersAllTime: number;
    volunteersLast30Days: number;
    peopleHelped: number;
    since: string | null;
  };
  byType: Array<{ tripType: string; count: number }>;
  byMonth: Array<{ month: string; count: number }>;
}

export interface MeStatusResponse {
  mutedUntil: string | null;
  availability: unknown;
}
export interface MuteResponse {
  mutedUntil: string | null;
}
export interface PushKeyResponse {
  publicKey: string;
}

export interface CallRow {
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  durationSeconds: number | null;
  startedAt: string | null;
  counterpartyName: string | null;
  destinationLast4: string | null;
  failureReason: string | null;
  tripId: string | null;
  tripReference: string | null;
  initiatedByName: string;
  /** "No answer" / "Failed" / null when the call connected normally. */
  outcomeLabel: string | null;
  /** "—" when the call never connected. */
  durationLabel: string;
  counterparty: string;
}
export interface CallListResponse {
  calls: CallRow[];
}
export interface StartCallResponse {
  call: { id: string; status: string; counterpartyName: string | null };
  message: string;
}

export interface DeliveryRow {
  id: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  queuedAt: string;
  sentAt: string | null;
  event: string;
  title: string | null;
  recipientName: string;
  tripId: string | null;
}
export interface DeliveryHealth {
  failed: number;
  queued: number;
  skipped: number;
  delivered: number;
}
export interface DeliveriesResponse {
  deliveries: DeliveryRow[];
  health: DeliveryHealth;
}
export interface NotificationRow {
  id: string;
  event: string;
  title: string | null;
  body: string | null;
  tripId: string | null;
  createdAt: string;
  readAt: string | null;
}
export interface NotificationsResponse {
  notifications: NotificationRow[];
  unread: number;
}
export interface SmsEventRow {
  id: string;
  direction: string;
  outcome: string;
  detail: string | null;
  signatureValid: boolean | null;
  createdAt: string;
  matchedUserName: string | null;
}
export interface SmsEventsResponse {
  events: SmsEventRow[];
}

export interface SettingsResponse {
  settings: Record<string, number | string | boolean>;
  defaults: Record<string, number>;
}
export interface OpsHealthResponse {
  deliveries: DeliveryHealth;
  jobs: { pending: number; running: number; overdue: number; dead: number };
}

export interface ContactRow {
  id: string;
  name: string;
  phone: string;
  role: string | null;
  notes: string | null;
  address: AddressDto | null;
  createdAt: string;
}
export interface ContactsResponse {
  contacts: ContactRow[];
}
export interface VehicleRow {
  id: string;
  label: string;
  vehicleType: string;
  plate: string | null;
  capacity: number | null;
  status: string;
  notes: string | null;
  lastMaintenanceAt: string | null;
  nextMaintenanceAt: string | null;
}
export interface VehiclesResponse {
  vehicles: VehicleRow[];
}
export interface EquipmentRow {
  id: string;
  categoryId: string | null;
  itemCode: string | null;
  barcode: string | null;
  equipmentType: string;
  status: string;
  condition: string;
  notes: string | null;
  createdAt: string;
}
export interface EquipmentResponse {
  equipment: EquipmentRow[];
}
export interface EquipmentCategoryRow {
  id: string;
  name: string;
  description: string | null;
}
export interface EquipmentCategoriesResponse {
  categories: EquipmentCategoryRow[];
}
export interface EquipmentLoanRow {
  id: string;
  equipmentId: string;
  borrowerName: string;
  borrowerPhone: string;
  loanedAt: string;
  expectedReturnAt: string | null;
  returnedAt: string | null;
  itemCode: string | null;
  equipmentType: string;
}
export interface EquipmentLoansResponse {
  loans: EquipmentLoanRow[];
}
export interface OrganizationResponse {
  organization: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    website: string | null;
    addressLine: string | null;
    emergencyContact: string | null;
  } | null;
}

/** Exactly the geocoder result the API proxies back (never called direct). */
export interface AddressSuggestion {
  formatted: string;
  line1: string;
  unit: string | null;
  city: string;
  province: string;
  postalCode: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
}
export interface AddressSearchResponse {
  results: AddressSuggestion[];
}

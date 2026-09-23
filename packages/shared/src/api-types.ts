/** Wire shapes returned by the API. Kept narrow on purpose: the server sends
 *  the minimum each audience needs (see docs/SECURITY.md, "data minimisation"). */
import type {
  AssignmentMode, DeliveryStatus, MobilityNeed, NotificationChannel, NotificationPreference,
  OfferStatus, Role, TripPriority, TripStatus, TripTransition, TripType, UserStatus,
} from './domain.js';

export interface ApiError {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  phone: string | null;
  groups: { id: string; slug: string; name: string }[];
  notificationPreference: NotificationPreference;
  mustChangePassword: boolean;
  /** Route paths the user hid from their menu. Empty = show everything. */
  navHidden: string[];
}

export interface AddressDto {
  id: string;
  line1: string; unit: string | null; city: string; province: string;
  postalCode: string | null; country: string; notes: string | null;
  formatted: string;
  latitude: number | null; longitude: number | null;
}

/** What a dispatcher sees. */
export interface TripDto {
  id: string;
  reference: string;
  status: TripStatus;
  priority: TripPriority;
  tripType: TripType;
  assignmentMode: AssignmentMode;
  group: { id: string; slug: string; name: string };
  callerId: string | null;
  callerName: string | null;
  callerPhone: string | null;
  /** Number to reach about this trip — often a ward desk, not the caller. */
  callbackNumber: string | null;
  pickup: AddressDto;
  dropoff: AddressDto;
  pickupEntrance: string | null;
  pickupParking: string | null;
  dropoffEntrance: string | null;
  dropoffParking: string | null;
  pickupAt: string;
  /** The appointment the ride exists for, when it differs from pickup. */
  appointmentAt: string | null;
  mobilityNeeds: MobilityNeed[];
  passengerNotes: string | null;
  /** Provenance, not state: neither carries anything from the source trip. */
  recurringRideId: string | null;
  duplicatedFromTripId: string | null;
  offerRound: number;
  escalationCount: number;
  escalatedAt: string | null;
  assignedVolunteer: { id: string; fullName: string; phone: string | null } | null;
  openOfferCount: number;
  interestedCount: number;
  offerExpiresAt: string | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  availableTransitions: TripTransition[];
}

/** What a volunteer sees for a trip they have not yet claimed. Deliberately
 *  omits caller identity and the exact pickup address. */
export interface OfferedTripDto {
  id: string;
  reference: string;
  status: TripStatus;
  priority: TripPriority;
  tripType: TripType;
  pickupArea: string;
  dropoffArea: string;
  pickupAt: string;
  /** Shown so a volunteer can judge whether the timing works for them. */
  appointmentAt: string | null;
  mobilityNeeds: MobilityNeed[];
  offer: { id: string; expiresAt: string; status: OfferStatus } | null;
}

export interface NotificationDeliveryDto {
  id: string; channel: NotificationChannel; status: DeliveryStatus;
  attempts: number; lastError: string | null; providerMessageId: string | null;
  queuedAt: string; sentAt: string | null;
}

export interface AuditEventDto {
  id: string; occurredAt: string;
  actor: { id: string | null; name: string; role: Role | 'system' };
  action: string; entityType: string; entityId: string;
  previous: unknown; next: unknown; metadata: unknown;
}

export interface BoardSummary {
  needsAttention: number; offered: number; assigned: number;
  inProgress: number; overdue: number; unanswered: number;
}

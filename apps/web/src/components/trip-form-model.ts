/**
 * The trip form's data model: blank/edit starting values, the request body the
 * form sends, and zod error mapping. Pure functions, no React, so they can be
 * unit-tested without a browser.
 */
import type { z } from 'zod';
import type { AssignmentMode, MobilityNeed, TripDto, TripPriority, TripType } from '@rvc/shared';
import { emptyAddress, toAddressInput, type AddressDraft } from './address-draft';

export interface FormState {
  isTest: boolean;
  callerId: string | null;
  callerName: string;
  callerPhone: string;
  callbackNumber: string;
  pickup: AddressDraft;
  pickupEntrance: string;
  pickupParking: string;
  dropoff: AddressDraft;
  dropoffEntrance: string;
  dropoffParking: string;
  pickupAt: string;
  appointmentAt: string;
  tripType: TripType;
  priority: TripPriority;
  groupSlug: string;
  assignmentMode: AssignmentMode;
  mobilityNeeds: MobilityNeed[];
  passengerNotes: string;
}

/** `datetime-local` wants local wall-clock time, not an ISO-Z string. */
export function nowLocalInput(): string {
  return toLocalInput(new Date().toISOString());
}

/** `datetime-local` wants local wall-clock time, not an ISO-Z string. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function blankForm(): FormState {
  return {
    isTest: false,
    callerId: null,
    callerName: '',
    callerPhone: '',
    callbackNumber: '',
    pickup: emptyAddress(),
    pickupEntrance: '',
    pickupParking: '',
    dropoff: emptyAddress(),
    dropoffEntrance: '',
    dropoffParking: '',
    pickupAt: nowLocalInput(),
    appointmentAt: '',
    tripType: 'ride',
    priority: 'routine',
    groupSlug: 'chesed_on_the_go',
    assignmentMode: 'auto',
    mobilityNeeds: [],
    passengerNotes: '',
  };
}

export function fromTrip(trip: TripDto): FormState {
  const draft = (address: TripDto['pickup']): AddressDraft => ({
    line1: address.line1,
    unit: address.unit ?? '',
    city: address.city,
    province: address.province,
    postalCode: address.postalCode ?? '',
    country: address.country,
    notes: address.notes ?? '',
    latitude: address.latitude,
    longitude: address.longitude,
  });
  return {
    isTest: trip.isTest ?? false,
    callerId: trip.callerId,
    callerName: trip.callerName ?? '',
    callerPhone: trip.callerPhone ?? '',
    callbackNumber: trip.callbackNumber ?? '',
    pickup: draft(trip.pickup),
    pickupEntrance: trip.pickupEntrance ?? '',
    pickupParking: trip.pickupParking ?? '',
    dropoff: draft(trip.dropoff),
    dropoffEntrance: trip.dropoffEntrance ?? '',
    dropoffParking: trip.dropoffParking ?? '',
    pickupAt: toLocalInput(trip.pickupAt),
    appointmentAt: toLocalInput(trip.appointmentAt),
    tripType: trip.tripType,
    priority: trip.priority,
    groupSlug: trip.group.slug,
    assignmentMode: trip.assignmentMode,
    mobilityNeeds: trip.mobilityNeeds,
    passengerNotes: trip.passengerNotes ?? '',
  };
}

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form';
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}


/**
 * The body sent to POST /api/trips (new) or PATCH /api/trips/:id (edit).
 * An omitted key means "leave it alone"; an explicit null means "clear it".
 */
export function buildTripPayload(form: FormState, trip?: TripDto | null) {
  // An omitted key means "leave it alone"; an explicit null means "clear it".
  // Sending null for a field nobody ever filled in would wipe values a
  // different screen may have set.
  const text = (value: string, previous: string | null | undefined): string | null | undefined => {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
    return previous ? null : undefined;
  };
  const when = (value: string, previous: string | null | undefined): string | null | undefined => {
    if (value) return new Date(value).toISOString();
    return previous ? null : undefined;
  };
  const extras: Record<string, unknown> = {
    callerId: form.callerId ?? (trip?.callerId ? null : undefined),
    callbackNumber: text(form.callbackNumber, trip?.callbackNumber),
    appointmentAt: when(form.appointmentAt, trip?.appointmentAt),
    pickupEntrance: text(form.pickupEntrance, trip?.pickupEntrance),
    pickupParking: text(form.pickupParking, trip?.pickupParking),
    dropoffEntrance: text(form.dropoffEntrance, trip?.dropoffEntrance),
    dropoffParking: text(form.dropoffParking, trip?.dropoffParking),
  };
  for (const key of Object.keys(extras)) {
    if (extras[key] === undefined) delete extras[key];
  }
  return {
    ...extras,
    ...(trip ? {} : { isTest: form.isTest }),
    callerName: form.callerName.trim() || null,
    callerPhone: form.callerPhone.trim() || null,
    pickup: toAddressInput(form.pickup),
    dropoff: toAddressInput(form.dropoff),
    pickupAt: form.pickupAt ? new Date(form.pickupAt).toISOString() : '',
    tripType: form.tripType,
    priority: form.priority,
    groupSlug: form.groupSlug,
    assignmentMode: form.assignmentMode,
    mobilityNeeds: form.mobilityNeeds,
    passengerNotes: form.passengerNotes.trim() || null,
  };
}

import { describe, expect, it } from 'vitest';
import { createTripSchema, updateTripSchema, type TripDto } from '@rvc/shared';
import { blankForm, buildTripPayload, fieldErrors, fromTrip, toLocalInput } from '@/components/trip-form-model';

function filledForm() {
  const form = blankForm();
  form.callerName = '  Mrs Cohen ';
  form.callerPhone = '514-555-0101';
  form.pickup = { ...form.pickup, line1: '5800 Rue Hutchison' };
  form.dropoff = { ...form.dropoff, line1: '3755 Chemin de la Cote-Sainte-Catherine' };
  return form;
}

function existingTrip(): TripDto {
  const base = buildTripPayload(filledForm());
  return {
    id: '00000000-0000-4000-8000-000000000001', callerId: '00000000-0000-4000-8000-000000000002', callerName: 'Mrs Cohen', callerPhone: '514-555-0101',
    callbackNumber: '514-555-0199', pickup: base.pickup, dropoff: base.dropoff,
    pickupEntrance: 'side door', pickupParking: null, dropoffEntrance: null, dropoffParking: null,
    pickupAt: '2026-09-24T14:00:00.000Z', appointmentAt: null, tripType: 'ride', priority: 'routine',
    group: { slug: 'chesed_on_the_go' }, assignmentMode: 'auto', mobilityNeeds: ['wheelchair'],
    passengerNotes: null, version: 3,
  } as unknown as TripDto;
}

describe('trip form: new trip', () => {
  it('starts with sensible defaults', () => {
    const form = blankForm();
    expect(form.tripType).toBe('ride');
    expect(form.priority).toBe('routine');
    expect(form.assignmentMode).toBe('auto');
    expect(form.pickup.city).toBe('Montreal');
    expect(form.pickupAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('builds a body the server schema accepts, trimmed', () => {
    const payload = buildTripPayload(filledForm());
    expect(payload.callerName).toBe('Mrs Cohen');
    expect(createTripSchema.safeParse(payload).success).toBe(true);
  });

  it('does not send empty optional fields at all', () => {
    const payload = buildTripPayload(filledForm()) as Record<string, unknown>;
    for (const key of ['callbackNumber', 'appointmentAt', 'pickupEntrance', 'callerId']) {
      expect(key in payload).toBe(false);
    }
  });

  it('flags a missing caller name and phone on a ride', () => {
    const form = filledForm();
    form.callerName = '';
    form.callerPhone = '';
    const result = createTripSchema.safeParse(buildTripPayload(form));
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = fieldErrors(result.error);
      expect(errors.callerName).toBe('Caller name is required');
      expect(errors.callerPhone).toBe('Caller phone is required');
    }
  });

  it('lets a hospital food run go without a caller', () => {
    const form = filledForm();
    form.callerName = '';
    form.callerPhone = '';
    form.tripType = 'hospital_food';
    expect(createTripSchema.safeParse(buildTripPayload(form)).success).toBe(true);
  });
});

describe('trip form: editing', () => {
  it('round-trips an existing trip without changing anything', () => {
    const trip = existingTrip();
    const form = fromTrip(trip);
    expect(form.pickupEntrance).toBe('side door');
    expect(form.mobilityNeeds).toEqual(['wheelchair']);
    const payload = buildTripPayload(form, trip);
    expect(payload.pickupAt).toBe(trip.pickupAt);
    expect(updateTripSchema.safeParse(payload).success).toBe(true);
  });

  it('sends null to clear a field the dispatcher emptied', () => {
    const trip = existingTrip();
    const form = fromTrip(trip);
    form.callbackNumber = '';
    form.pickupEntrance = '  ';
    const payload = buildTripPayload(form, trip) as Record<string, unknown>;
    expect(payload.callbackNumber).toBeNull();
    expect(payload.pickupEntrance).toBeNull();
    // Never filled in before, so left out rather than cleared.
    expect('dropoffParking' in payload).toBe(false);
  });
});

describe('toLocalInput', () => {
  it('handles empty and bad values', () => {
    expect(toLocalInput(null)).toBe('');
    expect(toLocalInput('not a date')).toBe('');
  });
});

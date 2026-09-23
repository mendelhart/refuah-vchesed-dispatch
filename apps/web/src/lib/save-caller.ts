/**
 * One tap from "a name and number on a trip" to a saved caller in Contacts.
 * Offered wherever a dispatcher has handled a trip for somebody Contacts does
 * not know yet. The trip's pickup becomes the caller's default address,
 * entrance and parking included, and the trip is linked to the new contact.
 * If the number is already on file, the trip is linked to that contact instead
 * of failing.
 */
import type { TripDto } from '@rvc/shared';
import { api, ApiError } from '@/lib/api';

export interface SavedCaller {
  callerId: string;
  alreadyOnFile: boolean;
}

export async function saveCallerFromTrip(trip: TripDto): Promise<SavedCaller> {
  let callerId: string;
  let alreadyOnFile = false;
  try {
    const created = await api.post<{ caller: { id: string } }>('/api/callers', {
      name: trip.callerName ?? trip.callerPhone ?? 'New caller',
      primaryPhone: trip.callerPhone ?? null,
    });
    callerId = created.caller.id;
  } catch (error) {
    const existing =
      error instanceof ApiError && error.isConflict
        ? (error.details as { existingCallerId?: string } | undefined)?.existingCallerId
        : undefined;
    if (!existing) throw error;
    callerId = existing;
    alreadyOnFile = true;
  }
  if (!alreadyOnFile && trip.pickup?.line1) {
    await api.post(`/api/callers/${callerId}/addresses`, {
      line1: trip.pickup.line1,
      unit: trip.pickup.unit ?? null,
      city: trip.pickup.city,
      province: trip.pickup.province,
      postalCode: trip.pickup.postalCode ?? null,
      country: trip.pickup.country,
      notes: trip.pickup.notes ?? null,
      latitude: trip.pickup.latitude ?? null,
      longitude: trip.pickup.longitude ?? null,
      label: 'home',
      entrance: trip.pickupEntrance ?? null,
      parking: trip.pickupParking ?? null,
      isDefaultPickup: true,
    });
  }
  // Link the trip so the offer disappears and the caller's history includes it.
  await api.patch(`/api/trips/${trip.id}`, { callerId });
  return { callerId, alreadyOnFile };
}

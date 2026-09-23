/**
 * One tap from "a name and number on a trip" to a repeat-caller directory
 * entry. Offered wherever a dispatcher has just handled a trip for somebody
 * the directory does not know yet; the trip's pickup becomes the caller's
 * default address, entrance and parking included, so the next dispatcher
 * never has to ask for the door twice.
 */
import type { TripDto } from '@rvc/shared';
import { api } from '@/lib/api';

export async function saveCallerFromTrip(trip: TripDto): Promise<void> {
  const created = await api.post<{ caller: { id: string } }>('/api/callers', {
    name: trip.callerName ?? trip.callerPhone ?? 'New caller',
    primaryPhone: trip.callerPhone ?? null,
  });
  if (trip.pickup?.line1) {
    await api.post(`/api/callers/${created.caller.id}/addresses`, {
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
}

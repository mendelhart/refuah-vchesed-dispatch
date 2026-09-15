/**
 * Trip state changes.
 *
 * Every one of these is a POST to the endpoint that owns that transition. The
 * client does not decide whether a transition is legal — the server does, and
 * it publishes the answer as `trip.availableTransitions`. Nothing here reads a
 * status and infers what should happen next.
 *
 * Every mutation toasts on success AND on failure.
 */
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, api, errorMessage } from './api';
import { invalidateTrips } from './query';
import type { ClaimResponse, OfferResponse, TripResponse } from '@/types/api';

interface TransitionVars {
  tripId: string;
  reason?: string;
  note?: string;
  volunteerId?: string;
  volunteerIds?: string[];
  expiresInMinutes?: number;
}

function useTripMutation<TData>(
  run: (vars: TransitionVars) => Promise<TData>,
  successMessage: (vars: TransitionVars, data: TData) => string,
): UseMutationResult<TData, unknown, TransitionVars> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (data, vars) => {
      invalidateTrips(queryClient, vars.tripId);
      toast.success(successMessage(vars, data));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });
}

export function useOfferTrip() {
  return useTripMutation<OfferResponse>(
    (vars) =>
      api.post<OfferResponse>(`/api/trips/${vars.tripId}/offer`, {
        ...(vars.volunteerIds?.length ? { volunteerIds: vars.volunteerIds } : {}),
        ...(vars.expiresInMinutes ? { expiresInMinutes: vars.expiresInMinutes } : {}),
      }),
    (_vars, data) =>
      data.offered === 1 ? 'Offered to 1 volunteer.' : `Offered to ${data.offered} volunteers.`,
  );
}

export function useAssignTrip() {
  return useTripMutation<TripResponse>(
    (vars) => api.post<TripResponse>(`/api/trips/${vars.tripId}/assign`, { volunteerId: vars.volunteerId, ...(vars.reason ? { reason: vars.reason } : {}) }),
    () => 'Volunteer assigned.',
  );
}

export function useReassignTrip() {
  return useTripMutation<TripResponse>(
    (vars) => api.post<TripResponse>(`/api/trips/${vars.tripId}/reassign`, { volunteerId: vars.volunteerId, reason: vars.reason ?? '' }),
    () => 'Trip moved to another volunteer.',
  );
}

export function useCancelTrip() {
  return useTripMutation<TripResponse>(
    (vars) => api.post<TripResponse>(`/api/trips/${vars.tripId}/cancel`, { reason: vars.reason ?? '' }),
    () => 'Trip cancelled.',
  );
}

export function useReturnToPending() {
  return useTripMutation<TripResponse>(
    (vars) => api.post<TripResponse>(`/api/trips/${vars.tripId}/return-to-pending`, { reason: vars.reason ?? '' }),
    () => 'Trip is back in the queue.',
  );
}

export function useCompleteTrip() {
  return useTripMutation<TripResponse>(
    (vars) => api.post<TripResponse>(`/api/trips/${vars.tripId}/complete`, vars.note ? { note: vars.note } : {}),
    () => 'Trip marked complete. Thank you.',
  );
}

export function useStartEnRoute() {
  return useTripMutation<TripResponse>(
    (vars) => api.post<TripResponse>(`/api/trips/${vars.tripId}/en-route`, vars.note ? { note: vars.note } : {}),
    () => 'Marked on the way.',
  );
}

export function useStartTrip() {
  return useTripMutation<TripResponse>(
    (vars) => api.post<TripResponse>(`/api/trips/${vars.tripId}/start`, vars.note ? { note: vars.note } : {}),
    () => 'Trip started.',
  );
}

/**
 * Accept an offer. A lost race comes back as a 409 and is surfaced in plain
 * words — never a silent no-op, which is what the old app did.
 */
export function useClaimTrip(): UseMutationResult<ClaimResponse, unknown, { tripId: string; offerToken?: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { tripId: string; offerToken?: string }) =>
      api.post<ClaimResponse>(`/api/trips/${vars.tripId}/claim`, vars.offerToken ? { offerToken: vars.offerToken } : {}),
    onSuccess: (_data, vars) => {
      invalidateTrips(queryClient, vars.tripId);
      toast.success('This ride is yours. The details are on your rides screen.');
    },
    onError: (error: unknown, vars) => {
      invalidateTrips(queryClient, vars.tripId);
      if (error instanceof ApiError && error.isConflict) {
        toast.error('Another volunteer accepted this first.', {
          description: 'Nothing went wrong on your side — the ride is covered.',
          duration: 8000,
        });
        return;
      }
      toast.error(errorMessage(error));
    },
  });
}

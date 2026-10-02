/**
 * Trip detail: the other rides in this person's outing (journeys feature).
 * A coordinator sees every leg and can arrange the ride home when the
 * passenger calls. A driver sees only "ride 2 of 3": never the other legs.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Route as RouteIcon, PhoneCall } from 'lucide-react';
import type { JourneyView } from '@rvc/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { invalidateTrips } from '@/lib/query';
import { formatDateTime, statusLabel } from '@/lib/format';
import type { TripStatus } from '@rvc/shared';
import { primaryButtonClass } from './states';

type JourneyResponse = { journey: JourneyView } | { position: { legIndex: number; legCount: number } };

export function JourneyPanel({ tripId, cardClass }: { tripId: string; cardClass: string }): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['trips', tripId, 'journey'],
    queryFn: async () => {
      try {
        return await api.get<JourneyResponse>(`/api/trips/${tripId}/journey`);
      } catch (error) {
        // Not part of a journey (or the feature is off): show nothing.
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
  const ready = useMutation({
    mutationFn: (journeyId: string) => api.post<{ tripId: string }>(`/api/journeys/${journeyId}/return-ready`, {}),
    onSuccess: () => {
      toast.success('Ride home created. Offer it to drivers from its page.');
      invalidateTrips(queryClient);
      void q.refetch();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (!q.data) return null;
  if ('position' in q.data) {
    const { legIndex, legCount } = q.data.position;
    return (
      <section className={cardClass}>
        <p className="flex items-center gap-2 p-5 text-sm text-slate-700 dark:text-slate-200">
          <RouteIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          This is ride {legIndex + 1} of {legCount} in this person's outing. Other drivers may take the other rides.
        </p>
      </section>
    );
  }

  const j = q.data.journey;
  return (
    <section className={cardClass} aria-labelledby="journey-panel-heading">
      <div className="p-5 md:p-6">
        <h2 id="journey-panel-heading" className="mb-1 text-lg font-semibold text-slate-900 dark:text-white">The whole outing</h2>
        <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
          {j.legs.length} {j.legs.length === 1 ? 'ride' : 'rides'}
          {j.seatsNeeded > 0 ? `, ${j.seatsNeeded} ${j.seatsNeeded === 1 ? 'seat' : 'seats'} needed` : ''}. Each ride is offered and cancelled on its own.
        </p>
        <ol className="space-y-2">
          {j.legs.map((leg) => (
            <li key={leg.tripId} className={`rounded-lg border p-3 ${leg.tripId === tripId ? 'border-slate-500 dark:border-slate-400' : 'border-slate-200 dark:border-slate-700'}`}>
              <p className="text-sm font-medium text-slate-900 dark:text-white">
                {leg.isReturn ? 'Ride home' : `Ride ${leg.legIndex + 1}`} · {formatDateTime(leg.pickupAt)}
                {leg.tripId === tripId ? <span className="ml-2 text-xs font-normal">(this ride)</span> : null}
              </p>
              <p className="text-sm text-slate-700 dark:text-slate-200">{leg.from} → {leg.to}</p>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {statusLabel(leg.status as TripStatus)}{leg.volunteerName ? ` · ${leg.volunteerName}` : ''}
              </p>
              {leg.tripId !== tripId ? (
                <Link to={`/trips/${leg.tripId}`} className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium text-[#C80023] underline-offset-2 hover:underline dark:text-red-400">
                  Open {leg.reference}
                </Link>
              ) : null}
            </li>
          ))}
        </ol>
        {j.passengers.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Who is riding</h3>
            <ul className="mt-1 text-sm text-slate-700 dark:text-slate-200">
              {j.passengers.map((p, i) => (
                <li key={i}>{p.name} · {p.seats} {p.seats === 1 ? 'seat' : 'seats'}{p.mobilityNeeds.length ? ` · ${p.mobilityNeeds.join(', ')}` : ''}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {j.awaitingReturnCall ? (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/50 dark:bg-amber-500/10">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Waiting for their call for the ride home{j.returnExpectedAt ? ` (expected around ${formatDateTime(j.returnExpectedAt)})` : ''}.
            </p>
            <button type="button" className={`${primaryButtonClass} mt-2`} disabled={ready.isPending} onClick={() => ready.mutate(j.id)}>
              <PhoneCall className="h-4 w-4" aria-hidden="true" />
              {ready.isPending ? 'Creating…' : 'They called: create the ride home now'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

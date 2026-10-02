/**
 * Board: people whose ride home is waiting for their call (journeys feature).
 * Nothing is booked for them yet, so without this list they would be easy to
 * forget. One tap creates the ride home.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PhoneCall } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { invalidateTrips } from '@/lib/query';
import { formatDateTime } from '@/lib/format';

interface Waiting { journeyId: string; expectedAt: string | null; lastTripId: string; reference: string; callerName: string | null }

export function AwaitingReturnStrip(): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['journeys', 'awaiting-return'],
    queryFn: () => api.get<{ journeys: Waiting[] }>('/api/journeys/awaiting-return'),
    refetchInterval: 60_000,
  });
  const ready = useMutation({
    mutationFn: (journeyId: string) => api.post<{ tripId: string }>(`/api/journeys/${journeyId}/return-ready`, {}),
    onSuccess: () => {
      toast.success('Ride home created.');
      invalidateTrips(queryClient);
      void q.refetch();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });
  const rows = q.data?.journeys ?? [];
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="awaiting-return-heading" className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/50 dark:bg-amber-500/10">
      <h2 id="awaiting-return-heading" className="text-sm font-semibold text-amber-900 dark:text-amber-100">
        Waiting for a call for the ride home ({rows.length})
      </h2>
      <ul className="mt-2 space-y-2">
        {rows.map((r) => (
          <li key={r.journeyId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-amber-900 dark:text-amber-100">
              <Link to={`/trips/${r.lastTripId}`} className="font-medium underline underline-offset-2">{r.callerName ?? r.reference}</Link>
              {r.expectedAt ? ` · expected around ${formatDateTime(r.expectedAt)}` : ''}
            </span>
            <button
              type="button"
              disabled={ready.isPending}
              onClick={() => ready.mutate(r.journeyId)}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-amber-800 px-3 text-sm font-semibold text-white hover:bg-amber-900"
            >
              <PhoneCall className="h-4 w-4" aria-hidden="true" /> They called
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

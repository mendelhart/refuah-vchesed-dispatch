/**
 * Accept straight from the link in an SMS or push notification: /o/<code>.
 *
 * The whole point is that a volunteer taps once, from a lock screen, and is
 * done. This screen therefore fires the accept itself on mount rather than
 * asking for a second confirmation tap.
 *
 * If they are not signed in, <RequireAuth> sends them to /login carrying this
 * path, and they land back here the moment they are in.
 */
import React, { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, XCircle } from 'lucide-react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { invalidateTrips } from '@/lib/query';
import { FullPageSpinner } from '@/lib/auth';
import { primaryButtonClass, secondaryButtonClass } from '@/components/states';
import type { AcceptOfferResponse } from '@/types/api';

export function AcceptFromLinkPage(): React.JSX.Element {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fired = useRef(false);

  const accept = useMutation({
    mutationFn: () => api.post<AcceptOfferResponse>('/api/offers/accept', { code }),
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.isConflict) return; // shown in place below
      toast.error(errorMessage(error));
    },
    onSuccess: (data) => {
      invalidateTrips(queryClient, data.tripId);
      toast.success(`Ride ${data.reference} is yours.`);
      navigate(`/trips/${data.tripId}`, { replace: true });
    },
  });

  useEffect(() => {
    if (fired.current || !code) return;
    fired.current = true;
    accept.mutate();
  }, [code, accept]);

  if (accept.isPending || accept.isIdle) return <FullPageSpinner label="Accepting this ride" />;

  if (accept.isError) {
    const conflict = accept.error instanceof ApiError && accept.error.isConflict;
    return (
      <div className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-700 dark:bg-slate-900">
        <XCircle className="mx-auto h-10 w-10 text-[#C80023] dark:text-red-400" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold text-slate-900 dark:text-white">
          {conflict ? 'Another volunteer accepted this first' : 'We could not accept this ride'}
        </h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {conflict
            ? 'Nothing went wrong on your side — the ride is covered. Thank you for answering.'
            : errorMessage(accept.error)}
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link to="/my-trips" className={primaryButtonClass}>
            See open offers
          </Link>
          {conflict ? null : (
            <button type="button" className={secondaryButtonClass} onClick={() => accept.mutate()}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-700 dark:bg-slate-900">
      <CheckCircle2 className="mx-auto h-10 w-10 text-green-600" aria-hidden="true" />
      <h1 className="mt-3 text-lg font-semibold text-slate-900 dark:text-white">This ride is yours</h1>
      <Link to="/my-trips" className={`${primaryButtonClass} mt-4`}>
        Open the details
      </Link>
    </div>
  );
}

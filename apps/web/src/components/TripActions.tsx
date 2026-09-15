/**
 * The dispatcher's action row for one trip.
 *
 * Which buttons appear is decided by `trip.availableTransitions`, which the
 * server computes from the state machine. This component contains no rule
 * about what may follow what.
 */
import React, { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, PhoneCall, Send, Undo2, UserCheck, UserCog, XCircle } from 'lucide-react';
import type { TripDto } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import {
  useAssignTrip, useCancelTrip, useCompleteTrip, useOfferTrip, useReassignTrip, useReturnToPending,
} from '@/lib/trip-actions';
import { Modal } from './Modal';
import { InlineSpinner, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from './states';
import type { EligibleVolunteersResponse, StartCallResponse } from '@/types/api';

type Dialog = 'assign' | 'reassign' | 'cancel' | 'return' | null;

const actionButtonClass =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

export function TripActions({ trip }: { trip: TripDto }): React.JSX.Element {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState('');
  const [volunteerId, setVolunteerId] = useState('');

  const offerTrip = useOfferTrip();
  const assignTrip = useAssignTrip();
  const reassignTrip = useReassignTrip();
  const cancelTrip = useCancelTrip();
  const returnToPending = useReturnToPending();
  const completeTrip = useCompleteTrip();

  /** Masked calling: neither party ever learns the other's real number. */
  const placeCall = useMutation({
    mutationFn: (counterparty: 'caller' | 'volunteer') =>
      api.post<StartCallResponse>('/api/calls', { tripId: trip.id, counterparty }),
    onSuccess: (data) => toast.success(data.message),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const volunteers = useQuery({
    queryKey: qk.trips.eligibleVolunteers(trip.id),
    queryFn: () => api.get<EligibleVolunteersResponse>(`/api/trips/${trip.id}/eligible-volunteers`),
    enabled: dialog === 'assign' || dialog === 'reassign',
  });

  const can = (transition: string): boolean => trip.availableTransitions.includes(transition as never);
  const closeDialog = (): void => {
    setDialog(null);
    setReason('');
    setVolunteerId('');
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {can('offer') ? (
          <button
            type="button"
            className={primaryButtonClass}
            disabled={offerTrip.isPending}
            onClick={() => offerTrip.mutate({ tripId: trip.id })}
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            {trip.status === 'offered' ? 'Offer again' : 'Offer to group'}
          </button>
        ) : null}

        {can('assign') ? (
          <button type="button" className={actionButtonClass} onClick={() => setDialog('assign')}>
            <UserCheck className="h-4 w-4" aria-hidden="true" />
            Assign
          </button>
        ) : null}

        {can('reassign') ? (
          <button type="button" className={actionButtonClass} onClick={() => setDialog('reassign')}>
            <UserCog className="h-4 w-4" aria-hidden="true" />
            Reassign
          </button>
        ) : null}

        {can('return_to_pending') ? (
          <button type="button" className={actionButtonClass} onClick={() => setDialog('return')}>
            <Undo2 className="h-4 w-4" aria-hidden="true" />
            Back to queue
          </button>
        ) : null}

        {can('complete') ? (
          <button
            type="button"
            className={actionButtonClass}
            disabled={completeTrip.isPending}
            onClick={() => completeTrip.mutate({ tripId: trip.id })}
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Complete
          </button>
        ) : null}

        {trip.callerPhone ? (
          <button
            type="button"
            className={actionButtonClass}
            disabled={placeCall.isPending}
            onClick={() => placeCall.mutate('caller')}
          >
            <PhoneCall className="h-4 w-4" aria-hidden="true" />
            Call caller
          </button>
        ) : null}

        {trip.assignedVolunteer ? (
          <button
            type="button"
            className={actionButtonClass}
            disabled={placeCall.isPending}
            onClick={() => placeCall.mutate('volunteer')}
          >
            <PhoneCall className="h-4 w-4" aria-hidden="true" />
            Call volunteer
          </button>
        ) : null}

        {can('cancel') ? (
          <button
            type="button"
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-3 text-sm font-medium text-[#E31E24] hover:bg-red-50 dark:border-red-900 dark:bg-slate-900 dark:hover:bg-red-950/40"
            onClick={() => setDialog('cancel')}
          >
            <XCircle className="h-4 w-4" aria-hidden="true" />
            Cancel
          </button>
        ) : null}
      </div>

      <Modal
        open={dialog === 'assign' || dialog === 'reassign'}
        title={dialog === 'reassign' ? 'Move this ride to another volunteer' : 'Assign a volunteer'}
        onClose={closeDialog}
      >
        {volunteers.isPending ? (
          <InlineSpinner label="Loading volunteers" />
        ) : volunteers.isError ? (
          <div className="text-sm text-[#E31E24]">
            We could not load the volunteer list.
            <button type="button" className="ml-2 underline" onClick={() => void volunteers.refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!volunteerId) return;
              if (dialog === 'reassign') {
                reassignTrip.mutate({ tripId: trip.id, volunteerId, reason }, { onSuccess: closeDialog });
              } else {
                assignTrip.mutate(
                  { tripId: trip.id, volunteerId, ...(reason ? { reason } : {}) },
                  { onSuccess: closeDialog },
                );
              }
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="assign-volunteer" className={labelClass}>
                Volunteer
              </label>
              <select
                id="assign-volunteer"
                className={inputClass}
                value={volunteerId}
                required
                onChange={(event) => setVolunteerId(event.target.value)}
              >
                <option value="">Choose a volunteer…</option>
                {(volunteers.data?.volunteers ?? []).map((volunteer) => (
                  <option key={volunteer.id} value={volunteer.id}>
                    {volunteer.fullName}
                  </option>
                ))}
              </select>
              {(volunteers.data?.volunteers.length ?? 0) === 0 ? (
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  Nobody in this trip&apos;s group is active right now.
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="assign-reason" className={labelClass}>
                Reason {dialog === 'reassign' ? <span aria-hidden="true">*</span> : '(optional)'}
              </label>
              <input
                id="assign-reason"
                className={inputClass}
                value={reason}
                required={dialog === 'reassign'}
                placeholder="So the record makes sense later"
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <button type="submit" className={primaryButtonClass} disabled={assignTrip.isPending || reassignTrip.isPending}>
                {dialog === 'reassign' ? 'Reassign' : 'Assign'}
              </button>
              <button type="button" className={secondaryButtonClass} onClick={closeDialog}>
                Never mind
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={dialog === 'cancel' || dialog === 'return'}
        title={dialog === 'cancel' ? 'Cancel this ride' : 'Return this ride to the queue'}
        onClose={closeDialog}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const mutation = dialog === 'cancel' ? cancelTrip : returnToPending;
            mutation.mutate({ tripId: trip.id, reason }, { onSuccess: closeDialog });
          }}
          className="space-y-4"
        >
          <div>
            <label htmlFor="trip-reason" className={labelClass}>
              Reason <span aria-hidden="true">*</span>
            </label>
            <textarea
              id="trip-reason"
              className={`${inputClass} min-h-[96px] py-2`}
              value={reason}
              required
              onChange={(event) => setReason(event.target.value)}
              placeholder={dialog === 'cancel' ? 'Caller cancelled, appointment moved, …' : 'Volunteer dropped out, needs a different driver, …'}
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={cancelTrip.isPending || returnToPending.isPending}>
              {dialog === 'cancel' ? 'Cancel the ride' : 'Return to queue'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={closeDialog}>
              Never mind
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

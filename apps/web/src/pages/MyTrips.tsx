/**
 * The volunteer's home screen.
 *
 * Two lists. Offers they could take, and rides that are already theirs.
 *
 * An accepted ride shows the WHOLE job on the card — exact pickup with unit,
 * dropoff with its entrance/parking notes, appointment time, who to call and
 * their number, mobility needs, passenger notes. A volunteer standing in a
 * hospital garage with one bar of signal should never have to text dispatch to
 * ask something that was known when the trip was created.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Car, CheckCircle2, Clock, Flag, MapPin, Navigation, Phone, PlayCircle, User, XCircle,
} from 'lucide-react';
import type { OfferedTripDto, TripDto } from '@rvc/shared';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import {
  formatDateTime, mobilityLabel, priorityClass, priorityLabel, relativeTime, statusClass, statusLabel, telHref,
  tripTypeLabel, formatPhone } from '@/lib/format';
import { isFullTrip, type TripListResponse } from '@/types/api';
import { useCancelTrip, useClaimTrip, useCompleteTrip, useStartEnRoute, useStartTrip } from '@/lib/trip-actions';
import { OfferCountdown } from '@/components/Countdown';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';

function OfferCard({ trip }: { trip: OfferedTripDto }): React.JSX.Element {
  const claim = useClaimTrip();

  return (
    <article className={`${cardClass} border-l-4 border-l-green-500`}>
      <div className="p-5 md:p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-slate-900 dark:text-white md:text-lg">
            {tripTypeLabel(trip.tripType)}
          </h3>
          <span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {trip.reference}
          </span>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${priorityClass(trip.priority)}`}>
            {priorityLabel(trip.priority)}
          </span>
          {trip.offer ? <OfferCountdown expiresAt={trip.offer.expiresAt} /> : null}
        </div>

        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>
              <span className="block font-medium text-slate-800 dark:text-slate-100">From {trip.pickupArea}</span>
              <span className="block">To {trip.dropoffArea}</span>
            </span>
          </p>
          <p className="flex flex-wrap items-center gap-2">
            <Clock className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            {formatDateTime(trip.pickupAt)}
            <span className="text-slate-400 dark:text-slate-500">({relativeTime(trip.pickupAt)})</span>
          </p>
          {trip.mobilityNeeds.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {trip.mobilityNeeds.map((need) => (
                <span
                  key={need}
                  className="rounded bg-purple-100 px-2 py-1 text-xs text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
                >
                  {mobilityLabel(need)}
                </span>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-slate-400 dark:text-slate-500">
            The exact address and the caller&apos;s number appear as soon as you accept.
          </p>
        </div>

        <button
          type="button"
          className="mt-4 flex min-h-[56px] w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-6 text-base font-bold text-white transition-colors hover:bg-green-700 disabled:opacity-60"
          disabled={claim.isPending}
          onClick={() => claim.mutate({ tripId: trip.id })}
        >
          <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
          {claim.isPending ? 'Accepting…' : 'Accept this ride'}
        </button>
      </div>
    </article>
  );
}

function AssignedTripCard({ trip }: { trip: TripDto }): React.JSX.Element {
  const enRoute = useStartEnRoute();
  const start = useStartTrip();
  const complete = useCompleteTrip();
  const cancel = useCancelTrip();
  const can = (transition: string): boolean => trip.availableTransitions.includes(transition as never);

  const mapsHref = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    `${trip.pickup.line1}, ${trip.pickup.city}, ${trip.pickup.province}`,
  )}`;

  return (
    <article className={`${cardClass} border-l-4 border-l-[#E31E24]`}>
      <div className="p-5 md:p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-slate-900 dark:text-white md:text-lg">
            {trip.callerName ?? tripTypeLabel(trip.tripType)}
          </h3>
          <span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {trip.reference}
          </span>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusClass(trip.status)}`}>
            {statusLabel(trip.status)}
          </span>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${priorityClass(trip.priority)}`}>
            {priorityLabel(trip.priority)}
          </span>
        </div>

        <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
          <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900 dark:text-white">
            <Clock className="h-4 w-4" aria-hidden="true" />
            {formatDateTime(trip.pickupAt)}
            <span className="text-sm font-normal text-slate-500 dark:text-slate-400">({relativeTime(trip.pickupAt)})</span>
          </p>

          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
            <p className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#E31E24]" aria-hidden="true" />
              <span>
                <span className="block text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Pick up</span>
                <span className="block font-medium">
                  {trip.pickup.line1}
                  {trip.pickup.unit ? `, unit ${trip.pickup.unit}` : ''}
                </span>
                <span className="block text-slate-500 dark:text-slate-400">
                  {trip.pickup.city}, {trip.pickup.province} {trip.pickup.postalCode ?? ''}
                </span>
                {trip.pickup.notes ? (
                  <span className="mt-1 block rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                    {trip.pickup.notes}
                  </span>
                ) : null}
              </span>
            </p>
            <p className="mt-3 flex items-start gap-2">
              <Navigation className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#E31E24]" aria-hidden="true" />
              <span>
                <span className="block text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Drop off</span>
                <span className="block font-medium">
                  {trip.dropoff.line1}
                  {trip.dropoff.unit ? `, unit ${trip.dropoff.unit}` : ''}
                </span>
                <span className="block text-slate-500 dark:text-slate-400">
                  {trip.dropoff.city}, {trip.dropoff.province} {trip.dropoff.postalCode ?? ''}
                </span>
                {trip.dropoff.notes ? (
                  <span className="mt-1 block rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                    {trip.dropoff.notes}
                  </span>
                ) : null}
              </span>
            </p>
          </div>

          {trip.callerName || trip.callerPhone ? (
            <p className="flex flex-wrap items-center gap-2">
              <User className="h-4 w-4" aria-hidden="true" />
              <span className="font-medium">{trip.callerName ?? 'Passenger'}</span>
              {trip.callerPhone ? (
                <a
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-[#E31E24] dark:border-slate-600"
                  href={telHref(trip.callerPhone)}
                >
                  <Phone className="h-4 w-4" aria-hidden="true" />
                  {formatPhone(trip.callerPhone)}
                </a>
              ) : null}
            </p>
          ) : null}

          {trip.mobilityNeeds.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {trip.mobilityNeeds.map((need) => (
                <span
                  key={need}
                  className="rounded bg-purple-100 px-2 py-1 text-xs text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
                >
                  {mobilityLabel(need)}
                </span>
              ))}
            </div>
          ) : null}

          {trip.passengerNotes ? (
            <p className="whitespace-pre-wrap rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
              {trip.passengerNotes}
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          {can('start_en_route') ? (
            <button
              type="button"
              className={primaryButtonClass}
              disabled={enRoute.isPending}
              onClick={() => enRoute.mutate({ tripId: trip.id })}
            >
              <Car className="h-4 w-4" aria-hidden="true" />
              I&apos;m on my way
            </button>
          ) : null}
          {can('start_trip') ? (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={start.isPending}
              onClick={() => start.mutate({ tripId: trip.id })}
            >
              <PlayCircle className="h-4 w-4" aria-hidden="true" />
              Passenger aboard
            </button>
          ) : null}
          {can('complete') ? (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={complete.isPending}
              onClick={() => complete.mutate({ tripId: trip.id })}
            >
              <Flag className="h-4 w-4" aria-hidden="true" />
              Finished
            </button>
          ) : null}
          {can('cancel') ? (
            <button
              type="button"
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-red-300 px-3 text-sm font-medium text-[#E31E24] hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40"
              disabled={cancel.isPending}
              onClick={() => {
                const reason = window.prompt('Let dispatch know why you cannot take this ride:');
                if (reason) cancel.mutate({ tripId: trip.id, reason });
              }}
            >
              <XCircle className="h-4 w-4" aria-hidden="true" />
              I can&apos;t do this one
            </button>
          ) : null}
          <a
            className={secondaryButtonClass}
            href={mapsHref}
            target="_blank"
            rel="noreferrer"
          >
            <Navigation className="h-4 w-4" aria-hidden="true" />
            Directions
          </a>
          <Link to={`/trips/${trip.id}`} className="inline-flex min-h-[44px] items-center px-3 text-sm font-medium text-[#E31E24]">
            Details
          </Link>
        </div>
      </div>
    </article>
  );
}

export function MyTripsPage(): React.JSX.Element {
  const available = useQuery({
    queryKey: qk.trips.list({ scope: 'available', limit: 50 }),
    queryFn: () => api.get<TripListResponse>('/api/trips', { scope: 'available', limit: 50 }),
  });
  const mine = useQuery({
    queryKey: qk.trips.list({ scope: 'mine', limit: 50 }),
    queryFn: () => api.get<TripListResponse>('/api/trips', { scope: 'mine', limit: 50 }),
  });

  const offers = (available.data?.items ?? []).filter((trip): trip is OfferedTripDto => !isFullTrip(trip));
  const mineFull = (mine.data?.items ?? []).filter(isFullTrip);
  const activeMine = mineFull.filter((trip) => !['completed', 'cancelled'].includes(trip.status));
  const doneMine = mineFull.filter((trip) => ['completed', 'cancelled'].includes(trip.status));

  return (
    <div className="space-y-8">
      <PageHeader title="My rides" subtitle="Offers waiting for an answer, and the rides that are yours" />

      <section aria-labelledby="available-heading">
        <h2 id="available-heading" className="mb-3 text-lg font-semibold text-slate-900 dark:text-white">
          Open offers
        </h2>
        {available.isPending ? (
          <ListSkeleton rows={2} lines={3} />
        ) : available.isError ? (
          <ErrorState error={available.error} onRetry={() => void available.refetch()} what="open offers" />
        ) : offers.length === 0 ? (
          <EmptyState
            icon={Car}
            title="No open rides right now — we'll let you know."
            hint="When dispatch sends one out you'll get a message, and it will show up here."
          />
        ) : (
          <div className="space-y-4">
            {offers.map((trip) => (
              <OfferCard key={trip.id} trip={trip} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="mine-heading">
        <h2 id="mine-heading" className="mb-3 text-lg font-semibold text-slate-900 dark:text-white">
          Yours to drive
        </h2>
        {mine.isPending ? (
          <ListSkeleton rows={2} lines={5} />
        ) : mine.isError ? (
          <ErrorState error={mine.error} onRetry={() => void mine.refetch()} what="your rides" />
        ) : activeMine.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="Nothing on your plate right now."
            hint="Rides you accept appear here with everything you need to drive them."
          />
        ) : (
          <div className="space-y-4">
            {activeMine.map((trip) => (
              <AssignedTripCard key={trip.id} trip={trip} />
            ))}
          </div>
        )}
      </section>

      {doneMine.length > 0 ? (
        <section aria-labelledby="done-heading">
          <h2 id="done-heading" className="mb-3 text-lg font-semibold text-slate-900 dark:text-white">
            Recently finished
          </h2>
          <div className="space-y-2">
            {doneMine.map((trip) => (
              <Link
                key={trip.id}
                to={`/trips/${trip.id}`}
                className="flex min-h-[44px] flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <span className="font-medium text-slate-800 dark:text-slate-100">{trip.callerName ?? tripTypeLabel(trip.tripType)}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${statusClass(trip.status)}`}>{statusLabel(trip.status)}</span>
                <span className="text-slate-500 dark:text-slate-400">{formatDateTime(trip.pickupAt)}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

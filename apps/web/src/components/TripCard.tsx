/**
 * Dispatcher trip card.
 *
 * The visual language is the original app's card — name, reference chip, status
 * pill, pickup → dropoff with a map pin, clock line, mobility chips — plus the
 * four things the old card could not tell you: how urgent the trip is, whether
 * it is overdue, how long an outstanding offer has left, and whether anyone has
 * answered it.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { AlertOctagon, BellRing, CalendarClock, Clock, MapPin, Phone, Repeat, User, Users } from 'lucide-react';
import type { TripDto } from '@rvc/shared';
import {
  formatDateTime, mobilityLabel, priorityClass, priorityLabel, relativeTime, statusClass, statusLabel, telHref,
  tripTypeLabel, formatPhone } from '@/lib/format';
import { OfferCountdown } from './Countdown';
import { TripActions } from './TripActions';
import { cardClass } from './states';

/**
 * `compact` is the phone board: tighter padding, the name opens the ride, the
 * reference and a routine priority drop out, and secondary actions fold behind
 * "More" so three rides fit a screen instead of one and a half.
 */
export function TripCard({ trip, compact = false }: { trip: TripDto; compact?: boolean }): React.JSX.Element {
  const unansweredOffer = trip.status === 'offered' && trip.openOfferCount > 0 && !trip.assignedVolunteer;
  // An appointment that matches the pickup adds a line and says nothing; only a
  // time that differs is worth the row.
  const showAppointment =
    Boolean(trip.appointmentAt) && new Date(trip.appointmentAt ?? '').getTime() !== new Date(trip.pickupAt).getTime();

  return (
    <article
      className={`${cardClass} border-l-4 ${
        trip.isOverdue
          ? 'border-l-[#EA0029]'
          : trip.priority === 'emergency'
            ? 'border-l-[#EA0029]'
            : trip.priority === 'urgent'
              ? 'border-l-amber-500'
              : 'border-l-slate-300 dark:border-l-slate-600'
      }`}
    >
      <div className={compact ? 'p-4' : 'p-5 md:p-6'}>
        <div className={`${compact ? 'mb-2' : 'mb-3'} flex flex-wrap items-center gap-2`}>
          <h3 className="min-w-0 break-words text-base font-semibold text-slate-900 dark:text-white md:text-lg">
            {compact ? (
              <Link to={`/trips/${trip.id}`} className="underline-offset-2 hover:underline">
                {trip.callerName ?? tripTypeLabel(trip.tripType)}
              </Link>
            ) : (
              (trip.callerName ?? tripTypeLabel(trip.tripType))
            )}
          </h3>
          {compact ? null : (
            <span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {trip.reference}
            </span>
          )}
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusClass(trip.status)}`}>
            {statusLabel(trip.status)}
          </span>
          {compact && trip.priority === 'routine' ? null : (
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${priorityClass(trip.priority)}`}>
              {priorityLabel(trip.priority)}
            </span>
          )}
          {trip.isOverdue ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#EA0029] px-3 py-1 text-xs font-semibold text-white">
              <AlertOctagon className="h-3 w-3" aria-hidden="true" />
              Overdue
            </span>
          ) : null}
          {trip.status === 'offered' ? <OfferCountdown expiresAt={trip.offerExpiresAt} /> : null}
        </div>

        <div className={`${compact ? 'space-y-1.5' : 'space-y-2'} text-sm text-slate-600 dark:text-slate-300`}>
          {trip.callerPhone ? (
            <p className="flex items-center gap-2">
              <Phone className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <a className="underline-offset-2 hover:underline" href={telHref(trip.callerPhone)}>
                {formatPhone(trip.callerPhone)}
              </a>
            </p>
          ) : null}

          <div className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p className="break-words font-medium text-slate-800 dark:text-slate-100">
                {trip.pickup.line1}
                {trip.pickup.unit ? `, unit ${trip.pickup.unit}` : ''}
              </p>
              <p className="break-words text-slate-500 dark:text-slate-400">→ {trip.dropoff.line1}</p>
            </div>
          </div>

          <p className="flex flex-wrap items-center gap-2">
            <Clock className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span>{formatDateTime(trip.pickupAt)}</span>
            <span className="text-slate-400 dark:text-slate-500">({relativeTime(trip.pickupAt)})</span>
          </p>

          {showAppointment ? (
            <p className="flex flex-wrap items-center gap-2">
              <CalendarClock className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span>Appointment {formatDateTime(trip.appointmentAt)}</span>
            </p>
          ) : null}

          {trip.assignedVolunteer ? (
            <p className="flex items-center gap-2">
              <User className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              <span className="font-medium text-slate-800 dark:text-slate-100">{trip.assignedVolunteer.fullName}</span>
              {trip.assignedVolunteer.phone ? (
                <a className="text-slate-500 underline-offset-2 hover:underline dark:text-slate-400" href={telHref(trip.assignedVolunteer.phone)}>
                  {formatPhone(trip.assignedVolunteer.phone)}
                </a>
              ) : null}
            </p>
          ) : null}

          {unansweredOffer ? (
            <p className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <Users className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              Offered to {trip.openOfferCount} {trip.openOfferCount === 1 ? 'volunteer' : 'volunteers'} — nobody has
              answered yet
              {trip.interestedCount > 0 ? ` (${trip.interestedCount} interested)` : ''}
            </p>
          ) : null}

          {trip.escalatedAt ? (
            <p className="flex flex-wrap items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
              <BellRing className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              No answer yet — now on round {trip.offerRound}
              <span className="font-normal text-slate-500 dark:text-slate-400">
                (widened {trip.escalationCount} {trip.escalationCount === 1 ? 'time' : 'times'},{' '}
                {relativeTime(trip.escalatedAt)})
              </span>
            </p>
          ) : null}

          {trip.status === 'expired' ? (
            <p className="flex items-center gap-2 font-medium text-[#EA0029]">
              <AlertOctagon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
              The offer window closed with no answer — this one needs you.
            </p>
          ) : null}

          {trip.mobilityNeeds.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1">
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

          <p className={`${compact ? 'hidden' : 'flex'} flex-wrap items-center gap-2 pt-1 text-xs text-slate-400 dark:text-slate-500`}>
            <span>
              {trip.group.name} · {tripTypeLabel(trip.tripType)}
              {trip.assignmentMode === 'admin_approval' ? ' · needs dispatcher approval' : ''}
            </span>
            {trip.recurringRideId ? (
              <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <Repeat className="h-3 w-3" aria-hidden="true" />
                Standing ride
              </span>
            ) : null}
          </p>
        </div>

        {compact ? (
          <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            <TripActions
              trip={trip}
              compact
              extra={
                <Link
                  to={`/trips/${trip.id}`}
                  className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-[#EA0029] hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  Open details
                </Link>
              }
            />
          </div>
        ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
          <TripActions trip={trip} />
          <Link
            to={`/trips/${trip.id}`}
            className="inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-medium text-[#EA0029] hover:bg-red-50 dark:hover:bg-red-950/30"
          >
            Open details
          </Link>
        </div>
        )}
      </div>
    </article>
  );
}

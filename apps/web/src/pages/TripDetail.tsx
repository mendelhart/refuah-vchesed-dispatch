/**
 * One trip, in full, plus its history.
 *
 * The timeline merges three sources the API returns together — audit events,
 * offers and assignments — into one chronological list, because "what actually
 * happened to this ride" is the question people ask after an incident and it
 * should not require reading three tables.
 */
import React, { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, CalendarClock, CheckCircle2, Clock, Copy, DoorOpen, FileText, MapPin, MessageSquare, Navigation, Phone,
  PhoneCall, Repeat, Send, SquareParking, User, UserCheck, UserPlus } from 'lucide-react';
import { TRIP_PRIORITIES, type TripPriority } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { saveCallerFromTrip } from '@/lib/save-caller';
import { qk } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { markInstallEligible } from '@/lib/install-prompt';
import { useCompleteTrip } from '@/lib/trip-actions';
import {
  formatDateTime, mobilityLabel, priorityClass, priorityLabel, relativeTime, statusClass, statusLabel, telHref,
  titleCase, tripTypeLabel, formatPhone } from '@/lib/format';
import { isFullTrip, type TripHistoryResponse, type TripResponse } from '@/types/api';
import { TripActions } from '@/components/TripActions';
import { TripForm } from '@/components/TripForm';
import { OfferCountdown } from '@/components/Countdown';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, ListSkeleton, cardClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';

interface TimelineEntry {
  id: string;
  at: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail?: string;
  actor?: string;
}

/** Only the thread fields this page reads; the console owns the rest. */
interface ConversationThreadRow {
  id: string;
  displayName: string | null;
  phone: string;
  preview: string | null;
  lastMessageAt: string;
  unreadCount: number;
  tripId: string | null;
}
interface ConversationListResponse {
  threads: ConversationThreadRow[];
  unread: number;
}

/** `datetime-local` wants local wall-clock time, not an ISO-Z string. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * Same wall-clock time, seven days on.
 *
 * Adding 7×86 400 000 ms would move a ride by an hour across a DST boundary,
 * which is exactly the week somebody would not notice.
 */
function oneWeekLater(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + 7);
  return toLocalInput(date.toISOString());
}

/** Entrance and parking, against the address they belong to. A volunteer who
 *  cannot find the door rings the dispatcher from the car park; that call is
 *  what these two lines exist to prevent, so they are not a footnote. */
function AccessLines({ entrance, parking }: { entrance: string | null; parking: string | null }): React.JSX.Element | null {
  if (!entrance && !parking) return null;
  return (
    <span className="mt-2 block space-y-1 rounded-lg bg-slate-100 px-3 py-2 dark:bg-slate-800">
      {entrance ? (
        <span className="flex items-start gap-2 text-sm font-medium text-slate-900 dark:text-white">
          <DoorOpen className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          {entrance}
        </span>
      ) : null}
      {parking ? (
        <span className="flex items-start gap-2 text-sm font-medium text-slate-900 dark:text-white">
          <SquareParking className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          {parking}
        </span>
      ) : null}
    </span>
  );
}

export function TripDetailPage(): React.JSX.Element {

  const saveCaller = useMutation({
    mutationFn: async () => {
      if (!isFullTrip(trip)) throw new Error('Only a full trip can be saved.');
      await saveCallerFromTrip(trip);
    },
    onSuccess: () => toast.success('Caller saved to the directory. Future trips will find them by phone.'),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });
  const { id = '' } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [duplicatePickupAt, setDuplicatePickupAt] = useState('');
  const [duplicatePriority, setDuplicatePriority] = useState<TripPriority>('routine');
  const [duplicateNotes, setDuplicateNotes] = useState('');
  const isDispatch = user?.role === 'dispatcher' || user?.role === 'admin';

  const tripQuery = useQuery({
    queryKey: qk.trips.detail(id),
    queryFn: () => api.get<TripResponse>(`/api/trips/${id}`),
    enabled: Boolean(id),
  });

  // Threads carry a tripId but the console has no per-trip endpoint, so the
  // open list is fetched once and filtered here. `retry: false` because this is
  // a side panel: if it does not load, the ride still has to be readable.
  const conversationsQuery = useQuery({
    queryKey: qk.conversations.list({ status: 'all' }),
    queryFn: () => api.get<ConversationListResponse>('/api/conversations', { status: 'all', limit: 100 }),
    enabled: Boolean(id) && isDispatch,
    retry: false,
  });

  const completeTrip = useCompleteTrip();

  const duplicate = useMutation({
    mutationFn: () =>
      api.post<TripResponse>(`/api/trips/${id}/duplicate`, {
        ...(duplicatePickupAt ? { pickupAt: new Date(duplicatePickupAt).toISOString() } : {}),
        priority: duplicatePriority,
        ...(duplicateNotes.trim() ? { passengerNotes: duplicateNotes.trim() } : {}),
      }),
    onSuccess: (data) => {
      toast.success('Copy created.');
      setDuplicating(false);
      if ('id' in data.trip) navigate(`/trips/${data.trip.id}`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  // History is a dispatcher endpoint; volunteers simply do not see the section.
  const historyQuery = useQuery({
    queryKey: qk.trips.history(id),
    queryFn: () => api.get<TripHistoryResponse>(`/api/trips/${id}/history`),
    enabled: Boolean(id) && isDispatch,
  });

  const timeline = useMemo<TimelineEntry[]>(() => {
    const history = historyQuery.data?.events;
    if (!history) return [];
    const entries: TimelineEntry[] = [
      ...history.events.map((event) => ({
        id: `event-${event.id}`,
        at: event.occurredAt,
        icon: FileText,
        title: titleCase(event.action.replace(/^trip\./, '')),
        actor: `${event.actorName} (${event.actorRole})`,
      })),
      ...history.offers.map((offer) => ({
        id: `offer-${offer.id}`,
        at: offer.offeredAt,
        icon: Send,
        title: `Offered to ${offer.volunteerName}`,
        detail:
          offer.status === 'accepted'
            ? `Accepted ${offer.respondedAt ? formatDateTime(offer.respondedAt) : ''}${offer.responseChannel ? ` by ${offer.responseChannel}` : ''}`
            : `Round ${offer.round} · ${titleCase(offer.status)}`,
      })),
      ...history.assignments.map((assignment) => ({
        id: `assignment-${assignment.id}`,
        at: assignment.assignedAt,
        icon: UserCheck,
        title: `Assigned to ${assignment.volunteerName}`,
        detail: assignment.unassignedAt
          ? `Removed ${formatDateTime(assignment.unassignedAt)}${assignment.unassignedReason ? ` — ${assignment.unassignedReason}` : ''}`
          : `Source: ${titleCase(assignment.source)}`,
      })),
    ];
    return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }, [historyQuery.data]);

  if (tripQuery.isPending) return <ListSkeleton rows={2} lines={5} />;
  if (tripQuery.isError) {
    return <ErrorState error={tripQuery.error} onRetry={() => void tripQuery.refetch()} what="this trip" />;
  }

  const trip = tripQuery.data.trip;
  const full = isFullTrip(trip) ? trip : null;
  const tripThreads = (conversationsQuery.data?.threads ?? []).filter((thread) => thread.tripId === trip.id);
  // An appointment equal to the pickup adds a row that says nothing.
  const showAppointment =
    Boolean(trip.appointmentAt) && new Date(trip.appointmentAt ?? '').getTime() !== new Date(trip.pickupAt).getTime();
  const isAssignedVolunteer = Boolean(full?.assignedVolunteer && full.assignedVolunteer.id === user?.id);
  const canComplete = trip.status !== 'completed' && (full?.availableTransitions.includes('complete') ?? false);

  const openDuplicate = (): void => {
    setDuplicatePickupAt(oneWeekLater(trip.pickupAt));
    setDuplicatePriority(trip.priority);
    setDuplicateNotes(full?.passengerNotes ?? '');
    setDuplicating(true);
  };

  return (
    <div className="space-y-6">
      <Link to={isDispatch ? '/board' : '/my-trips'} className="inline-flex items-center gap-2 text-sm text-slate-600 hover:underline dark:text-slate-400">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back
      </Link>

      <div className={cardClass}>
        <div className="p-5 md:p-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white md:text-2xl">
              {isFullTrip(trip) ? (trip.callerName ?? tripTypeLabel(trip.tripType)) : `Ride ${trip.reference}`}
            </h1>
            <span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {trip.reference}
            </span>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusClass(trip.status)}`}>
              {statusLabel(trip.status)}
            </span>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${priorityClass(trip.priority)}`}>
              {priorityLabel(trip.priority)}
            </span>
            {isFullTrip(trip) && trip.status === 'offered' ? <OfferCountdown expiresAt={trip.offerExpiresAt} /> : null}
          </div>

          {/* Provenance, not state: where this particular ride came from. */}
          {full?.recurringRideId || full?.duplicatedFromTripId ? (
            <div className="mb-4 space-y-1 text-sm text-slate-600 dark:text-slate-400">
              {full.recurringRideId ? (
                <p className="flex flex-wrap items-center gap-2">
                  <Repeat className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  This ride came from a standing ride.
                  <Link to="/recurring" className="font-medium text-[#EA0029] underline-offset-2 hover:underline">
                    See the schedule
                  </Link>
                </p>
              ) : null}
              {full.duplicatedFromTripId ? (
                <p className="flex flex-wrap items-center gap-2">
                  <Copy className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  Copied from an earlier ride.
                  <Link
                    to={`/trips/${full.duplicatedFromTripId}`}
                    className="font-medium text-[#EA0029] underline-offset-2 hover:underline"
                  >
                    Open the original
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}

          {isFullTrip(trip) ? (
            <dl className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
              <div>
                <dt className="font-medium text-slate-500 dark:text-slate-400">Pickup</dt>
                <dd className="mt-1 flex items-start gap-2 text-slate-800 dark:text-slate-100">
                  <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  <span>
                    {trip.pickup.line1}
                    {trip.pickup.unit ? `, unit ${trip.pickup.unit}` : ''}
                    <span className="block text-slate-500 dark:text-slate-400">
                      {trip.pickup.city}, {trip.pickup.province} {trip.pickup.postalCode ?? ''}
                    </span>
                    {trip.pickup.notes ? (
                      <span className="mt-1 block rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                        {trip.pickup.notes}
                      </span>
                    ) : null}
                    <AccessLines entrance={trip.pickupEntrance} parking={trip.pickupParking} />
                  </span>
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500 dark:text-slate-400">Dropoff</dt>
                <dd className="mt-1 flex items-start gap-2 text-slate-800 dark:text-slate-100">
                  <Navigation className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  <span>
                    {trip.dropoff.line1}
                    {trip.dropoff.unit ? `, unit ${trip.dropoff.unit}` : ''}
                    <span className="block text-slate-500 dark:text-slate-400">
                      {trip.dropoff.city}, {trip.dropoff.province} {trip.dropoff.postalCode ?? ''}
                    </span>
                    {trip.dropoff.notes ? (
                      <span className="mt-1 block rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                        {trip.dropoff.notes}
                      </span>
                    ) : null}
                    <AccessLines entrance={trip.dropoffEntrance} parking={trip.dropoffParking} />
                  </span>
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500 dark:text-slate-400">Pickup time</dt>
                <dd className="mt-1 flex items-center gap-2 text-slate-800 dark:text-slate-100">
                  <Clock className="h-4 w-4" aria-hidden="true" />
                  {formatDateTime(trip.pickupAt)}
                </dd>
              </div>
              {showAppointment ? (
                <div>
                  <dt className="font-medium text-slate-500 dark:text-slate-400">Appointment</dt>
                  <dd className="mt-1 flex items-center gap-2 font-medium text-slate-800 dark:text-slate-100">
                    <CalendarClock className="h-4 w-4" aria-hidden="true" />
                    {formatDateTime(trip.appointmentAt)}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="font-medium text-slate-500 dark:text-slate-400">Caller</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 text-slate-800 dark:text-slate-100">
                  <Phone className="h-4 w-4" aria-hidden="true" />
                  {trip.callerName ?? '—'}
                  {trip.callerPhone ? (
                    <a className="text-[#EA0029] underline-offset-2 hover:underline" href={telHref(trip.callerPhone)}>
                      {formatPhone(trip.callerPhone)}
                    </a>
                  ) : null}
                  {isFullTrip(trip) && !trip.callerId && (trip.callerName || trip.callerPhone) ? (
                    <button
                      type="button"
                      className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-slate-300 px-2 text-xs text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                      disabled={saveCaller.isPending}
                      onClick={() => saveCaller.mutate()}
                    >
                      <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                      Save to directory
                    </button>
                  ) : null}
                </dd>
              </div>
              {trip.callbackNumber ? (
                <div>
                  <dt className="font-medium text-slate-500 dark:text-slate-400">Callback number</dt>
                  <dd className="mt-1 flex flex-wrap items-center gap-2 text-slate-800 dark:text-slate-100">
                    <PhoneCall className="h-4 w-4" aria-hidden="true" />
                    <a
                      className="font-medium text-[#EA0029] underline-offset-2 hover:underline"
                      href={telHref(trip.callbackNumber)}
                    >
                      {formatPhone(trip.callbackNumber)}
                    </a>
                    <span className="text-xs text-slate-500 dark:text-slate-400">ring this about the trip</span>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="font-medium text-slate-500 dark:text-slate-400">Volunteer</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2 text-slate-800 dark:text-slate-100">
                  <User className="h-4 w-4" aria-hidden="true" />
                  {trip.assignedVolunteer ? (
                    <>
                      {trip.assignedVolunteer.fullName}
                      {trip.assignedVolunteer.phone ? (
                        <a className="text-[#EA0029] underline-offset-2 hover:underline" href={telHref(trip.assignedVolunteer.phone)}>
                          {formatPhone(trip.assignedVolunteer.phone)}
                        </a>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-slate-500 dark:text-slate-400">Nobody yet</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500 dark:text-slate-400">Group &amp; type</dt>
                <dd className="mt-1 text-slate-800 dark:text-slate-100">
                  {trip.group.name} · {tripTypeLabel(trip.tripType)}
                </dd>
              </div>
              <div className="md:col-span-2">
                <dt className="font-medium text-slate-500 dark:text-slate-400">Mobility needs</dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  {trip.mobilityNeeds.length === 0 ? (
                    <span className="text-slate-500 dark:text-slate-400">None recorded</span>
                  ) : (
                    trip.mobilityNeeds.map((need) => (
                      <span
                        key={need}
                        className="rounded bg-purple-100 px-2 py-1 text-xs text-purple-700 dark:bg-purple-500/15 dark:text-purple-300"
                      >
                        {mobilityLabel(need)}
                      </span>
                    ))
                  )}
                </dd>
              </div>
              {trip.passengerNotes ? (
                <div className="md:col-span-2">
                  <dt className="font-medium text-slate-500 dark:text-slate-400">Passenger notes</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-slate-800 dark:text-slate-100">{trip.passengerNotes}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <div className="space-y-2 text-sm text-slate-700 dark:text-slate-200">
              <p className="flex items-center gap-2">
                <MapPin className="h-4 w-4" aria-hidden="true" />
                {trip.pickupArea} → {trip.dropoffArea}
              </p>
              <p className="flex items-center gap-2">
                <Clock className="h-4 w-4" aria-hidden="true" />
                {formatDateTime(trip.pickupAt)}
              </p>
              {showAppointment ? (
                <p className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4" aria-hidden="true" />
                  Appointment {formatDateTime(trip.appointmentAt)}
                </p>
              ) : null}
              <p className="text-slate-500 dark:text-slate-400">
                Full pickup details and the caller&apos;s number appear once this ride is yours.
              </p>
            </div>
          )}

          {isFullTrip(trip) && isDispatch ? (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
              <TripActions trip={trip} />
              <button type="button" className={secondaryButtonClass} onClick={() => setEditing(true)}>
                Edit details
              </button>
              <button type="button" className={secondaryButtonClass} onClick={openDuplicate}>
                <Copy className="h-4 w-4" aria-hidden="true" />
                Duplicate this ride
              </button>
            </div>
          ) : null}

          {/* The dispatcher toolbar is theirs; this is the assigned volunteer's
              one button, and the moment installing the app starts to mean
              something to them. */}
          {!isDispatch && isAssignedVolunteer && canComplete ? (
            <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
              <button
                type="button"
                className={primaryButtonClass}
                disabled={completeTrip.isPending}
                onClick={() =>
                  completeTrip.mutate(
                    { tripId: trip.id },
                    { onSuccess: () => markInstallEligible() },
                  )
                }
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                {completeTrip.isPending ? 'Saving…' : 'Mark this ride complete'}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {isDispatch && tripThreads.length > 0 ? (
        <section className={cardClass}>
          <div className="p-5 md:p-6">
            <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">Texts about this ride</h2>
            <ul className="space-y-3">
              {tripThreads.map((thread) => (
                <li key={thread.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900 dark:text-white">
                    <MessageSquare className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
                    {thread.displayName ?? thread.phone}
                    {thread.unreadCount > 0 ? (
                      <span className="rounded-full bg-[#EA0029] px-2 py-0.5 text-xs font-semibold text-white">
                        {thread.unreadCount} unread
                      </span>
                    ) : null}
                    <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                      {relativeTime(thread.lastMessageAt)}
                    </span>
                  </p>
                  {thread.preview ? (
                    <p className="mt-1 break-words text-sm text-slate-600 dark:text-slate-300">{thread.preview}</p>
                  ) : null}
                  <Link
                    to="/messages"
                    className="mt-2 inline-flex min-h-[44px] items-center text-sm font-medium text-[#EA0029] underline-offset-2 hover:underline"
                  >
                    Open in messages
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {isDispatch ? (
        <section className={cardClass}>
          <div className="p-5 md:p-6">
            <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-white">History</h2>
            {historyQuery.isPending ? (
              <ListSkeleton rows={1} lines={4} />
            ) : historyQuery.isError ? (
              <ErrorState error={historyQuery.error} onRetry={() => void historyQuery.refetch()} what="this trip's history" />
            ) : timeline.length === 0 ? (
              <EmptyState title="Nothing has happened to this ride yet." hint="Offers, assignments and status changes appear here as they occur." />
            ) : (
              <ol className="space-y-4">
                {timeline.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <li key={entry.id} className="flex gap-3">
                      <span className="mt-0.5 grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 dark:text-white">{entry.title}</p>
                        {entry.detail ? <p className="text-sm text-slate-600 dark:text-slate-400">{entry.detail}</p> : null}
                        <p className="text-xs text-slate-400 dark:text-slate-500">
                          {formatDateTime(entry.at)}
                          {entry.actor ? ` · ${entry.actor}` : ''}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      ) : null}

      {isFullTrip(trip) ? (
        <TripForm open={editing} trip={trip} onClose={() => setEditing(false)} />
      ) : null}

      <Modal open={duplicating} title="Duplicate this ride" onClose={() => setDuplicating(false)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            duplicate.mutate();
          }}
        >
          <p className="text-sm text-slate-600 dark:text-slate-300">
            The copy starts fresh: no volunteer, no offers, nothing from this ride&apos;s history.
          </p>
          <div>
            <label htmlFor="duplicate-pickup" className={labelClass}>
              Pickup time
            </label>
            <input
              id="duplicate-pickup"
              type="datetime-local"
              className={inputClass}
              value={duplicatePickupAt}
              onChange={(event) => setDuplicatePickupAt(event.target.value)}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Same time, one week on.</p>
          </div>
          <div>
            <label htmlFor="duplicate-priority" className={labelClass}>
              Priority
            </label>
            <select
              id="duplicate-priority"
              className={inputClass}
              value={duplicatePriority}
              onChange={(event) => setDuplicatePriority(event.target.value as TripPriority)}
            >
              {TRIP_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {priorityLabel(priority)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="duplicate-notes" className={labelClass}>
              Passenger notes
            </label>
            <textarea
              id="duplicate-notes"
              rows={3}
              className={`${inputClass} py-2`}
              value={duplicateNotes}
              onChange={(event) => setDuplicateNotes(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryButtonClass} disabled={duplicate.isPending}>
              {duplicate.isPending ? 'Copying…' : 'Create the copy'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setDuplicating(false)}>
              Never mind
            </button>
          </div>
        </form>
      </Modal>

      <p className="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Updated {formatDateTime(isFullTrip(trip) ? trip.updatedAt : trip.pickupAt)}
      </p>
    </div>
  );
}

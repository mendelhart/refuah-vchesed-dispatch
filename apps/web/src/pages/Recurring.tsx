import { blankForm,type FormState } from './recurring-form-model';
/**
 * Standing rides — dialysis three mornings a week, physio every second Tuesday.
 *
 * A standing ride is a template with a schedule; it never dispatches by itself.
 * A background job turns each date into an ordinary trip, so what this screen
 * edits is the pattern, and what it reports is what the job has already made.
 * That is why an occurrence can exist as a trip and still be marked skipped:
 * a pickup that lands in Shabbos or yom tov is created but deliberately not
 * offered, and the reason is shown rather than left for someone to work out.
 */
import { AddressFields,toAddressInput } from '@/components/AddressAutocomplete';
import { Modal } from '@/components/Modal';
import {
EmptyState,ErrorState,ListSkeleton,PageHeader,cardClass,inputClass,labelClass,panelClass,primaryButtonClass,
secondaryButtonClass,
} from '@/components/states';
import { api,errorMessage } from '@/lib/api';
import { formatDate,formatDateTime,formatMinuteOfDay,mobilityLabel,priorityLabel,statusClass,statusLabel,titleCase,tripTypeLabel } from '@/lib/format';
import { qk } from '@/lib/query';
import type { GroupsResponse } from '@/types/api';
import {
MOBILITY_NEEDS,RECURRENCE_FREQUENCIES,TRIP_PRIORITIES,TRIP_TYPES,endRecurringRideSchema,recurringRideSchema,
type MobilityNeed,type RecurrenceFrequency,type TripPriority,type TripStatus,type TripType,
} from '@rvc/shared';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { CalendarDays,CircleStop,Pause,Play,Plus,RefreshCw,Repeat } from 'lucide-react';
import React,{ useState } from 'react';
import { toast } from 'sonner';

interface RecurringRideCore {
  id: string;
  reference: string;
  status: string;
  frequency: string;
  byWeekday: number[];
  byMonthDay: number | null;
  pickupMinute: number;
  startDate: string;
  endDate: string | null;
  leadTimeMinutes: number;
  callerName: string | null;
  callerPhone: string | null;
  tripType: string;
  priority: string;
  mobilityNeeds: string[];
  passengerNotes: string | null;
}

interface RecurringListRow {
  ride: RecurringRideCore;
  group: { slug: string; name: string };
  pickup: { line1: string; city: string };
  callerName: string | null;
}
interface RecurringListResponse {
  rides: RecurringListRow[];
}

interface OccurrenceRow {
  occurrence: {
    id: string;
    occurrenceDate: string;
    skipped: boolean;
    skipReason: string | null;
    tripId: string | null;
  };
  trip: { id: string; reference: string; status: string; pickupAt: string } | null;
}
interface RecurringDetailResponse {
  ride: RecurringRideCore & { occurrences: OccurrenceRow[]; upcoming: string[] };
}

const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Every week',
  biweekly: 'Every second week',
  monthly: 'Every month',
};

const STATUS_FILTERS = [
  { value: '', label: 'All standing rides' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'ended', label: 'Ended' },
];

const RIDE_STATUS_CLASSES: Record<string, string> = {
  active: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  ended: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

/** Null rather than NaN, so a half-typed time never reaches the API as 0. */
function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(mins) || hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

function describeSchedule(ride: RecurringRideCore): string {
  const time = formatMinuteOfDay(ride.pickupMinute);
  if (ride.frequency === 'monthly') {
    return `${FREQUENCY_LABELS.monthly ?? 'Monthly'} on day ${ride.byMonthDay ?? '—'} at ${time}`;
  }
  const days = ride.byWeekday
    .slice()
    .sort((a, b) => a - b)
    .map((day) => WEEKDAY_SHORT[day] ?? String(day))
    .join(', ');
  return `${FREQUENCY_LABELS[ride.frequency] ?? titleCase(ride.frequency)} on ${days || 'no days chosen'} at ${time}`;
}

function WeekdayPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Days of the week">
      {WEEKDAY_INITIALS.map((initial, day) => {
        const active = value.includes(day);
        return (
          <button
            key={WEEKDAY_NAMES[day]}
            type="button"
            aria-pressed={active}
            aria-label={WEEKDAY_NAMES[day]}
            onClick={() => onChange(active ? value.filter((d) => d !== day) : [...value, day])}
            className={`h-11 w-11 rounded-lg border text-sm font-semibold transition-colors ${
              active
                ? 'border-[#EA0029] bg-[#EA0029] text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            {initial}
          </button>
        );
      })}
    </div>
  );
}

export function RecurringPage(): React.JSX.Element {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm);
  const [endFor, setEndFor] = useState<string | null>(null);
  const [endForm, setEndForm] = useState({ reason: '', cancelFuture: false });

  const rides = useQuery({
    queryKey: qk.recurring.list(status || undefined),
    queryFn: () => api.get<RecurringListResponse>('/api/recurring-rides', status ? { status } : undefined),
  });

  const detail = useQuery({
    queryKey: qk.recurring.detail(selectedId ?? ''),
    queryFn: () => api.get<RecurringDetailResponse>(`/api/recurring-rides/${selectedId ?? ''}`),
    enabled: selectedId !== null,
  });

  const groups = useQuery({
    queryKey: qk.people.groups(),
    queryFn: () => api.get<GroupsResponse>('/api/groups'),
    enabled: createOpen,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.recurring.all() });
  };

  const create = useMutation({
    mutationFn: (payload: unknown) => api.post<{ ride: RecurringRideCore }>('/api/recurring-rides', payload),
    onSuccess: (data) => {
      refresh();
      toast.success(`Standing ride ${data.ride.reference} created.`);
      setCreateOpen(false);
      setForm(blankForm());
      setSelectedId(data.ride.id);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const setRideStatus = useMutation({
    mutationFn: (input: { id: string; next: 'active' | 'paused' }) =>
      api.patch(`/api/recurring-rides/${input.id}`, { status: input.next }),
    onSuccess: (_data, input) => {
      refresh();
      toast.success(input.next === 'paused' ? 'Standing ride paused.' : 'Standing ride resumed.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const endRide = useMutation({
    mutationFn: (id: string) =>
      api.post<{ cancelled: number }>(`/api/recurring-rides/${id}/end`, {
        reason: endForm.reason.trim(),
        cancelFuture: endForm.cancelFuture,
      }),
    onSuccess: (data) => {
      refresh();
      toast.success(
        data.cancelled > 0
          ? `Standing ride ended and ${data.cancelled} upcoming ${data.cancelled === 1 ? 'trip' : 'trips'} cancelled.`
          : 'Standing ride ended. Trips already booked were left alone.',
      );
      setEndFor(null);
      setEndForm({ reason: '', cancelFuture: false });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const materialise = useMutation({
    mutationFn: () => api.post<{ created: number; offered: number; skipped: number }>('/api/recurring-rides/materialise'),
    onSuccess: (data) => {
      refresh();
      toast.success(`${data.created} created, ${data.offered} offered, ${data.skipped} skipped.`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const toggleNeed = (need: MobilityNeed): void =>
    setForm((current) => ({
      ...current,
      mobilityNeeds: current.mobilityNeeds.includes(need)
        ? current.mobilityNeeds.filter((item) => item !== need)
        : [...current.mobilityNeeds, need],
    }));

  const submitCreate = (event: React.FormEvent): void => {
    event.preventDefault();
    const pickupMinute = timeToMinutes(form.pickupTime);
    if (pickupMinute === null) {
      toast.error('Enter a pickup time as a time of day.');
      return;
    }
    const monthly = form.frequency === 'monthly';
    const payload = {
      callerName: form.callerName.trim() || null,
      callerPhone: form.callerPhone.trim() || null,
      callbackNumber: form.callbackNumber.trim() || null,
      pickup: toAddressInput(form.pickup),
      dropoff: toAddressInput(form.dropoff),
      pickupEntrance: form.pickupEntrance.trim() || null,
      pickupParking: form.pickupParking.trim() || null,
      dropoffEntrance: form.dropoffEntrance.trim() || null,
      dropoffParking: form.dropoffParking.trim() || null,
      tripType: form.tripType,
      priority: form.priority,
      groupSlug: form.groupSlug,
      mobilityNeeds: form.mobilityNeeds,
      passengerNotes: form.passengerNotes.trim() || null,
      appointmentOffsetMinutes: form.appointmentOffsetMinutes ? Number(form.appointmentOffsetMinutes) : null,
      frequency: form.frequency,
      byWeekday: monthly ? [] : form.byWeekday,
      byMonthDay: monthly ? Number(form.byMonthDay) : null,
      pickupMinute,
      startDate: form.startDate,
      endDate: form.endDate || null,
      leadTimeMinutes: Number(form.leadTimeMinutes || '1440'),
    };
    const parsed = recurringRideSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
      return;
    }
    create.mutate(payload);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Standing rides"
        subtitle="Repeating trips that book themselves"
        actions={
          <>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={materialise.isPending}
              onClick={() => materialise.mutate()}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Book due dates now
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                setForm(blankForm());
                setCreateOpen(true);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New standing ride
            </button>
          </>
        }
      />

      <select
        className={`${inputClass} sm:w-56`}
        value={status}
        aria-label="Filter by status"
        onChange={(event) => setStatus(event.target.value)}
      >
        {STATUS_FILTERS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <section aria-label="Standing rides" className="space-y-2">
          {rides.isPending ? (
            <ListSkeleton rows={3} lines={2} />
          ) : rides.isError ? (
            <ErrorState error={rides.error} onRetry={() => void rides.refetch()} what="the standing rides" />
          ) : rides.data.rides.length === 0 ? (
            <EmptyState
              icon={Repeat}
              title="No standing rides match this filter."
              hint="Set one up for a course of treatment and every date books itself until you end it."
            />
          ) : (
            rides.data.rides.map((row) => (
              <button
                key={row.ride.id}
                type="button"
                onClick={() => setSelectedId(row.ride.id)}
                aria-current={selectedId === row.ride.id ? 'true' : undefined}
                className={`w-full rounded-xl border p-4 text-left transition-colors ${
                  selectedId === row.ride.id
                    ? 'border-[#EA0029] bg-red-50 dark:border-[#EA0029] dark:bg-red-950/30'
                    : 'border-slate-200 bg-white hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium text-slate-900 dark:text-white">
                    {row.callerName ?? row.ride.callerName ?? 'No caller named'}
                  </p>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      RIDE_STATUS_CLASSES[row.ride.status] ?? RIDE_STATUS_CLASSES.ended
                    }`}
                  >
                    {titleCase(row.ride.status)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{describeSchedule(row.ride)}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  From {row.pickup.line1}, {row.pickup.city}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {row.ride.reference} · {row.group.name}
                </p>
              </button>
            ))
          )}
        </section>

        <section aria-label="Standing ride details" className="space-y-4">
          {selectedId === null ? (
            <EmptyState
              icon={CalendarDays}
              title="Pick a standing ride to see its dates."
              hint="The next few dates and every trip already booked from the pattern appear here."
            />
          ) : detail.isPending ? (
            <ListSkeleton rows={2} lines={4} />
          ) : detail.isError ? (
            <ErrorState error={detail.error} onRetry={() => void detail.refetch()} what="this standing ride" />
          ) : (
            <>
              <div className={`${panelClass} space-y-3`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                      {detail.data.ride.callerName ?? 'No caller named'}
                    </h2>
                    <p className="text-sm text-slate-600 dark:text-slate-400">{describeSchedule(detail.data.ride)}</p>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {tripTypeLabel(detail.data.ride.tripType as TripType)} · {priorityLabel(detail.data.ride.priority as TripPriority)} ·
                      offered {Math.round(detail.data.ride.leadTimeMinutes / 60)} h ahead
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {detail.data.ride.reference} · starts {formatDate(detail.data.ride.startDate)}
                      {detail.data.ride.endDate ? ` · ends ${formatDate(detail.data.ride.endDate)}` : ' · no end date'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail.data.ride.status !== 'ended' ? (
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={setRideStatus.isPending}
                        onClick={() =>
                          setRideStatus.mutate({
                            id: detail.data.ride.id,
                            next: detail.data.ride.status === 'paused' ? 'active' : 'paused',
                          })
                        }
                      >
                        {detail.data.ride.status === 'paused' ? (
                          <>
                            <Play className="h-4 w-4" aria-hidden="true" />
                            Resume
                          </>
                        ) : (
                          <>
                            <Pause className="h-4 w-4" aria-hidden="true" />
                            Pause
                          </>
                        )}
                      </button>
                    ) : null}
                    {detail.data.ride.status !== 'ended' ? (
                      <button type="button" className={secondaryButtonClass} onClick={() => setEndFor(detail.data.ride.id)}>
                        <CircleStop className="h-4 w-4" aria-hidden="true" />
                        End
                      </button>
                    ) : null}
                  </div>
                </div>
                {detail.data.ride.mobilityNeeds.length > 0 ? (
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {detail.data.ride.mobilityNeeds.map((need) => mobilityLabel(need as MobilityNeed)).join(', ')}
                  </p>
                ) : null}
                {detail.data.ride.passengerNotes ? (
                  <p className="text-sm text-slate-600 dark:text-slate-400">{detail.data.ride.passengerNotes}</p>
                ) : null}
              </div>

              <div>
                <h3 className="mb-2 text-lg font-semibold text-slate-900 dark:text-white">Next dates</h3>
                {detail.data.ride.upcoming.length === 0 ? (
                  <EmptyState
                    icon={CalendarDays}
                    title="No more dates in this pattern."
                    hint="The end date has passed, or the pattern has no days chosen."
                  />
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {detail.data.ride.upcoming.map((date) => (
                      <li
                        key={date}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200"
                      >
                        {formatDate(date)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-lg font-semibold text-slate-900 dark:text-white">Booked so far</h3>
                {detail.data.ride.occurrences.length === 0 ? (
                  <EmptyState
                    icon={CalendarDays}
                    title="Nothing has been booked from this pattern yet."
                    hint="Dates become real trips once they come inside the booking horizon, or when you book due dates now."
                  />
                ) : (
                  <ul className="space-y-2">
                    {detail.data.ride.occurrences.map((row) => (
                      <li key={row.occurrence.id} className={`${cardClass} p-4`}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900 dark:text-white">{formatDate(row.occurrence.occurrenceDate)}</p>
                            {row.trip ? (
                              <p className="text-sm text-slate-600 dark:text-slate-400">
                                {row.trip.reference} · {formatDateTime(row.trip.pickupAt)}
                              </p>
                            ) : (
                              <p className="text-sm text-slate-600 dark:text-slate-400">No trip was created for this date.</p>
                            )}
                          </div>
                          {row.trip ? (
                            <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusClass(row.trip.status as TripStatus)}`}>
                              {statusLabel(row.trip.status as TripStatus)}
                            </span>
                          ) : null}
                        </div>
                        {row.occurrence.skipped ? (
                          <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                            <span className="font-semibold">Not offered: </span>
                            {row.occurrence.skipReason ?? 'no reason was recorded'}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <Modal open={createOpen} title="New standing ride" onClose={() => setCreateOpen(false)} wide>
        <form className="space-y-4" onSubmit={submitCreate}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-caller-name" className={labelClass}>
                Caller name
              </label>
              <input
                id="recurring-caller-name"
                className={inputClass}
                value={form.callerName}
                onChange={(event) => setForm({ ...form, callerName: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="recurring-caller-phone" className={labelClass}>
                Caller phone
              </label>
              <input
                id="recurring-caller-phone"
                type="tel"
                className={inputClass}
                value={form.callerPhone}
                placeholder="+1 514 555 1234"
                onChange={(event) => setForm({ ...form, callerPhone: event.target.value })}
              />
            </div>
          </div>

          <AddressFields
            id="recurring-pickup"
            label="Pickup address"
            value={form.pickup}
            onChange={(next) => setForm({ ...form, pickup: next })}
            required
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-pickup-entrance" className={labelClass}>
                Pickup entrance
              </label>
              <input
                id="recurring-pickup-entrance"
                className={inputClass}
                value={form.pickupEntrance}
                onChange={(event) => setForm({ ...form, pickupEntrance: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="recurring-pickup-parking" className={labelClass}>
                Pickup parking
              </label>
              <input
                id="recurring-pickup-parking"
                className={inputClass}
                value={form.pickupParking}
                onChange={(event) => setForm({ ...form, pickupParking: event.target.value })}
              />
            </div>
          </div>

          <AddressFields
            id="recurring-dropoff"
            label="Dropoff address"
            value={form.dropoff}
            onChange={(next) => setForm({ ...form, dropoff: next })}
            notesPlaceholder="Entrance, department, parking — the volunteer sees this"
            required
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-dropoff-entrance" className={labelClass}>
                Dropoff entrance
              </label>
              <input
                id="recurring-dropoff-entrance"
                className={inputClass}
                value={form.dropoffEntrance}
                onChange={(event) => setForm({ ...form, dropoffEntrance: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="recurring-dropoff-parking" className={labelClass}>
                Dropoff parking
              </label>
              <input
                id="recurring-dropoff-parking"
                className={inputClass}
                value={form.dropoffParking}
                onChange={(event) => setForm({ ...form, dropoffParking: event.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-frequency" className={labelClass}>
                How often
              </label>
              <select
                id="recurring-frequency"
                className={inputClass}
                value={form.frequency}
                onChange={(event) => setForm({ ...form, frequency: event.target.value as RecurrenceFrequency })}
              >
                {RECURRENCE_FREQUENCIES.map((value) => (
                  <option key={value} value={value}>
                    {FREQUENCY_LABELS[value] ?? titleCase(value)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="recurring-time" className={labelClass}>
                Pickup time <span aria-hidden="true">*</span>
              </label>
              <input
                id="recurring-time"
                type="time"
                className={inputClass}
                value={form.pickupTime}
                onChange={(event) => setForm({ ...form, pickupTime: event.target.value })}
                required
              />
            </div>
          </div>

          {form.frequency === 'monthly' ? (
            <div>
              <label htmlFor="recurring-month-day" className={labelClass}>
                Day of the month
              </label>
              <input
                id="recurring-month-day"
                type="number"
                min={1}
                max={28}
                className={inputClass}
                value={form.byMonthDay}
                onChange={(event) => setForm({ ...form, byMonthDay: event.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Days 29 to 31 are not offered: they do not exist in every month, and the missing months would be skipped without
                anyone noticing.
              </p>
            </div>
          ) : (
            <div>
              <span className={labelClass}>Which days</span>
              <WeekdayPicker value={form.byWeekday} onChange={(next) => setForm({ ...form, byWeekday: next })} />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-start" className={labelClass}>
                First date <span aria-hidden="true">*</span>
              </label>
              <input
                id="recurring-start"
                type="date"
                className={inputClass}
                value={form.startDate}
                onChange={(event) => setForm({ ...form, startDate: event.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="recurring-end" className={labelClass}>
                Last date
              </label>
              <input
                id="recurring-end"
                type="date"
                className={inputClass}
                value={form.endDate}
                onChange={(event) => setForm({ ...form, endDate: event.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Leave empty to keep going until you end it.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-trip-type" className={labelClass}>
                Trip type
              </label>
              <select
                id="recurring-trip-type"
                className={inputClass}
                value={form.tripType}
                onChange={(event) => setForm({ ...form, tripType: event.target.value as TripType })}
              >
                {TRIP_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {tripTypeLabel(type)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="recurring-priority" className={labelClass}>
                Priority
              </label>
              <select
                id="recurring-priority"
                className={inputClass}
                value={form.priority}
                onChange={(event) => setForm({ ...form, priority: event.target.value as TripPriority })}
              >
                {TRIP_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priorityLabel(priority)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="recurring-group" className={labelClass}>
                Volunteer group <span aria-hidden="true">*</span>
              </label>
              <select
                id="recurring-group"
                className={inputClass}
                value={form.groupSlug}
                onChange={(event) => setForm({ ...form, groupSlug: event.target.value })}
              >
                {(groups.data?.groups ?? []).map((group) => (
                  <option key={group.slug} value={group.slug}>
                    {group.name}
                  </option>
                ))}
                {groups.isError ? <option value={form.groupSlug}>{form.groupSlug}</option> : null}
              </select>
            </div>
            <div>
              <label htmlFor="recurring-lead" className={labelClass}>
                Offer this many minutes ahead
              </label>
              <input
                id="recurring-lead"
                type="number"
                min={0}
                max={20160}
                className={inputClass}
                value={form.leadTimeMinutes}
                onChange={(event) => setForm({ ...form, leadTimeMinutes: event.target.value })}
              />
            </div>
          </div>

          <fieldset>
            <legend className={labelClass}>Mobility needs</legend>
            <div className="grid grid-cols-2 gap-2">
              {MOBILITY_NEEDS.map((need) => (
                <label
                  key={need}
                  className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[#EA0029]"
                    checked={form.mobilityNeeds.includes(need)}
                    onChange={() => toggleNeed(need)}
                  />
                  {mobilityLabel(need)}
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="recurring-notes" className={labelClass}>
              Passenger notes
            </label>
            <textarea
              id="recurring-notes"
              rows={3}
              className={`${inputClass} py-2`}
              value={form.passengerNotes}
              placeholder="Anything the volunteer should know before they arrive"
              onChange={(event) => setForm({ ...form, passengerNotes: event.target.value })}
            />
          </div>

          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={create.isPending}>
              Create standing ride
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={endFor !== null} title="End this standing ride" onClose={() => setEndFor(null)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!endFor) return;
            const parsed = endRecurringRideSchema.safeParse({
              reason: endForm.reason,
              cancelFuture: endForm.cancelFuture,
            });
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            endRide.mutate(endFor);
          }}
        >
          <div>
            <label htmlFor="recurring-end-reason" className={labelClass}>
              Why is it ending?
            </label>
            <input
              id="recurring-end-reason"
              className={inputClass}
              value={endForm.reason}
              placeholder="Treatment finished, moved away, family drives now"
              onChange={(event) => setEndForm({ ...endForm, reason: event.target.value })}
              required
            />
          </div>
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[#EA0029]"
              checked={endForm.cancelFuture}
              onChange={(event) => setEndForm({ ...endForm, cancelFuture: event.target.checked })}
            />
            Also cancel the trips already booked
          </label>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Trips already booked are real commitments a volunteer may have accepted, so they are left alone unless you say
            otherwise.
          </p>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={endRide.isPending}>
              End standing ride
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setEndFor(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

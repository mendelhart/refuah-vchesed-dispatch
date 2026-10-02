/**
 * New / edit trip form.
 *
 * Ported field-for-field from the original Trips.jsx dialog (caller, pickup,
 * dropoff, time, type, group, assignment mode, mobility needs, passenger
 * notes) with the same section order, and validated with the *same* zod
 * schemas the API validates with, so the client cannot drift from the server.
 *
 * On top of that it is now the full job card. A dispatcher taking a call has
 * three jobs at once — identify the person, write down where and when, and
 * record the things that stop a volunteer ringing back from a car park — and
 * this dialog has to do all three without the dispatcher leaving it. Hence the
 * caller lookup at the top (a third of callers have called before, and asking
 * them to repeat their door and their parking every time is the thing the
 * directory exists to stop), and hence entrance/parking sitting against their
 * own address rather than in a block of their own at the bottom.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DoorOpen, Search, SquareParking, Star, UserRound, X } from 'lucide-react';
import {
  ASSIGNMENT_MODES, MOBILITY_NEEDS, TRIP_TYPES, createJourneySchema, createTripSchema, updateTripSchema,
  type AssignmentMode, type MobilityNeed, type TripDto, type TripPriority, type TripType,
} from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { invalidateTrips, qk } from '@/lib/query';
import type { ContactsResponse } from '@/types/api';
import { saveCallerFromTrip } from '@/lib/save-caller';
import { isFullTrip } from '@/types/api';
import { mobilityLabel, relativeTime, tripTypeLabel } from '@/lib/format';
import { AddressFields, type AddressDraft, type SavedPlace } from './AddressAutocomplete';
import { Modal } from './Modal';
import type { CallerProfileResponse, CallerSearchResponse, CallerSearchRow, SavedAddressRow } from './trip-form-directory';
import { DateTimeFields } from './DateTimeFields';
import { blankForm, buildTripPayload, fieldErrors, fromTrip, type FormState } from './trip-form-model';
import { JourneyFields } from './JourneyFields';
import { PackageFields } from './PackageFields';
import { blankPackage, buildPackagePayload, type PackageDraft } from './package-model';
import { blankJourney, buildJourneyPayload, journeyIsUsed, rideCount, type JourneyDraft } from './journey-model';
import { useFlag } from '@/lib/features';
import { createPackageSchema } from '@rvc/shared';
import { InlineSpinner, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from './states';
import type { GroupsResponse, TripResponse } from '@/types/api';



/**
 * What each urgency actually changes, in the dispatcher's words.
 *
 * Deliberately qualitative: the real windows are server settings an admin can
 * change, and a number baked into this dialog would be a lie the first time
 * somebody edits them.
 */
const PRIORITY_CHOICES: { value: TripPriority; label: string; effect: string; accent: string }[] = [
  {
    value: 'routine',
    label: 'Routine',
    effect: 'Offered with the full response window — volunteers answer in their own time.',
    accent: 'border-slate-300 dark:border-slate-600',
  },
  {
    value: 'urgent',
    label: 'Urgent',
    effect: 'Much shorter window before it moves on to the next round of volunteers.',
    accent: 'border-amber-400 dark:border-amber-500/60',
  },
  {
    value: 'emergency',
    label: 'Emergency',
    effect: 'Goes to everyone at once, ignoring stated availability and snoozed phones.',
    accent: 'border-[#EA0029]',
  },
];

export function TripForm({
  open,
  trip,
  onClose,
  onCreated,
}: {
  open: boolean;
  trip?: TripDto | undefined;
  onClose: () => void;
  /** Called with the new trip after a create (not an edit). */
  onCreated?: (trip: TripDto) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  // Creating is the fast path: caller, addresses, time, type, group. Urgency,
  // assignment mode, mobility and notes sit one tap away under More options.
  const [moreOpen, setMoreOpen] = useState(Boolean(trip));
  const [form, setForm] = useState<FormState>(() => (trip ? fromTrip(trip) : blankForm()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  // The fields behind More options can still fail validation; open it so the
  // message is not hidden inside a closed section.
  const MORE_FIELDS = ['callbackNumber', 'pickupEntrance', 'pickupParking', 'dropoffEntrance', 'dropoffParking'];
  if (!moreOpen && MORE_FIELDS.some((key) => errors[key])) setMoreOpen(true);
  const [formKey, setFormKey] = useState(trip?.id ?? 'new');
  const [callerQuery, setCallerQuery] = useState('');
  const [callerTerm, setCallerTerm] = useState('');

  // Re-seed when the dialog is reopened for a different trip.
  const currentKey = trip?.id ?? 'new';
  if (currentKey !== formKey) {
    setFormKey(currentKey);
    setForm(trip ? fromTrip(trip) : blankForm());
    setErrors({});
    setCallerQuery('');
    setCallerTerm('');
  }

  // A dispatcher types the name while the caller is still saying it; searching
  // on every keystroke would fire a request per letter for no better answer.
  useEffect(() => {
    const timer = setTimeout(() => setCallerTerm(callerQuery.trim()), 250);
    return () => clearTimeout(timer);
  }, [callerQuery]);

  const groups = useQuery({
    queryKey: qk.people.groups(),
    queryFn: () => api.get<GroupsResponse>('/api/groups'),
    enabled: open,
  });

  const callerSearch = useQuery({
    queryKey: qk.callers.search(callerTerm),
    queryFn: () => api.get<CallerSearchResponse>('/api/callers/search', { q: callerTerm, limit: 8 }),
    enabled: open && !form.callerId && callerTerm.length >= 2,
  });

  const callerId = form.callerId;
  const hospitals = useQuery({
    queryKey: qk.contacts.list(),
    queryFn: () => api.get<ContactsResponse>('/api/contacts'),
    staleTime: 300_000,
  });
  const savedPlaces = useMemo<SavedPlace[]>(
    () =>
      (hospitals.data?.contacts ?? [])
        .filter((c) => c.address)
        .map((c) => ({
          id: c.id,
          name: c.name,
          isHospital: c.role?.toLowerCase() === 'hospital',
          address: c.address!,
        })),
    [hospitals.data],
  );

  const callerProfile = useQuery({
    queryKey: qk.callers.detail(callerId ?? 'none'),
    queryFn: () => api.get<CallerProfileResponse>(`/api/callers/${callerId ?? ''}`),
    enabled: open && Boolean(callerId),
  });

  const payload = useMemo(() => buildTripPayload(form, trip), [form, trip]);
  // Round trips, stops and passengers: new trips only, and only when switched on.
  const journeysOn = useFlag('multiLegTrips', open);
  const [journey, setJourney] = useState<JourneyDraft>(blankJourney);
  const packagesOn = useFlag('packageDelivery', open);
  const [pkg, setPkg] = useState<PackageDraft>(blankPackage);
  const asPackage = !trip && packagesOn && form.tripType === 'equipment_delivery' && pkg.isPackage;
  const asJourney = !asPackage && !trip && journeysOn && journeyIsUsed(journey);
  useEffect(() => { if (!open) { setJourney(blankJourney()); setPkg(blankPackage()); } }, [open]);

  const save = useMutation({
    mutationFn: async (): Promise<TripResponse> => {
      if (trip) {
        return api.patch<TripResponse>(`/api/trips/${trip.id}`, { ...payload, version: trip.version });
      }
      if (asPackage) {
        const res = await api.post<{ trip: TripResponse['trip'] }>('/api/packages', buildPackagePayload(payload, pkg));
        return { trip: res.trip } as TripResponse;
      }
      if (asJourney) {
        const res = await api.post<{ journey: { legs: Array<{ tripId: string }> } }>('/api/journeys', buildJourneyPayload(payload, journey));
        const first = res.journey.legs[0]?.tripId;
        return api.get<TripResponse>(`/api/trips/${first ?? ''}`);
      }
      return api.post<TripResponse>('/api/trips', payload);
    },
    onSuccess: (data) => {
      invalidateTrips(queryClient, 'id' in data.trip ? data.trip.id : undefined);
      if (asJourney) void queryClient.invalidateQueries({ queryKey: ['journeys'] });
      const saved = data.trip;
      if (!trip && isFullTrip(saved) && !saved.callerId && (saved.callerName || saved.callerPhone)) {
        toast.success('Trip created.', {
          action: {
            label: 'Save caller to Contacts',
            onClick: () => {
              saveCallerFromTrip(saved).then(
                () => toast.success('Caller saved to Contacts.'),
                (error: unknown) => toast.error(errorMessage(error)),
              );
            },
          },
        });
      } else {
        toast.success(trip ? 'Trip updated.' : asJourney && rideCount(journey) > 1 ? `${rideCount(journey)} rides created.` : 'Trip created.');
      }
      if (!trip && isFullTrip(saved)) onCreated?.(saved);
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error));
    },
  });

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const schema = trip ? updateTripSchema : createTripSchema;
    const result = asPackage
      ? createPackageSchema.safeParse(buildPackagePayload(payload, pkg))
      : asJourney ? createJourneySchema.safeParse(buildJourneyPayload(payload, journey)) : schema.safeParse(payload);
    if (!result.success) {
      const found = fieldErrors(result.error);
      setErrors(found);
      const first = Object.values(found)[0];
      toast.error(first ?? 'Some details are missing.');
      return;
    }
    setErrors({});
    save.mutate();
  };

  const toggleNeed = (need: MobilityNeed): void => {
    setForm((current) => ({
      ...current,
      mobilityNeeds: current.mobilityNeeds.includes(need)
        ? current.mobilityNeeds.filter((item) => item !== need)
        : [...current.mobilityNeeds, need],
    }));
  };

  const pickCaller = (row: CallerSearchRow): void => {
    setForm((current) => ({
      ...current,
      callerId: row.id,
      callerName: row.name,
      callerPhone: row.primaryPhone ?? current.callerPhone,
    }));
    setCallerQuery('');
    setCallerTerm('');
  };

  const clearCaller = (): void => {
    // Not every caller is in the directory, and a wrong match must never be a
    // dead end: this drops the link and leaves whatever is typed in place.
    setForm((current) => ({ ...current, callerId: null }));
    setCallerQuery('');
    setCallerTerm('');
  };

  const useSavedAddress = (row: SavedAddressRow, side: 'pickup' | 'dropoff'): void => {
    const draft: AddressDraft = {
      line1: row.address.line1,
      unit: row.address.unit ?? '',
      city: row.address.city,
      province: row.address.province,
      postalCode: row.address.postalCode ?? '',
      country: 'CA',
      notes: row.address.notes ?? '',
      latitude: row.address.latitude,
      longitude: row.address.longitude,
    };
    setForm((current) =>
      side === 'pickup'
        ? { ...current, pickup: draft, pickupEntrance: row.entrance ?? '', pickupParking: row.parking ?? '' }
        : { ...current, dropoff: draft, dropoffEntrance: row.entrance ?? '', dropoffParking: row.parking ?? '' },
    );
    toast.success(`${row.label} filled in as the ${side} address.`);
  };

  const callerRequired = form.tripType !== 'hospital_food';
  const fieldError = (name: string): React.JSX.Element | null =>
    errors[name] ? <p className="mt-1 text-xs text-[#C80023] dark:text-red-400">{errors[name]}</p> : null;

  const savedAddresses = callerProfile.data?.addresses ?? [];
  const accessNotes = callerProfile.data?.caller.accessNotes ?? null;

  return (
    <Modal open={open} title={trip ? `Edit ${trip.reference}` : 'New trip'} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Caller</p>
            {form.callerId ? (
              <button
                type="button"
                onClick={clearCaller}
                className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                Not this person
              </button>
            ) : null}
          </div>

          {form.callerId ? (
            <div className="mt-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
              <p className="flex items-center gap-2 text-sm font-medium text-slate-900 dark:text-white">
                <UserRound className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                {callerProfile.data?.caller.name ?? form.callerName}
                <span className="text-xs font-normal text-slate-500 dark:text-slate-400">from the directory</span>
              </p>
              {callerProfile.isPending ? <InlineSpinner label="Loading their details" /> : null}
              {callerProfile.isError ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  We could not load their saved details — the trip still saves with what is typed below.
                </p>
              ) : null}
              {/* The standing operational fact about this person. It belongs
                  above everything else on the screen, not in a notes field. */}
              {accessNotes ? (
                <p className="mt-2 rounded-lg border-l-4 border-amber-400 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 dark:border-amber-500 dark:bg-amber-500/10 dark:text-amber-200">
                  {accessNotes}
                </p>
              ) : null}

              {savedAddresses.length > 0 ? (
                <div className="mt-3 space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Saved addresses
                  </p>
                  {savedAddresses.map((row) => (
                    <div
                      key={row.id}
                      className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-600 dark:bg-slate-900"
                    >
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900 dark:text-white">
                        {row.isDefaultPickup ? (
                          <Star className="h-4 w-4 flex-shrink-0 text-amber-500" aria-hidden="true" />
                        ) : null}
                        {row.label}
                        <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                          used {row.useCount}×{row.lastUsedAt ? ` · ${relativeTime(row.lastUsedAt)}` : ''}
                        </span>
                      </p>
                      <p className="mt-0.5 break-words text-sm text-slate-600 dark:text-slate-300">
                        {row.address.line1}
                        {row.address.unit ? `, unit ${row.address.unit}` : ''} — {row.address.city}
                      </p>
                      {row.entrance || row.parking ? (
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {[row.entrance, row.parking].filter(Boolean).join(' · ')}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={secondaryButtonClass}
                          onClick={() => useSavedAddress(row, 'pickup')}
                        >
                          Use as pickup
                        </button>
                        <button
                          type="button"
                          className={secondaryButtonClass}
                          onClick={() => useSavedAddress(row, 'dropoff')}
                        >
                          Use as dropoff
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-2">
              <label htmlFor="caller-search" className={labelClass}>
                Look up a repeat caller
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="caller-search"
                  type="search"
                  autoComplete="off"
                  className={`${inputClass} pl-10`}
                  value={callerQuery}
                  placeholder="Name or phone number — two letters is enough"
                  onChange={(event) => setCallerQuery(event.target.value)}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Skip this for anyone who has not called before and just type their details below.
              </p>
              {callerSearch.isFetching ? <InlineSpinner label="Searching the directory" /> : null}
              {callerSearch.isError ? (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  The directory did not answer — carry on typing, nothing is lost.
                </p>
              ) : null}
              {callerTerm.length >= 2 && callerSearch.isSuccess && callerSearch.data.results.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Nobody matches &ldquo;{callerTerm}&rdquo; — type their details below.
                </p>
              ) : null}
              {callerSearch.data && callerSearch.data.results.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {callerSearch.data.results.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => pickCaller(row)}
                        className="flex min-h-[44px] w-full flex-col items-start rounded-lg border border-slate-200 px-3 py-2 text-left hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                      >
                        <span className="text-sm font-medium text-slate-900 dark:text-white">{row.name}</span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {[row.primaryPhone, `${row.tripCount} ${row.tripCount === 1 ? 'ride' : 'rides'}`]
                            .filter(Boolean)
                            .join(' · ')}
                          {row.lastTripAt ? ` · last ${relativeTime(row.lastTripAt)}` : ''}
                        </span>
                        {row.accessNotes ? (
                          <span className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">{row.accessNotes}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}

          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="caller-name" className={labelClass}>
                Caller name {callerRequired ? <span aria-hidden="true">*</span> : null}
              </label>
              <input
                id="caller-name"
                className={inputClass}
                value={form.callerName}
                placeholder={callerRequired ? '' : 'Optional for hospital food'}
                onChange={(event) => setForm({ ...form, callerName: event.target.value })}
              />
              {fieldError('callerName')}
            </div>
            <div>
              <label htmlFor="caller-phone" className={labelClass}>
                Caller phone {callerRequired ? <span aria-hidden="true">*</span> : null}
              </label>
              <input
                id="caller-phone"
                type="tel"
                className={inputClass}
                value={form.callerPhone}
                placeholder={callerRequired ? '+1 514 555 1234' : 'Optional for hospital food'}
                onChange={(event) => setForm({ ...form, callerPhone: event.target.value })}
              />
              {fieldError('callerPhone')}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <AddressFields
            id="pickup"
            label="Pickup address"
            value={form.pickup}
            onChange={(next) => setForm({ ...form, pickup: next })}
            savedPlaces={savedPlaces}
            required
          />
          {fieldError('pickup.line1')}
        </div>

        <div className="space-y-3">
          <AddressFields
            id="dropoff"
            label="Dropoff address"
            value={form.dropoff}
            onChange={(next) => setForm({ ...form, dropoff: next })}
            notesPlaceholder="Entrance, department, parking — the volunteer sees this"
            savedPlaces={savedPlaces}
            required
          />
          {fieldError('dropoff.line1')}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <DateTimeFields
            id="pickup-at"
            label="Pickup time"
            required
            value={form.pickupAt}
            onChange={(value) => setForm({ ...form, pickupAt: value })}
            error={fieldError('pickupAt')}
          />
          <DateTimeFields
            id="appointment-at"
            label="Appointment time"
            value={form.appointmentAt}
            onChange={(value) => setForm({ ...form, appointmentAt: value })}
            hint="The appointment the ride exists for, not the pickup. Only worth filling in when the two differ."
            error={fieldError('appointmentAt')}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!trip && <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isTest} onChange={(event) => setForm({ ...form, isTest: event.target.checked })} />
            Test ride (excluded from stats and health warnings)
          </label>}
          <div>
            <label htmlFor="trip-type" className={labelClass}>
              Trip type
            </label>
            <select
              id="trip-type"
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
            <label htmlFor="group" className={labelClass}>
              Volunteer group <span aria-hidden="true">*</span>
            </label>
            <select
              id="group"
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
            {fieldError('groupSlug')}
          </div>
        </div>

        <details open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800/60">
            More options
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              Entrance, parking, callback, urgency, notes
            </span>
          </summary>
          <div className="mt-4 space-y-4">
          <div>
            <label htmlFor="callback-number" className={labelClass}>
              Callback number
            </label>
            <input
              id="callback-number"
              type="tel"
              className={inputClass}
              value={form.callbackNumber}
              placeholder="+1 514 555 9876"
              onChange={(event) => setForm({ ...form, callbackNumber: event.target.value })}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              The number to ring about this trip — often a ward desk, not the caller.
            </p>
            {fieldError('callbackNumber')}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="pickup-entrance" className={labelClass}>
                <DoorOpen className="mr-1 inline h-4 w-4" aria-hidden="true" />
                Pickup entrance
              </label>
              <input
                id="pickup-entrance"
                className={inputClass}
                value={form.pickupEntrance}
                placeholder="Side door by the ramp"
                onChange={(event) => setForm({ ...form, pickupEntrance: event.target.value })}
              />
              {fieldError('pickupEntrance')}
            </div>
            <div>
              <label htmlFor="pickup-parking" className={labelClass}>
                <SquareParking className="mr-1 inline h-4 w-4" aria-hidden="true" />
                Pickup parking
              </label>
              <input
                id="pickup-parking"
                className={inputClass}
                value={form.pickupParking}
                placeholder="Two spots behind the building"
                onChange={(event) => setForm({ ...form, pickupParking: event.target.value })}
              />
              {fieldError('pickupParking')}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="dropoff-entrance" className={labelClass}>
                <DoorOpen className="mr-1 inline h-4 w-4" aria-hidden="true" />
                Dropoff entrance
              </label>
              <input
                id="dropoff-entrance"
                className={inputClass}
                value={form.dropoffEntrance}
                placeholder="Pavilion D, main doors"
                onChange={(event) => setForm({ ...form, dropoffEntrance: event.target.value })}
              />
              {fieldError('dropoffEntrance')}
            </div>
            <div>
              <label htmlFor="dropoff-parking" className={labelClass}>
                <SquareParking className="mr-1 inline h-4 w-4" aria-hidden="true" />
                Dropoff parking
              </label>
              <input
                id="dropoff-parking"
                className={inputClass}
                value={form.dropoffParking}
                placeholder="Drop-off loop, no waiting"
                onChange={(event) => setForm({ ...form, dropoffParking: event.target.value })}
              />
              {fieldError('dropoffParking')}
            </div>
          </div>
        <fieldset>
          <legend className={labelClass}>How urgent is this?</legend>
          <div className="space-y-2">
            {PRIORITY_CHOICES.map((choice) => {
              const selected = form.priority === choice.value;
              return (
                <label
                  key={choice.value}
                  className={`flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border-2 p-3 transition-colors ${
                    selected
                      ? `${choice.accent} bg-slate-50 dark:bg-slate-800`
                      : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <input
                    type="radio"
                    name="priority"
                    className="mt-1 h-4 w-4 flex-shrink-0 accent-[#EA0029]"
                    value={choice.value}
                    checked={selected}
                    onChange={() => setForm({ ...form, priority: choice.value })}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-900 dark:text-white">{choice.label}</span>
                    <span className="block text-xs text-slate-600 dark:text-slate-300">{choice.effect}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label htmlFor="assignment-mode" className={labelClass}>
            Assignment mode
          </label>
          <select
            id="assignment-mode"
            className={inputClass}
            value={form.assignmentMode}
            onChange={(event) => setForm({ ...form, assignmentMode: event.target.value as AssignmentMode })}
          >
            {ASSIGNMENT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode === 'auto' ? 'Auto-assign (first response wins)' : 'Coordinator approval'}
              </option>
            ))}
          </select>
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
          <label htmlFor="passenger-notes" className={labelClass}>
            Passenger notes
          </label>
          <textarea
            id="passenger-notes"
            rows={3}
            className={`${inputClass} py-2`}
            value={form.passengerNotes}
            placeholder="Anything the volunteer should know before they arrive"
            onChange={(event) => setForm({ ...form, passengerNotes: event.target.value })}
          />
        </div>
          </div>
        </details>

        {!trip && packagesOn && form.tripType === 'equipment_delivery' ? (
          <PackageFields value={pkg} onChange={setPkg} errors={errors} />
        ) : null}

        {!trip && journeysOn && !asPackage ? (
          <JourneyFields value={journey} onChange={setJourney} errors={errors} />
        ) : null}

        <div className="flex flex-wrap gap-2 pt-2">
          <button type="submit" className={`${primaryButtonClass} flex-1`} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : trip ? 'Save changes' : asJourney && rideCount(journey) > 1 ? `Create ${rideCount(journey)} rides` : 'Create trip'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

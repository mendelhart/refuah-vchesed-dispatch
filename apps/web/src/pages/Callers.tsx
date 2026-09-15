/**
 * The repeat-caller directory.
 *
 * Roughly a third of the rides here are for someone who has called before, and
 * the old app asked for the name, the number, the pickup, the entrance and the
 * parking every single time. This screen exists so that a dispatcher with a
 * phone against their ear types three digits and reads the answer back rather
 * than asking for it: the default pickup, the door to use and where to park sit
 * at the top of the panel, above everything else.
 */
import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DoorOpen, MapPin, Pencil, Phone, Plus, Search, SquareParking, Star, Trash2, UserRound, Users } from 'lucide-react';
import { ADDRESS_LABELS, callerAddressSchema, callerSchema, type AddressLabel } from '@rvc/shared';
import type { TripPriority, TripStatus } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDate, formatDateTime, priorityClass, priorityLabel, relativeTime, statusClass, statusLabel, telHref, titleCase } from '@/lib/format';
import { Modal } from '@/components/Modal';
import { AddressFields, emptyAddress, toAddressInput, type AddressDraft } from '@/components/AddressAutocomplete';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, panelClass,
  primaryButtonClass, secondaryButtonClass,
} from '@/components/states';

type CallerLanguage = 'en' | 'fr' | 'yi' | 'he';

interface CallerRow {
  id: string;
  name: string;
  primaryPhone: string | null;
  alternatePhone: string | null;
  email: string | null;
  language: string;
  notes: string | null;
  accessNotes: string | null;
  status: string;
  createdAt: string;
}
interface CallerListResponse {
  callers: CallerRow[];
}

interface CallerSearchRow {
  id: string;
  name: string;
  primaryPhone: string | null;
  alternatePhone: string | null;
  language: string;
  notes: string | null;
  accessNotes: string | null;
  tripCount: number;
  lastTripAt: string | null;
}
interface CallerSearchResponse {
  results: CallerSearchRow[];
}

interface SavedAddressRow {
  id: string;
  label: string;
  entrance: string | null;
  parking: string | null;
  isDefaultPickup: boolean;
  useCount: number;
  lastUsedAt: string | null;
  address: {
    id: string;
    line1: string;
    unit: string | null;
    city: string;
    province: string;
    postalCode: string | null;
    notes: string | null;
    latitude: number | null;
    longitude: number | null;
  };
}

/** The history rows come straight from a raw query, so they are snake_case. */
interface CallerHistoryRow {
  id: string;
  reference: string;
  status: string;
  pickup_at: string;
  trip_type: string;
  priority: string;
  mobility_needs: string[] | null;
  pickup_line1: string | null;
  pickup_city: string | null;
  dropoff_line1: string | null;
  dropoff_city: string | null;
  volunteer_name: string | null;
}

interface CallerProfileResponse {
  caller: CallerRow;
  addresses: SavedAddressRow[];
  history: CallerHistoryRow[];
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  fr: 'French',
  yi: 'Yiddish',
  he: 'Hebrew',
};

interface CallerFormState {
  name: string;
  primaryPhone: string;
  alternatePhone: string;
  email: string;
  language: CallerLanguage;
  notes: string;
  accessNotes: string;
}

function blankCaller(): CallerFormState {
  return { name: '', primaryPhone: '', alternatePhone: '', email: '', language: 'en', notes: '', accessNotes: '' };
}

function formatAddressLine(row: SavedAddressRow): string {
  return [row.address.line1, row.address.unit ? `Unit ${row.address.unit}` : null, row.address.city]
    .filter(Boolean)
    .join(', ');
}

function CallerListButton({
  name,
  phone,
  meta,
  selected,
  onSelect,
}: {
  name: string;
  phone: string | null;
  meta: string | null;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`flex min-h-[44px] w-full flex-col items-start gap-0.5 rounded-lg border px-4 py-3 text-left transition-colors ${
        selected
          ? 'border-[#E31E24] bg-red-50 dark:border-[#E31E24] dark:bg-red-950/30'
          : 'border-slate-200 bg-white hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'
      }`}
    >
      <span className="font-medium text-slate-900 dark:text-white">{name}</span>
      <span className="text-sm text-slate-600 dark:text-slate-400">{phone ?? 'No number on file'}</span>
      {meta ? <span className="text-xs text-slate-500 dark:text-slate-400">{meta}</span> : null}
    </button>
  );
}

export function CallersPage(): React.JSX.Element {
  const queryClient = useQueryClient();

  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [callerForm, setCallerForm] = useState<CallerFormState>(blankCaller);
  const [callerModal, setCallerModal] = useState<'closed' | 'new' | 'edit'>('closed');
  const [addressOpen, setAddressOpen] = useState(false);
  const [addressDraft, setAddressDraft] = useState<AddressDraft>(emptyAddress);
  const [addressExtra, setAddressExtra] = useState({
    label: 'home' as AddressLabel,
    entrance: '',
    parking: '',
    isDefaultPickup: false,
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  // Two characters is the server's own minimum; below it there is nothing to ask for.
  const searching = debounced.length >= 2;

  const callers = useQuery({
    queryKey: qk.callers.list({ limit: 100, offset: 0 }),
    queryFn: () => api.get<CallerListResponse>('/api/callers', { limit: 100, offset: 0 }),
  });

  const search = useQuery({
    queryKey: qk.callers.search(debounced),
    queryFn: () => api.get<CallerSearchResponse>('/api/callers/search', { q: debounced, limit: 10 }),
    enabled: searching,
  });

  const profile = useQuery({
    queryKey: qk.callers.detail(selectedId ?? ''),
    queryFn: () => api.get<CallerProfileResponse>(`/api/callers/${selectedId ?? ''}`),
    enabled: selectedId !== null,
  });

  const refreshDirectory = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.callers.all() });
  };

  const saveCaller = useMutation({
    mutationFn: (mode: 'new' | 'edit') => {
      const body = {
        name: callerForm.name.trim(),
        primaryPhone: callerForm.primaryPhone.trim() || null,
        alternatePhone: callerForm.alternatePhone.trim() || null,
        email: callerForm.email.trim() || null,
        language: callerForm.language,
        notes: callerForm.notes.trim() || null,
        accessNotes: callerForm.accessNotes.trim() || null,
      };
      return mode === 'new'
        ? api.post<{ caller: CallerRow }>('/api/callers', body)
        : api.patch<{ caller: CallerRow }>(`/api/callers/${selectedId ?? ''}`, body);
    },
    onSuccess: (data, mode) => {
      refreshDirectory();
      toast.success(mode === 'new' ? 'Caller added.' : 'Caller updated.');
      setSelectedId(data.caller.id);
      setCallerModal('closed');
      setCallerForm(blankCaller());
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const addAddress = useMutation({
    mutationFn: () =>
      api.post(`/api/callers/${selectedId ?? ''}/addresses`, {
        ...toAddressInput(addressDraft),
        label: addressExtra.label,
        entrance: addressExtra.entrance.trim() || null,
        parking: addressExtra.parking.trim() || null,
        isDefaultPickup: addressExtra.isDefaultPickup,
      }),
    onSuccess: () => {
      refreshDirectory();
      toast.success('Address saved.');
      setAddressOpen(false);
      setAddressDraft(emptyAddress());
      setAddressExtra({ label: 'home', entrance: '', parking: '', isDefaultPickup: false });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const removeAddress = useMutation({
    mutationFn: (addressId: string) => api.del(`/api/callers/${selectedId ?? ''}/addresses/${addressId}`),
    onSuccess: () => {
      refreshDirectory();
      toast.success('Address removed.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const openEdit = (caller: CallerRow): void => {
    setCallerForm({
      name: caller.name,
      primaryPhone: caller.primaryPhone ?? '',
      alternatePhone: caller.alternatePhone ?? '',
      email: caller.email ?? '',
      language: (caller.language as CallerLanguage) || 'en',
      notes: caller.notes ?? '',
      accessNotes: caller.accessNotes ?? '',
    });
    setCallerModal('edit');
  };

  const defaultPickup = profile.data?.addresses.find((row) => row.isDefaultPickup) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Callers"
        subtitle="Who has called before, where they go, and how to get in"
        actions={
          <button
            type="button"
            className={primaryButtonClass}
            onClick={() => {
              setCallerForm(blankCaller());
              setCallerModal('new');
            }}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New caller
          </button>
        }
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          className={`${inputClass} pl-10`}
          value={term}
          aria-label="Search callers by name or number"
          placeholder="Type a name or the last digits of the number"
          onChange={(event) => setTerm(event.target.value)}
        />
        {searching && search.isFetching ? (
          <span
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-slate-300 border-t-[#E31E24] dark:border-slate-600"
            role="status"
            aria-label="Searching"
          />
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <section aria-label="Caller list" className="space-y-2">
          {searching ? (
            search.isPending ? (
              <ListSkeleton rows={3} lines={1} />
            ) : search.isError ? (
              <ErrorState error={search.error} onRetry={() => void search.refetch()} what="the search results" />
            ) : search.data.results.length === 0 ? (
              <EmptyState
                icon={Search}
                title="Nobody on file matches that."
                hint="Try fewer digits, or add them as a new caller so the next call is quicker."
              />
            ) : (
              search.data.results.map((row) => (
                <CallerListButton
                  key={row.id}
                  name={row.name}
                  phone={row.primaryPhone}
                  meta={
                    row.tripCount > 0
                      ? `${row.tripCount} ${row.tripCount === 1 ? 'ride' : 'rides'} · last ${relativeTime(row.lastTripAt)}`
                      : 'No rides yet'
                  }
                  selected={selectedId === row.id}
                  onSelect={() => setSelectedId(row.id)}
                />
              ))
            )
          ) : callers.isPending ? (
            <ListSkeleton rows={4} lines={1} />
          ) : callers.isError ? (
            <ErrorState error={callers.error} onRetry={() => void callers.refetch()} what="the caller directory" />
          ) : callers.data.callers.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No callers on file yet."
              hint="Add the people who ring regularly and their usual pickup, entrance and parking are one click away next time."
            />
          ) : (
            callers.data.callers.map((row) => (
              <CallerListButton
                key={row.id}
                name={row.name}
                phone={row.primaryPhone}
                meta={row.accessNotes ? 'Has access notes' : null}
                selected={selectedId === row.id}
                onSelect={() => setSelectedId(row.id)}
              />
            ))
          )}
        </section>

        <section aria-label="Caller details" className="space-y-4">
          {selectedId === null ? (
            <EmptyState
              icon={UserRound}
              title="Pick a caller to see their file."
              hint="Their usual pickup, the entrance to use and where to park appear here, so you do not have to ask again."
            />
          ) : profile.isPending ? (
            <ListSkeleton rows={2} lines={4} />
          ) : profile.isError ? (
            <ErrorState error={profile.error} onRetry={() => void profile.refetch()} what="this caller's file" />
          ) : (
            <>
              <div className={`${panelClass} space-y-3`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">{profile.data.caller.name}</h2>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      {LANGUAGE_LABELS[profile.data.caller.language] ?? titleCase(profile.data.caller.language)}
                      {profile.data.caller.status !== 'active' ? ` · ${titleCase(profile.data.caller.status)}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={secondaryButtonClass} onClick={() => openEdit(profile.data.caller)}>
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                      Edit
                    </button>
                    <button type="button" className={secondaryButtonClass} onClick={() => setAddressOpen(true)}>
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      Add address
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {[profile.data.caller.primaryPhone, profile.data.caller.alternatePhone]
                    .filter((phone): phone is string => Boolean(phone))
                    .map((phone) => (
                      <a
                        key={phone}
                        href={telHref(phone)}
                        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        <Phone className="h-4 w-4" aria-hidden="true" />
                        {phone}
                      </a>
                    ))}
                  {profile.data.caller.email ? (
                    <span className="inline-flex min-h-[44px] items-center text-sm text-slate-600 dark:text-slate-400">
                      {profile.data.caller.email}
                    </span>
                  ) : null}
                </div>

                {profile.data.caller.accessNotes ? (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                    <span className="font-semibold">Access: </span>
                    {profile.data.caller.accessNotes}
                  </p>
                ) : null}
                {profile.data.caller.notes ? (
                  <p className="text-sm text-slate-600 dark:text-slate-400">{profile.data.caller.notes}</p>
                ) : null}
              </div>

              {defaultPickup ? (
                <div className="rounded-xl border-2 border-[#E31E24] bg-red-50 p-4 dark:bg-red-950/30">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[#E31E24]">
                    <Star className="h-4 w-4" aria-hidden="true" />
                    Usual pickup
                  </p>
                  <p className="mt-1 font-medium text-slate-900 dark:text-white">{formatAddressLine(defaultPickup)}</p>
                  {defaultPickup.entrance ? (
                    <p className="mt-1 flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                      <DoorOpen className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                      {defaultPickup.entrance}
                    </p>
                  ) : null}
                  {defaultPickup.parking ? (
                    <p className="mt-1 flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                      <SquareParking className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                      {defaultPickup.parking}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div>
                <h3 className="mb-2 text-lg font-semibold text-slate-900 dark:text-white">Saved addresses</h3>
                {profile.data.addresses.length === 0 ? (
                  <EmptyState
                    icon={MapPin}
                    title="No addresses saved for this caller."
                    hint="Save the pickup with its entrance and parking and the next call takes seconds."
                    action={
                      <button type="button" className={secondaryButtonClass} onClick={() => setAddressOpen(true)}>
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Add address
                      </button>
                    }
                  />
                ) : (
                  <ul className="space-y-2">
                    {profile.data.addresses.map((row) => (
                      <li key={row.id} className={`${cardClass} flex flex-wrap items-start justify-between gap-3 p-4`}>
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-slate-900 dark:text-white">{formatAddressLine(row)}</span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              {titleCase(row.label)}
                            </span>
                            {row.isDefaultPickup ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-[#E31E24] dark:bg-red-500/15 dark:text-red-300">
                                <Star className="h-3 w-3" aria-hidden="true" />
                                Use as pickup
                              </span>
                            ) : null}
                          </p>
                          {row.entrance ? (
                            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Entrance: {row.entrance}</p>
                          ) : null}
                          {row.parking ? (
                            <p className="text-sm text-slate-600 dark:text-slate-400">Parking: {row.parking}</p>
                          ) : null}
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            Used {row.useCount} {row.useCount === 1 ? 'time' : 'times'}
                            {row.lastUsedAt ? ` · last ${formatDate(row.lastUsedAt)}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          aria-label={`Remove ${row.address.line1}`}
                          className="grid h-11 w-11 place-items-center rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                          onClick={() => {
                            if (window.confirm(`Remove ${row.address.line1} from this caller?`)) removeAddress.mutate(row.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-lg font-semibold text-slate-900 dark:text-white">Recent rides</h3>
                {profile.data.history.length === 0 ? (
                  <EmptyState
                    icon={MapPin}
                    title="No rides on file for this caller yet."
                    hint="Once they have travelled with us, the last twenty-five trips appear here."
                  />
                ) : (
                  <ul className="space-y-2">
                    {profile.data.history.map((trip) => (
                      <li key={trip.id} className={`${cardClass} p-4`}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900 dark:text-white">
                              {trip.pickup_line1 ?? 'Unknown pickup'} → {trip.dropoff_line1 ?? 'Unknown dropoff'}
                            </p>
                            <p className="text-sm text-slate-600 dark:text-slate-400">{formatDateTime(trip.pickup_at)}</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                              {trip.reference}
                              {trip.volunteer_name ? ` · ${trip.volunteer_name}` : ' · No driver recorded'}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusClass(trip.status as TripStatus)}`}>
                              {statusLabel(trip.status as TripStatus)}
                            </span>
                            {trip.priority !== 'routine' ? (
                              <span className={`rounded-full px-3 py-1 text-xs font-medium ${priorityClass(trip.priority as TripPriority)}`}>
                                {priorityLabel(trip.priority as TripPriority)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <Modal
        open={callerModal !== 'closed'}
        title={callerModal === 'edit' ? 'Edit caller' : 'New caller'}
        onClose={() => setCallerModal('closed')}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = callerSchema.safeParse({
              name: callerForm.name,
              primaryPhone: callerForm.primaryPhone || null,
              alternatePhone: callerForm.alternatePhone || null,
              email: callerForm.email || null,
              language: callerForm.language,
              notes: callerForm.notes || null,
              accessNotes: callerForm.accessNotes || null,
            });
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            saveCaller.mutate(callerModal === 'edit' ? 'edit' : 'new');
          }}
        >
          <div>
            <label htmlFor="caller-name" className={labelClass}>
              Name
            </label>
            <input
              id="caller-name"
              className={inputClass}
              value={callerForm.name}
              onChange={(event) => setCallerForm({ ...callerForm, name: event.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="caller-primary-phone" className={labelClass}>
                Main number
              </label>
              <input
                id="caller-primary-phone"
                type="tel"
                className={inputClass}
                value={callerForm.primaryPhone}
                placeholder="+1 514 555 1234"
                onChange={(event) => setCallerForm({ ...callerForm, primaryPhone: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="caller-alternate-phone" className={labelClass}>
                Other number
              </label>
              <input
                id="caller-alternate-phone"
                type="tel"
                className={inputClass}
                value={callerForm.alternatePhone}
                onChange={(event) => setCallerForm({ ...callerForm, alternatePhone: event.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="caller-email" className={labelClass}>
                Email
              </label>
              <input
                id="caller-email"
                type="email"
                className={inputClass}
                value={callerForm.email}
                onChange={(event) => setCallerForm({ ...callerForm, email: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="caller-language" className={labelClass}>
                Language
              </label>
              <select
                id="caller-language"
                className={inputClass}
                value={callerForm.language}
                onChange={(event) => setCallerForm({ ...callerForm, language: event.target.value as CallerLanguage })}
              >
                {(['en', 'fr', 'yi', 'he'] as const).map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGE_LABELS[code]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="caller-access-notes" className={labelClass}>
              Access notes
            </label>
            <textarea
              id="caller-access-notes"
              rows={2}
              className={`${inputClass} py-2`}
              value={callerForm.accessNotes}
              placeholder="Ring the buzzer twice, hard of hearing, daughter answers the phone"
              onChange={(event) => setCallerForm({ ...callerForm, accessNotes: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="caller-notes" className={labelClass}>
              Notes
            </label>
            <textarea
              id="caller-notes"
              rows={3}
              className={`${inputClass} py-2`}
              value={callerForm.notes}
              onChange={(event) => setCallerForm({ ...callerForm, notes: event.target.value })}
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={saveCaller.isPending}>
              {callerModal === 'edit' ? 'Save changes' : 'Save caller'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setCallerModal('closed')}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={addressOpen} title="Add an address" onClose={() => setAddressOpen(false)} wide>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = callerAddressSchema.safeParse({
              ...toAddressInput(addressDraft),
              label: addressExtra.label,
              entrance: addressExtra.entrance || null,
              parking: addressExtra.parking || null,
              isDefaultPickup: addressExtra.isDefaultPickup,
            });
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            addAddress.mutate();
          }}
        >
          <AddressFields
            id="caller-address"
            label="Address"
            value={addressDraft}
            onChange={setAddressDraft}
            notesPlaceholder="Anything else about this address"
            required
          />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="caller-address-label" className={labelClass}>
                What is this place?
              </label>
              <select
                id="caller-address-label"
                className={inputClass}
                value={addressExtra.label}
                onChange={(event) => setAddressExtra({ ...addressExtra, label: event.target.value as AddressLabel })}
              >
                {ADDRESS_LABELS.map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="caller-address-entrance" className={labelClass}>
                Entrance
              </label>
              <input
                id="caller-address-entrance"
                className={inputClass}
                value={addressExtra.entrance}
                placeholder="Side door by the ramp"
                onChange={(event) => setAddressExtra({ ...addressExtra, entrance: event.target.value })}
              />
            </div>
          </div>

          <div>
            <label htmlFor="caller-address-parking" className={labelClass}>
              Parking
            </label>
            <input
              id="caller-address-parking"
              className={inputClass}
              value={addressExtra.parking}
              placeholder="Two spots behind the building, gate code 4412"
              onChange={(event) => setAddressExtra({ ...addressExtra, parking: event.target.value })}
            />
          </div>

          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[#E31E24]"
              checked={addressExtra.isDefaultPickup}
              onChange={(event) => setAddressExtra({ ...addressExtra, isDefaultPickup: event.target.checked })}
            />
            Use as the pickup for this caller
          </label>

          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={addAddress.isPending}>
              Save address
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setAddressOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

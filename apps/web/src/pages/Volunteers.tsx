/**
 * The volunteer screen a dispatcher actually uses: one searchable list instead
 * of six.
 *
 * The single most important line of copy on this page is the availability one.
 * `availability_rules === 0` means the volunteer has stated no restriction, so
 * they can be asked at any hour — it does NOT mean they are unavailable. The
 * legacy screen showed an empty week for those people and dispatchers read it
 * as "switched off", so the most willing volunteers on the roster were the ones
 * nobody called. Every label here says it the right way round.
 *
 * The drawer exists for the phone call: "I can't do Thursdays any more" has to
 * be fixable while the volunteer is still on the line, by the person taking the
 * call, without an email to an administrator.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarDays, List, Phone, Plus, Search, Trash2, Users } from 'lucide-react';
import { VOLUNTEER_CAPABILITIES, type VolunteerCapability } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDate, formatDateTime, relativeTime, telHref, titleCase } from '@/lib/format';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, InlineSpinner, ListSkeleton, PageHeader, cardClass, inputClass, labelClass,
  panelClass, primaryButtonClass, secondaryButtonClass, tableWrapClass,
} from '@/components/states';
import type { GroupsResponse } from '@/types/api';

/** Snake case on purpose: this row comes straight from a raw SQL projection. */
interface VolunteerRow {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  role: string;
  status: string;
  volunteer_number: string | null;
  capabilities: string[];
  languages: string[];
  service_area: string | null;
  muted_until: string | null;
  last_offered_at: string | null;
  notification_preference: string | null;
  group_slugs: string[];
  group_names: string[];
  service_slugs: string[];
  availability_rules: number;
  completed_trips: number;
  last_trip_at: string | null;
  open_trips: number;
  licence_status: string | null;
}

interface OverviewResponse {
  volunteers: VolunteerRow[];
}

interface ServicesResponse {
  services: { id: string; slug: string; name: string; description: string | null }[];
}

interface AvailabilityWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

interface AvailabilityException {
  id: string;
  kind: 'unavailable' | 'available';
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

interface AvailabilityResponse {
  windows: AvailabilityWindow[];
  unrestricted: boolean;
  exceptions: AvailabilityException[];
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The calendar asks each volunteer's availability separately, so it is capped
 *  rather than firing three hundred requests at a filter nobody narrowed. */
const CALENDAR_LIMIT = 40;

const chipClass =
  'inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200';

function minutesToTime(minutes: number): string {
  const wrapped = minutes % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function timeToMinutes(value: string, isEnd: boolean): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  // An end of 00:00 means midnight at the end of that day, which is minute 1440.
  if (isEnd && minutes === 0) return 1440;
  return minutes;
}

function isSnoozed(row: VolunteerRow): boolean {
  return Boolean(row.muted_until) && new Date(row.muted_until as string).getTime() > Date.now();
}

export function VolunteersPage(): React.JSX.Element {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [groupSlug, setGroupSlug] = useState('');
  const [serviceSlug, setServiceSlug] = useState('');
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filters = {
    ...(search ? { search } : {}),
    ...(groupSlug ? { groupSlug } : {}),
    ...(serviceSlug ? { serviceSlug } : {}),
    status,
  };

  const overview = useQuery({
    queryKey: qk.volunteers.overview(filters),
    queryFn: () => api.get<OverviewResponse>('/api/volunteers/overview', { ...filters, limit: 200 }),
  });

  const groups = useQuery({
    queryKey: qk.people.groups(),
    queryFn: () => api.get<GroupsResponse>('/api/groups'),
  });
  const services = useQuery({
    queryKey: qk.services.list(),
    queryFn: () => api.get<ServicesResponse>('/api/services'),
  });

  const rows = overview.data?.volunteers ?? [];
  const selected = rows.find((row) => row.id === openId) ?? null;
  const unrestrictedCount = rows.filter((row) => row.availability_rules === 0).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Volunteers"
        subtitle="Who is on the roster, what they do, and when they can be asked"
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            className={`${inputClass} pl-10`}
            placeholder="Search name, phone or email…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            aria-label="Search volunteers"
          />
        </div>
        <select
          className={inputClass}
          value={groupSlug}
          onChange={(event) => setGroupSlug(event.target.value)}
          aria-label="Filter by group"
        >
          <option value="">All groups</option>
          {(groups.data?.groups ?? []).map((group) => (
            <option key={group.slug} value={group.slug}>
              {group.name}
            </option>
          ))}
        </select>
        <select
          className={inputClass}
          value={serviceSlug}
          onChange={(event) => setServiceSlug(event.target.value)}
          aria-label="Filter by service"
        >
          <option value="">All services</option>
          {(services.data?.services ?? []).map((service) => (
            <option key={service.slug} value={service.slug}>
              {service.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          className={`${inputClass} sm:w-48`}
          value={status}
          onChange={(event) => setStatus(event.target.value as 'active' | 'all')}
          aria-label="Filter by account status"
        >
          <option value="active">Active accounts</option>
          <option value="all">Everyone, including deactivated</option>
        </select>
        <div role="tablist" aria-label="How to show the roster" className="flex gap-2">
          {([
            { id: 'list' as const, label: 'List', icon: List },
            { id: 'calendar' as const, label: 'Calendar', icon: CalendarDays },
          ]).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              onClick={() => setView(item.id)}
              className={`inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors ${
                view === item.id
                  ? 'bg-[#E31E24] text-white'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {overview.isPending ? (
        <ListSkeleton rows={6} lines={2} />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} what="the roster" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nobody matches these filters."
          hint="Try clearing the search, or widening the group and service."
        />
      ) : view === 'list' ? (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {rows.length} {rows.length === 1 ? 'person' : 'people'} · {unrestrictedCount} have stated no restriction,
            so they can be asked at any time.
          </p>
          <RosterTable rows={rows} onOpen={setOpenId} />
          <RosterCards rows={rows} onOpen={setOpenId} />
        </>
      ) : (
        <FortnightView rows={rows} />
      )}

      {selected ? (
        <VolunteerDrawer
          row={selected}
          services={services.data?.services ?? []}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

/** Says the availability state the right way round, every time it is shown. */
function availabilityLabel(row: VolunteerRow): { text: string; className: string } {
  if (row.availability_rules === 0) {
    return {
      text: 'No stated restriction — can be asked any time',
      className: 'text-green-700 dark:text-green-300',
    };
  }
  return {
    text: `${row.availability_rules} ${row.availability_rules === 1 ? 'window' : 'windows'} set`,
    className: 'text-slate-600 dark:text-slate-400',
  };
}

function RosterTable({ rows, onOpen }: { rows: VolunteerRow[]; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <div className={`${tableWrapClass} hidden md:block`}>
      <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
        <thead className="bg-slate-50 dark:bg-slate-800">
          <tr>
            {['Name', 'Groups', 'Services', 'Can handle', 'Trips', 'Can be asked'].map((heading) => (
              <th
                key={heading}
                scope="col"
                className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200"
              >
                {heading}
              </th>
            ))}
            <th scope="col" className="px-4 py-3 text-right font-semibold text-slate-700 dark:text-slate-200">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-900">
          {rows.map((row) => {
            const availability = availabilityLabel(row);
            return (
              <tr key={row.id}>
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900 dark:text-white">{row.full_name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {row.volunteer_number ? `${row.volunteer_number} · ` : ''}
                    {row.phone ? (
                      <a className="underline" href={telHref(row.phone)}>
                        {row.phone}
                      </a>
                    ) : (
                      'No phone'
                    )}
                  </p>
                  {row.status !== 'active' ? (
                    <span className="mt-1 inline-block rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                      {titleCase(row.status)}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                  {row.group_names.length > 0 ? row.group_names.join(', ') : '—'}
                </td>
                <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                  {row.service_slugs.length > 0 ? row.service_slugs.map(titleCase).join(', ') : '—'}
                </td>
                <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                  {row.capabilities.length > 0 ? row.capabilities.map(titleCase).join(', ') : '—'}
                </td>
                <td className="px-4 py-3 text-slate-700 dark:text-slate-200">
                  {row.completed_trips}
                  {row.open_trips > 0 ? (
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {row.open_trips} open now
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <p className={`text-xs font-medium ${availability.className}`}>{availability.text}</p>
                  {isSnoozed(row) ? (
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                      Snoozed until {formatDateTime(row.muted_until)}
                    </p>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <button type="button" className={secondaryButtonClass} onClick={() => onOpen(row.id)}>
                    Open
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RosterCards({ rows, onOpen }: { rows: VolunteerRow[]; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <ul className="space-y-2 md:hidden">
      {rows.map((row) => {
        const availability = availabilityLabel(row);
        return (
          <li key={row.id} className={`${cardClass} p-4`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-slate-900 dark:text-white">{row.full_name}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {row.volunteer_number ? `${row.volunteer_number} · ` : ''}
                  {row.group_names.length > 0 ? row.group_names.join(', ') : 'No group'}
                </p>
              </div>
              {row.phone ? (
                <a
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 dark:border-slate-600 dark:text-slate-200"
                  href={telHref(row.phone)}
                >
                  <Phone className="h-4 w-4" aria-hidden="true" />
                  Call
                </a>
              ) : null}
            </div>
            <ul className="mt-2 flex flex-wrap gap-1">
              {row.service_slugs.map((slug) => (
                <li key={slug} className={chipClass}>
                  {titleCase(slug)}
                </li>
              ))}
              {row.capabilities.map((capability) => (
                <li key={capability} className={chipClass}>
                  {titleCase(capability)}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              {row.completed_trips} completed{row.open_trips > 0 ? ` · ${row.open_trips} open now` : ''}
            </p>
            <p className={`mt-1 text-sm font-medium ${availability.className}`}>{availability.text}</p>
            {isSnoozed(row) ? (
              <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-300">
                Snoozed until {formatDateTime(row.muted_until)}
              </p>
            ) : null}
            <button type="button" className={`${secondaryButtonClass} mt-3 w-full`} onClick={() => onOpen(row.id)}>
              Open their record
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The coming fortnight, per day, from the weekly windows each volunteer has
 * stated. Deliberately plain: it answers "who could I ask on Tuesday", and it
 * says out loud that people with no stated hours are missing from the day
 * columns because they are available for all of them.
 */
function FortnightView({ rows }: { rows: VolunteerRow[] }): React.JSX.Element {
  const restricted = rows.filter((row) => row.availability_rules > 0).slice(0, CALENDAR_LIMIT);
  const anyTime = rows.filter((row) => row.availability_rules === 0);
  const truncated = rows.filter((row) => row.availability_rules > 0).length - restricted.length;

  const results = useQueries({
    queries: restricted.map((row) => ({
      queryKey: qk.volunteers.availability(row.id),
      queryFn: () => api.get<AvailabilityResponse>(`/api/volunteers/${row.id}/availability`),
      staleTime: 60_000,
    })),
  });

  const loaded = results.filter((result) => result.data).length;
  const failed = results.filter((result) => result.isError).length;

  const days = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 14 }, (_, index) => {
      const date = new Date(today);
      date.setDate(date.getDate() + index);
      const dayEnd = new Date(date);
      dayEnd.setDate(dayEnd.getDate() + 1);

      const people: { id: string; name: string; hours: string }[] = [];
      restricted.forEach((row, position) => {
        const data = results[position]?.data;
        if (!data) return;
        const away = data.exceptions.some(
          (exception) =>
            exception.kind === 'unavailable' &&
            new Date(exception.startsAt) < dayEnd &&
            new Date(exception.endsAt) > date,
        );
        if (away) return;
        const windows = data.windows.filter((window) => window.weekday === date.getDay());
        const extra = data.exceptions.some(
          (exception) =>
            exception.kind === 'available' &&
            new Date(exception.startsAt) < dayEnd &&
            new Date(exception.endsAt) > date,
        );
        if (windows.length === 0 && !extra) return;
        people.push({
          id: row.id,
          name: row.full_name,
          hours:
            windows.length > 0
              ? windows
                  .map((window) => `${minutesToTime(window.startMinute)}–${minutesToTime(window.endMinute)}`)
                  .join(', ')
              : 'Free by arrangement',
        });
      });
      return { date, people };
    });
  }, [restricted, results]);

  return (
    <div className="space-y-4">
      <div className={panelClass}>
        <p className="text-sm text-slate-700 dark:text-slate-200">
          <span className="font-semibold">{anyTime.length}</span>{' '}
          {anyTime.length === 1 ? 'person has' : 'people have'} stated no restriction, so they can be asked on any of
          these days and are not listed in the columns below.
        </p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          The days show only the {restricted.length} {restricted.length === 1 ? 'person' : 'people'} who have set
          hours for themselves.
          {truncated > 0
            ? ` ${truncated} more have hours set but are not shown — narrow the filters to include them.`
            : ''}
        </p>
        {loaded < restricted.length ? (
          <p className="mt-2">
            <InlineSpinner label={`Loading hours, ${loaded} of ${restricted.length}`} />
          </p>
        ) : null}
        {failed > 0 ? (
          <p className="mt-2 text-sm font-medium text-[#E31E24]">
            {failed} {failed === 1 ? "person's" : "people's"} hours did not load, so they are missing from the days
            below.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
        {days.map((day) => (
          <section key={day.date.toISOString()} className={`${panelClass} min-w-0`}>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              {SHORT_DAYS[day.date.getDay()]}{' '}
              <span className="font-normal text-slate-500 dark:text-slate-400">
                {day.date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
              </span>
            </h3>
            {day.people.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Nobody with set hours{anyTime.length > 0 ? `, plus the ${anyTime.length} with none` : ''}.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {day.people.map((person) => (
                  <li key={person.id} className="text-xs">
                    <p className="break-words font-medium text-slate-900 dark:text-white">{person.name}</p>
                    <p className="text-slate-600 dark:text-slate-400">{person.hours}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function VolunteerDrawer({
  row,
  services,
  onClose,
}: {
  row: VolunteerRow;
  services: { slug: string; name: string }[];
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();

  const availability = useQuery({
    queryKey: qk.volunteers.availability(row.id),
    queryFn: () => api.get<AvailabilityResponse>(`/api/volunteers/${row.id}/availability`),
  });

  const [draft, setDraft] = useState<{ start: string; end: string }[][]>(() => DAY_NAMES.map(() => []));
  const [seeded, setSeeded] = useState<string | null>(null);
  const [serviceSlugs, setServiceSlugs] = useState<string[]>(row.service_slugs);
  const [capabilities, setCapabilities] = useState<string[]>(row.capabilities);

  // Seed once per server payload, so a refetch cannot wipe an edit in progress.
  const windows = availability.data?.windows;
  useEffect(() => {
    if (!windows) return;
    const signature = JSON.stringify(windows);
    if (seeded === signature) return;
    setSeeded(signature);
    const next: { start: string; end: string }[][] = DAY_NAMES.map(() => []);
    for (const window of windows) {
      next[window.weekday]?.push({
        start: minutesToTime(window.startMinute),
        end: minutesToTime(window.endMinute),
      });
    }
    setDraft(next);
  }, [windows, seeded]);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.volunteers.all() });
    void queryClient.invalidateQueries({ queryKey: qk.volunteers.availability(row.id) });
  };

  const saveAvailability = useMutation({
    mutationFn: (payload: AvailabilityWindow[]) =>
      api.put<{ windows: AvailabilityWindow[] }>(`/api/volunteers/${row.id}/availability`, { windows: payload }),
    onSuccess: (data) => {
      invalidate();
      toast.success(
        data.windows.length === 0
          ? 'Saved. With no hours set they can be asked at any time.'
          : 'Saved. They will only be asked inside those hours.',
      );
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const saveServices = useMutation({
    mutationFn: (payload: string[]) =>
      api.put<{ services: unknown[] }>(`/api/volunteers/${row.id}/services`, { services: payload }),
    onSuccess: () => {
      invalidate();
      toast.success('Services saved.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const saveCapabilities = useMutation({
    mutationFn: (payload: string[]) =>
      api.put<{ capabilities: string[] }>(`/api/volunteers/${row.id}/capabilities`, { capabilities: payload }),
    onSuccess: () => {
      invalidate();
      toast.success('Capabilities saved.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const draftEmpty = draft.every((ranges) => ranges.length === 0);

  const updateDay = (day: number, ranges: { start: string; end: string }[]): void => {
    setDraft((current) => current.map((value, index) => (index === day ? ranges : value)));
  };

  const handleSaveAvailability = (): void => {
    const payload: AvailabilityWindow[] = [];
    for (let day = 0; day < DAY_NAMES.length; day += 1) {
      for (const range of draft[day] ?? []) {
        const startMinute = timeToMinutes(range.start, false);
        const endMinute = timeToMinutes(range.end, true);
        if (startMinute === null || endMinute === null) {
          toast.error(`Fill in both times on ${DAY_NAMES[day]}.`);
          return;
        }
        if (endMinute <= startMinute) {
          toast.error(`On ${DAY_NAMES[day]}, the end time has to be after the start time.`);
          return;
        }
        payload.push({ weekday: day, startMinute, endMinute });
      }
    }
    saveAvailability.mutate(payload);
  };

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <Modal open title={row.full_name} onClose={onClose} wide>
      <div className="space-y-5">
        <section>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {row.volunteer_number ? `${row.volunteer_number} · ` : ''}
            {titleCase(row.role)} · {titleCase(row.status)}
            {row.licence_status ? ` · licence ${titleCase(row.licence_status)}` : ''}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {row.phone ? (
              <a className={secondaryButtonClass} href={telHref(row.phone)}>
                <Phone className="h-4 w-4" aria-hidden="true" />
                {row.phone}
              </a>
            ) : null}
            {row.email ? (
              <a className={secondaryButtonClass} href={`mailto:${row.email}`}>
                {row.email}
              </a>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            {row.completed_trips} completed
            {row.last_trip_at ? ` · last ${formatDate(row.last_trip_at)}` : ' · none yet'}
            {row.last_offered_at ? ` · last asked ${relativeTime(row.last_offered_at)}` : ' · never asked'}
          </p>
          {isSnoozed(row) ? (
            <p className="mt-1 text-sm font-medium text-amber-700 dark:text-amber-300">
              Notifications snoozed until {formatDateTime(row.muted_until)}.
            </p>
          ) : null}
          {row.languages.length > 0 ? (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Speaks {row.languages.map(titleCase).join(', ')}
              {row.service_area ? ` · works in ${row.service_area}` : ''}
            </p>
          ) : null}
        </section>

        <section>
          <h3 className="font-semibold text-slate-900 dark:text-white">Services</h3>
          <ul className="mt-2 space-y-1">
            {services.map((service) => (
              <li key={service.slug}>
                <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    className="h-5 w-5 rounded border-slate-300 text-[#E31E24] focus:ring-[#E31E24] dark:border-slate-600 dark:bg-slate-800"
                    checked={serviceSlugs.includes(service.slug)}
                    onChange={() => setServiceSlugs((current) => toggle(current, service.slug))}
                  />
                  {service.name}
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={`${primaryButtonClass} mt-2`}
            disabled={saveServices.isPending}
            onClick={() => saveServices.mutate(serviceSlugs)}
          >
            {saveServices.isPending ? 'Saving…' : 'Save services'}
          </button>
        </section>

        <section>
          <h3 className="font-semibold text-slate-900 dark:text-white">What they can handle</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {VOLUNTEER_CAPABILITIES.map((capability: VolunteerCapability) => (
              <li key={capability}>
                <label
                  className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border px-4 text-sm ${
                    capabilities.includes(capability)
                      ? 'border-[#E31E24] bg-[#E31E24] text-white'
                      : 'border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={capabilities.includes(capability)}
                    onChange={() => setCapabilities((current) => toggle(current, capability))}
                  />
                  {titleCase(capability)}
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={`${primaryButtonClass} mt-2`}
            disabled={saveCapabilities.isPending}
            onClick={() => saveCapabilities.mutate(capabilities)}
          >
            {saveCapabilities.isPending ? 'Saving…' : 'Save capabilities'}
          </button>
        </section>

        <section>
          <h3 className="font-semibold text-slate-900 dark:text-white">When they can be asked</h3>
          {availability.isPending ? (
            <ListSkeleton rows={1} lines={3} />
          ) : availability.isError ? (
            <ErrorState
              error={availability.error}
              onRetry={() => void availability.refetch()}
              what="their availability"
            />
          ) : (
            <>
              <p
                className={`mt-1 text-sm font-medium ${
                  draftEmpty ? 'text-green-700 dark:text-green-300' : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {draftEmpty
                  ? 'No hours set, so they can be asked about any request at any time. That is a setting, not a gap.'
                  : 'They will only be asked inside these hours. Clearing every row opens them up again.'}
              </p>

              <ul className="mt-3 space-y-2">
                {DAY_NAMES.map((name, day) => {
                  const ranges = draft[day] ?? [];
                  return (
                    <li key={name} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-900 dark:text-white">{name}</span>
                        {ranges.length === 0 ? (
                          <span className="text-xs text-slate-500 dark:text-slate-400">No hours set</span>
                        ) : null}
                      </div>
                      {ranges.map((range, index) => (
                        <div key={index} className="mt-2 flex flex-wrap items-center gap-2">
                          <label className="sr-only" htmlFor={`v-start-${day}-${index}`}>
                            {name} start time {index + 1}
                          </label>
                          <input
                            id={`v-start-${day}-${index}`}
                            type="time"
                            className={`${inputClass} w-auto flex-1 min-w-[7.5rem]`}
                            value={range.start}
                            onChange={(event) =>
                              updateDay(
                                day,
                                ranges.map((value, i) => (i === index ? { ...value, start: event.target.value } : value)),
                              )
                            }
                          />
                          <span className="text-sm text-slate-500 dark:text-slate-400">to</span>
                          <label className="sr-only" htmlFor={`v-end-${day}-${index}`}>
                            {name} end time {index + 1}
                          </label>
                          <input
                            id={`v-end-${day}-${index}`}
                            type="time"
                            className={`${inputClass} w-auto flex-1 min-w-[7.5rem]`}
                            value={range.end}
                            onChange={(event) =>
                              updateDay(
                                day,
                                ranges.map((value, i) => (i === index ? { ...value, end: event.target.value } : value)),
                              )
                            }
                          />
                          <button
                            type="button"
                            aria-label={`Remove this ${name} window`}
                            className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                            onClick={() => updateDay(day, ranges.filter((_, i) => i !== index))}
                          >
                            <Trash2 className="h-5 w-5" aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className={`${secondaryButtonClass} mt-2 w-full sm:w-auto`}
                        onClick={() => updateDay(day, [...ranges, { start: '09:00', end: '17:00' }])}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Add hours on {name}
                      </button>
                    </li>
                  );
                })}
              </ul>

              <button
                type="button"
                className={`${primaryButtonClass} mt-3`}
                disabled={saveAvailability.isPending}
                onClick={handleSaveAvailability}
              >
                {saveAvailability.isPending ? 'Saving…' : 'Save their hours'}
              </button>

              {availability.data.exceptions.length > 0 ? (
                <div className="mt-4">
                  <h4 className={labelClass}>Dates they have set aside</h4>
                  <ul className="space-y-1">
                    {availability.data.exceptions.map((exception) => (
                      <li key={exception.id} className="text-sm text-slate-600 dark:text-slate-400">
                        {exception.kind === 'available' ? 'Free' : 'Away'} · {formatDateTime(exception.startsAt)} to{' '}
                        {formatDateTime(exception.endsAt)}
                        {exception.reason ? ` · ${exception.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Dates are set by the volunteer on their own screen.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </section>

        <p className="text-xs text-slate-500 dark:text-slate-400">
          Every change here is recorded against your name, so a later &ldquo;I told you I was away&rdquo; is
          answerable.
        </p>
      </div>
    </Modal>
  );
}

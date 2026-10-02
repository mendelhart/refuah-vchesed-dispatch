import {
InlineSpinner,
cardClass,
panelClass,
secondaryButtonClass,tableWrapClass
} from '@/components/states';
import { api } from '@/lib/api';
import { formatDateTime,formatMinuteOfDay,formatPhone,telHref,titleCase } from '@/lib/format';
import { qk } from '@/lib/query';
import { useQueries } from '@tanstack/react-query';
import { Phone } from 'lucide-react';
import React,{ useMemo } from 'react';

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
  suspended_until: string | null;
  suspension_reason: string | null;
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

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The calendar asks each volunteer's availability separately, so it is capped
 *  rather than firing three hundred requests at a filter nobody narrowed. */
const CALENDAR_LIMIT = 40;

const chipClass =
  'inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200';

function isSnoozed(row: VolunteerRow): boolean {
  return Boolean(row.muted_until) && new Date(row.muted_until as string).getTime() > Date.now();
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

export function RosterTable({ rows, onOpen }: { rows: VolunteerRow[]; onOpen: (id: string) => void }): React.JSX.Element {
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
                  <p className="font-medium text-slate-900 dark:text-white">{row.full_name}{row.status === 'inactive' ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Paused</span> : null}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {row.volunteer_number ? `${row.volunteer_number} · ` : ''}
                    {row.phone ? (
                      <a className="underline" href={telHref(row.phone)}>
                        {formatPhone(row.phone)}
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

export function RosterCards({ rows, onOpen }: { rows: VolunteerRow[]; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <ul className="space-y-2 md:hidden">
      {rows.map((row) => {
        const availability = availabilityLabel(row);
        return (
          <li key={row.id} className={`${cardClass} p-4`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-slate-900 dark:text-white">{row.full_name}{row.status === 'inactive' ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Paused</span> : null}</p>
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
export function FortnightView({ rows }: { rows: VolunteerRow[] }): React.JSX.Element {
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
                  .map((window) => `${formatMinuteOfDay(window.startMinute)}–${formatMinuteOfDay(window.endMinute)}`)
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
          <p className="mt-2 text-sm font-medium text-[#C80023] dark:text-red-400">
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


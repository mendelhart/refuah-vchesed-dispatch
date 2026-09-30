
import { Modal } from '@/components/Modal';

import { ErrorState, ListSkeleton, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';
import { VolunteerActions } from '@/components/VolunteerActions';
import { api, errorMessage } from '@/lib/api';

import { channelOptions, channelShort } from '@/lib/channels';
import { formatDate, formatDateTime, formatPhone, relativeTime, telHref, titleCase } from '@/lib/format';
import { qk } from '@/lib/query';
import { VOLUNTEER_CAPABILITIES, roleLabel, type VolunteerCapability } from '@rvc/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Plus, Trash2 } from 'lucide-react';
import React,{ useEffect,useState } from 'react';
import { toast } from 'sonner';

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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
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

export function VolunteerDrawer({
  row,
  services,
  canManage,
  onClose,
}: {
  row: VolunteerRow;
  services: { slug: string; name: string }[];
  canManage: boolean;
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

  const saveChannel = useMutation({
    mutationFn: (value: string) => api.patch<unknown>(`/api/users/${row.id}`, { notificationPreference: value }),
    onSuccess: (_data, value) => {
      invalidate();
      toast.success(`${row.full_name} will be reached by ${channelShort(value)}.`);
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
            {roleLabel(row.role)} · {row.status === 'inactive' ? 'Paused' : titleCase(row.status)}
            {row.licence_status ? ` · licence ${titleCase(row.licence_status)}` : ''}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {row.phone ? (
              <a className={secondaryButtonClass} href={telHref(row.phone)}>
                <Phone className="h-4 w-4" aria-hidden="true" />
                {formatPhone(row.phone)}
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

        {canManage ? <VolunteerActions key={row.id} person={row} onRemoved={onClose} /> : null}

        <section>
          <label htmlFor={`reach-${row.id}`} className="font-semibold text-slate-900 dark:text-white">
            How we reach them
          </label>
          <select
            id={`reach-${row.id}`}
            className={`${inputClass} mt-2 sm:w-64`}
            value={row.notification_preference ?? 'sms'}
            disabled={saveChannel.isPending}
            onChange={(event) => saveChannel.mutate(event.target.value)}
          >
            {channelOptions(row.notification_preference).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Ride offers go this way. They can also change it in their own Settings.
          </p>
        </section>

        <section>
          <h3 className="font-semibold text-slate-900 dark:text-white">Services</h3>
          <ul className="mt-2 space-y-1">
            {services.map((service) => (
              <li key={service.slug}>
                <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    className="h-5 w-5 rounded border-slate-300 text-[#EA0029] focus:ring-[#EA0029] dark:border-slate-600 dark:bg-slate-800"
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
                      ? 'border-[#EA0029] bg-[#EA0029] text-white'
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

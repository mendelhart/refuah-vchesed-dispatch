/**
 * My availability.
 *
 * The rule that drives every word of copy here: a volunteer with no windows is
 * treated by the dispatch engine as available at all times, not as unavailable.
 * The legacy screen showed an empty week and people read it as "I am switched
 * off", so they either never touched it or set narrow hours defensively. Empty
 * has to read as "open to anything", and adding hours has to read as narrowing.
 *
 * Times are minutes from local midnight, so a window never shifts under a
 * volunteer when the clocks change.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarOff, Clock, Copy, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime } from '@/lib/format';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, InlineSpinner, ListSkeleton, PageHeader, cardClass, inputClass, labelClass,
  primaryButtonClass, secondaryButtonClass,
} from '@/components/states';

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

/** Sunday first, matching the server's weekday 0. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Monday's hours are copied here. Friday and Saturday are deliberately left alone. */
const COPY_TARGET_DAYS = [0, 2, 3, 4] as const;

interface Range {
  start: string;
  end: string;
}

/** An end of "00:00" means midnight at the end of that day, which is minute 1440. */
function timeToMinutes(value: string, isEnd: boolean): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (isEnd && minutes === 0) return 1440;
  return minutes;
}

function minutesToTime(minutes: number): string {
  const wrapped = minutes % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function windowsToDraft(windows: AvailabilityWindow[]): Range[][] {
  const draft: Range[][] = DAY_NAMES.map(() => []);
  for (const w of windows) {
    const day = draft[w.weekday];
    if (!day) continue;
    day.push({ start: minutesToTime(w.startMinute), end: minutesToTime(w.endMinute) });
  }
  return draft;
}

export function MyAvailabilityPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Range[][]>(() => DAY_NAMES.map(() => []));
  const [baseline, setBaseline] = useState<string | null>(null);
  const seededFrom = useRef<string | null>(null);
  const [exceptionOpen, setExceptionOpen] = useState(false);

  const availability = useQuery({
    queryKey: qk.meExtras.availability(),
    queryFn: () => api.get<AvailabilityResponse>('/api/me/availability'),
  });

  // Seed the editable copy once per server payload. Keyed on the serialised
  // windows so a background refetch that changed nothing does not wipe an edit
  // in progress, while a real change from another device does land.
  const serverWindows = availability.data?.windows;
  useEffect(() => {
    if (!serverWindows) return;
    const signature = JSON.stringify(serverWindows);
    if (seededFrom.current === signature) return;
    seededFrom.current = signature;
    const seeded = windowsToDraft(serverWindows);
    setDraft(seeded);
    setBaseline(JSON.stringify(seeded));
  }, [serverWindows]);

  const save = useMutation({
    mutationFn: (windows: AvailabilityWindow[]) =>
      api.put<{ windows: AvailabilityWindow[]; unrestricted: boolean }>('/api/me/availability', { windows }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: qk.meExtras.availability() });
      toast.success(
        data.unrestricted
          ? 'Saved. With no hours set you can be asked about any request.'
          : 'Saved. We will only ask you inside those hours.',
      );
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const addException = useMutation({
    mutationFn: (body: { kind: string; startsAt: string; endsAt: string; reason?: string }) =>
      api.post<{ exception: AvailabilityException }>('/api/me/availability/exceptions', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.meExtras.availability() });
      setExceptionOpen(false);
      toast.success('Added to your time off.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const removeException = useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/me/availability/exceptions/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.meExtras.availability() });
      toast.success('Removed.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const draftIsEmpty = useMemo(() => draft.every((ranges) => ranges.length === 0), [draft]);
  const dirty = useMemo(() => baseline !== null && JSON.stringify(draft) !== baseline, [draft, baseline]);

  const updateDay = (day: number, next: Range[]): void => {
    setDraft((current) => current.map((ranges, index) => (index === day ? next : ranges)));
  };

  const handleAddRange = (day: number): void => {
    updateDay(day, [...(draft[day] ?? []), { start: '09:00', end: '17:00' }]);
  };

  const handleRemoveRange = (day: number, index: number): void => {
    updateDay(day, (draft[day] ?? []).filter((_, i) => i !== index));
  };

  const handleChangeRange = (day: number, index: number, field: keyof Range, value: string): void => {
    updateDay(day, (draft[day] ?? []).map((range, i) => (i === index ? { ...range, [field]: value } : range)));
  };

  const handleCopyMonday = (): void => {
    setDraft((current) => {
      const monday = current[1] ?? [];
      return current.map((ranges, index) =>
        (COPY_TARGET_DAYS as readonly number[]).includes(index) ? monday.map((range) => ({ ...range })) : ranges,
      );
    });
    toast.success('Copied Monday to Sunday, Tuesday, Wednesday and Thursday.');
  };

  const handleSave = (): void => {
    const windows: AvailabilityWindow[] = [];
    for (let day = 0; day < DAY_NAMES.length; day += 1) {
      for (const range of draft[day] ?? []) {
        const startMinute = timeToMinutes(range.start, false);
        const endMinute = timeToMinutes(range.end, true);
        if (startMinute === null || endMinute === null) {
          toast.error(`Fill in both times on ${DAY_NAMES[day]}.`);
          return;
        }
        if (endMinute <= startMinute) {
          toast.error(
            `On ${DAY_NAMES[day]}, the end time has to be after the start time. For overnight hours, end this day at 00:00 and add the rest to the next day starting 00:00.`,
          );
          return;
        }
        windows.push({ weekday: day, startMinute, endMinute });
      }
    }
    save.mutate(windows);
  };

  if (availability.isPending) return <ListSkeleton rows={4} lines={3} />;
  if (availability.isError) {
    return (
      <ErrorState error={availability.error} onRetry={() => void availability.refetch()} what="your availability" />
    );
  }

  const { exceptions } = availability.data;
  const now = Date.now();

  return (
    <div className="space-y-6">
      <PageHeader
        title="My availability"
        subtitle="This is the setting that decides which requests reach you"
        actions={
          <button type="button" className={primaryButtonClass} disabled={!dirty || save.isPending} onClick={handleSave}>
            {save.isPending ? 'Saving…' : 'Save hours'}
          </button>
        }
      />

      {draftIsEmpty ? (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-900/50 dark:bg-blue-950/30">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
            <Clock className="h-5 w-5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            You are open to anything right now
          </h2>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            You have no hours set, so you can be asked about any request, on any day, at any hour. Nothing is switched
            off and plenty of volunteers leave it exactly like this.
          </p>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            Adding hours below narrows that down: once there is even one window on the week, we will only ask you
            inside the hours you have set. For a one-off week away, use time off further down instead.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
            <Clock className="h-5 w-5 text-[#EA0029]" aria-hidden="true" />
            We will only ask you inside these hours
          </h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            Outside them you will not be offered a ride. Clear every row if you would rather be asked at any time.
          </p>
        </div>
      )}

      <section className={cardClass}>
        <div className="space-y-4 p-5 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Your usual week</h2>
            <button type="button" className={secondaryButtonClass} onClick={handleCopyMonday}>
              <Copy className="h-4 w-4" aria-hidden="true" />
              Copy Monday to the rest of the week
            </button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Copying puts Monday&rsquo;s hours on Sunday, Tuesday, Wednesday and Thursday. Friday and Saturday are left
            as they are. An end time of 00:00 means midnight at the end of that day. For overnight hours (say 22:00–02:00), add 22:00–00:00 on the first day and 00:00–02:00 on the next.
          </p>

          <ul className="space-y-3">
            {DAY_NAMES.map((name, day) => {
              const ranges = draft[day] ?? [];
              return (
                <li
                  key={name}
                  className="rounded-xl border border-slate-200 p-4 dark:border-slate-700"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-900 dark:text-white">{name}</span>
                    {ranges.length === 0 ? (
                      <span className="text-xs text-slate-500 dark:text-slate-400">No hours set</span>
                    ) : null}
                  </div>

                  {ranges.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      {ranges.map((range, index) => (
                        <div key={index} className="flex flex-wrap items-center gap-2">
                          <label className="sr-only" htmlFor={`start-${day}-${index}`}>
                            {name} start time {index + 1}
                          </label>
                          <input
                            id={`start-${day}-${index}`}
                            type="time"
                            className={`${inputClass} w-auto flex-1 min-w-[7.5rem]`}
                            value={range.start}
                            onChange={(event) => handleChangeRange(day, index, 'start', event.target.value)}
                          />
                          <span className="text-sm text-slate-500 dark:text-slate-400">to</span>
                          <label className="sr-only" htmlFor={`end-${day}-${index}`}>
                            {name} end time {index + 1}
                          </label>
                          <input
                            id={`end-${day}-${index}`}
                            type="time"
                            className={`${inputClass} w-auto flex-1 min-w-[7.5rem]`}
                            value={range.end}
                            onChange={(event) => handleChangeRange(day, index, 'end', event.target.value)}
                          />
                          <button
                            type="button"
                            aria-label={`Remove this ${name} window`}
                            className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                            onClick={() => handleRemoveRange(day, index)}
                          >
                            <Trash2 className="h-5 w-5" aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className={`${secondaryButtonClass} mt-3 w-full sm:w-auto`}
                    onClick={() => handleAddRange(day)}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Add hours on {name}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
            <button type="button" className={primaryButtonClass} disabled={!dirty || save.isPending} onClick={handleSave}>
              {save.isPending ? 'Saving…' : 'Save hours'}
            </button>
            {dirty && !save.isPending ? (
              <span className="text-sm text-slate-500 dark:text-slate-400">You have changes that are not saved yet.</span>
            ) : null}
            {save.isPending ? <InlineSpinner label="Saving your week" /> : null}
          </div>
        </div>
      </section>

      <section className={cardClass}>
        <div className="space-y-4 p-5 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Time off</h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                For dates rather than a pattern: going away, a simcha, a stay in hospital. You can also mark a stretch
                when you are free even though it falls outside your usual hours.
              </p>
            </div>
            <button type="button" className={secondaryButtonClass} onClick={() => setExceptionOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add dates
            </button>
          </div>

          {exceptions.length === 0 ? (
            <EmptyState
              title="No dates set aside."
              hint="Add the dates you are away and we will not ask you about a ride that falls inside them."
              icon={CalendarOff}
            />
          ) : (
            <ul className="space-y-2">
              {exceptions.map((exception) => {
                const finished = new Date(exception.endsAt).getTime() < now;
                return (
                  <li
                    key={exception.id}
                    className="flex min-h-[44px] flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3 dark:bg-slate-800/60"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        {exception.kind === 'available' ? 'Free' : 'Away'} · {formatDateTime(exception.startsAt)} to{' '}
                        {formatDateTime(exception.endsAt)}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {exception.reason ? `${exception.reason} · ` : ''}
                        {finished ? 'Finished' : 'Upcoming or running now'}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      disabled={removeException.isPending}
                      onClick={() => removeException.mutate(exception.id)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <ExceptionModal
        open={exceptionOpen}
        busy={addException.isPending}
        onClose={() => setExceptionOpen(false)}
        onSubmit={(body) => addException.mutate(body)}
      />
    </div>
  );
}

function ExceptionModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { kind: string; startsAt: string; endsAt: string; reason?: string }) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<'unavailable' | 'available'>('unavailable');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) return;
    setKind('unavailable');
    setStartsAt('');
    setEndsAt('');
    setReason('');
  }, [open]);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      toast.error('Fill in both the start and the end.');
      return;
    }
    if (end <= start) {
      toast.error('The end has to be after the start.');
      return;
    }
    onSubmit({
      kind,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  return (
    <Modal open={open} title="Add dates" onClose={onClose}>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="exception-kind" className={labelClass}>
            What are these dates?
          </label>
          <select
            id="exception-kind"
            className={inputClass}
            value={kind}
            onChange={(event) => setKind(event.target.value as 'unavailable' | 'available')}
          >
            <option value="unavailable">I am away, do not ask me</option>
            <option value="available">I am free, ask me even outside my usual hours</option>
          </select>
        </div>
        <div>
          <label htmlFor="exception-start" className={labelClass}>
            From
          </label>
          <input
            id="exception-start"
            type="datetime-local"
            className={inputClass}
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="exception-end" className={labelClass}>
            Until
          </label>
          <input
            id="exception-end"
            type="datetime-local"
            className={inputClass}
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="exception-reason" className={labelClass}>
            Reason (optional)
          </label>
          <input
            id="exception-reason"
            className={inputClass}
            value={reason}
            maxLength={200}
            placeholder="Away for a wedding"
            onChange={(event) => setReason(event.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Only a coordinator sees this, and only so they know not to chase you.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryButtonClass} disabled={busy}>
            {busy ? 'Adding…' : 'Add dates'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

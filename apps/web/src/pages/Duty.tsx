/**
 * The duty roster: who is answering the phone.
 *
 * The banner at the top is the reason this screen exists. In the legacy system
 * "who is on tonight" lived in a WhatsApp thread, which produced both failure
 * modes — two people answering, and nobody answering. Here the name and a
 * tappable number are the first thing on the page, on every device.
 *
 * Overlaps are refused by a database constraint, and the message that comes
 * back names the person already rostered. That sentence is far more useful than
 * anything this screen could invent, so it is shown exactly as sent.
 */
import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarDays, ChevronLeft, ChevronRight, Phone, Plus, Trash2 } from 'lucide-react';
import { DUTY_KINDS, type DutyKind } from '@rvc/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime, formatTime, telHref, titleCase } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, inputClass, labelClass, panelClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';
import type { UserListResponse } from '@/types/api';

interface DutyShift {
  id: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  userId: string;
  fullName: string;
  phone: string | null;
}

interface OnDutyNow {
  id: string;
  userId: string;
  fullName: string;
  phone: string | null;
  startsAt: string;
  endsAt: string;
}

interface DutyResponse {
  shifts: DutyShift[];
  onDutyNow: OnDutyNow | null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const KIND_CLASSES: Record<string, string> = {
  phone: 'bg-[#E31E24] text-white',
  dispatcher: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  backup: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

/** Local midnight on the Sunday of the week `offset` weeks from today. */
function weekStart(offset: number): Date {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay() + offset * 7);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** `datetime-local` wants local wall time, never an ISO instant. */
function toLocalInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function DutyPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { hasRole } = useAuth();
  const canEdit = hasRole(['dispatcher', 'admin']);
  const [weekOffset, setWeekOffset] = useState(0);
  const [kindFilter, setKindFilter] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addDefaults, setAddDefaults] = useState<{ startsAt: string; endsAt: string }>({ startsAt: '', endsAt: '' });
  const [clashMessage, setClashMessage] = useState<string | null>(null);

  const start = weekStart(weekOffset);
  const end = addDays(start, 7);
  const params = {
    from: start.toISOString(),
    to: end.toISOString(),
    ...(kindFilter ? { kind: kindFilter } : {}),
  };

  const duty = useQuery({
    queryKey: qk.duty.list(params),
    queryFn: () => api.get<DutyResponse>('/api/duty', params),
  });

  const create = useMutation({
    mutationFn: (body: { kind: DutyKind; userId: string; startsAt: string; endsAt: string; notes?: string }) =>
      api.post<{ shift: DutyShift }>('/api/duty', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.duty.all() });
      setAddOpen(false);
      setClashMessage(null);
      toast.success('Shift added.');
    },
    onError: (error: unknown) => {
      // The clash message names who is already on. Keep it on screen, not in a
      // toast that vanishes while the dispatcher is still fixing the times.
      if (error instanceof ApiError && error.isConflict) setClashMessage(error.message);
      else setClashMessage(null);
      toast.error(errorMessage(error));
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/api/duty/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.duty.all() });
      toast.success('Shift removed.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const openAdd = (day?: Date): void => {
    const base = day ?? new Date();
    const startsAt = new Date(base);
    startsAt.setHours(9, 0, 0, 0);
    const endsAt = new Date(base);
    endsAt.setHours(17, 0, 0, 0);
    setAddDefaults({ startsAt: toLocalInput(startsAt), endsAt: toLocalInput(endsAt) });
    setClashMessage(null);
    setAddOpen(true);
  };

  const shifts = duty.data?.shifts ?? [];
  const onDutyNow = duty.data?.onDutyNow ?? null;

  const days = Array.from({ length: 7 }, (_, index) => {
    const dayStart = addDays(start, index);
    const dayEnd = addDays(start, index + 1);
    return {
      date: dayStart,
      // A shift counts for a day if any part of it falls inside that day.
      shifts: shifts.filter(
        (shift) => new Date(shift.startsAt) < dayEnd && new Date(shift.endsAt) > dayStart,
      ),
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Duty roster"
        subtitle="Who is on the phone, and when"
        actions={
          canEdit ? (
            <button type="button" className={primaryButtonClass} onClick={() => openAdd()}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add a shift
            </button>
          ) : undefined
        }
      />

      {duty.isPending ? (
        <ListSkeleton rows={1} lines={2} />
      ) : onDutyNow ? (
        <section className="rounded-xl border border-green-300 bg-green-50 p-5 dark:border-green-800 dark:bg-green-950/30">
          <p className="text-xs font-semibold uppercase tracking-wide text-green-800 dark:text-green-300">
            On the phone now
          </p>
          <p className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">{onDutyNow.fullName}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Until {formatDateTime(onDutyNow.endsAt)}
          </p>
          {onDutyNow.phone ? (
            <a
              className={`${primaryButtonClass} mt-3 w-full sm:w-auto`}
              href={telHref(onDutyNow.phone)}
            >
              <Phone className="h-4 w-4" aria-hidden="true" />
              Call {onDutyNow.phone}
            </a>
          ) : (
            <p className="mt-3 text-sm font-medium text-[#E31E24]">
              No phone number on file for them, which rather defeats the point. Add one on their record.
            </p>
          )}
        </section>
      ) : (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="font-semibold text-amber-900 dark:text-amber-200">Nobody is on the phone right now.</p>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            Calls to the organisation line are not being answered by anybody this system knows about.
          </p>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous week"
            className={secondaryButtonClass}
            onClick={() => setWeekOffset((current) => current - 1)}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" className={secondaryButtonClass} onClick={() => setWeekOffset(0)}>
            This week
          </button>
          <button
            type="button"
            aria-label="Next week"
            className={secondaryButtonClass}
            onClick={() => setWeekOffset((current) => current + 1)}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {start.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} to{' '}
          {addDays(start, 6).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
        <select
          className={`${inputClass} sm:w-48`}
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value)}
          aria-label="Filter by kind of duty"
        >
          <option value="">All kinds</option>
          {DUTY_KINDS.map((value) => (
            <option key={value} value={value}>
              {titleCase(value)}
            </option>
          ))}
        </select>
      </div>

      {duty.isPending ? (
        <ListSkeleton rows={4} lines={2} />
      ) : duty.isError ? (
        <ErrorState error={duty.error} onRetry={() => void duty.refetch()} what="the roster" />
      ) : shifts.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No shifts this week."
          hint={canEdit ? 'Add one so the line has somebody on it.' : 'A dispatcher can add shifts to this week.'}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-7">
          {days.map((day) => (
            <section key={day.date.toISOString()} className={`${panelClass} min-w-0`}>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                {DAY_NAMES[day.date.getDay()]}
                <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">
                  {day.date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}
                </span>
              </h2>
              {day.shifts.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Nobody on.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {day.shifts.map((shift) => (
                    <li
                      key={`${day.date.toISOString()}-${shift.id}`}
                      className="rounded-lg border border-slate-200 p-2 dark:border-slate-700"
                    >
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          KIND_CLASSES[shift.kind] ?? KIND_CLASSES.backup
                        }`}
                      >
                        {titleCase(shift.kind)}
                      </span>
                      <p className="mt-1 break-words text-sm font-medium text-slate-900 dark:text-white">
                        {shift.fullName}
                      </p>
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        {formatTime(shift.startsAt)} to {formatTime(shift.endsAt)}
                      </p>
                      {shift.phone ? (
                        <a
                          className="mt-1 inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-[#E31E24] underline"
                          href={telHref(shift.phone)}
                        >
                          <Phone className="h-3 w-3" aria-hidden="true" />
                          {shift.phone}
                        </a>
                      ) : null}
                      {shift.notes ? (
                        <p className="mt-1 break-words text-xs text-slate-500 dark:text-slate-400">{shift.notes}</p>
                      ) : null}
                      {canEdit ? (
                        <button
                          type="button"
                          className="mt-1 inline-flex min-h-[44px] items-center gap-1 text-xs font-medium text-slate-600 hover:text-[#E31E24] dark:text-slate-400"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm(`Take ${shift.fullName} off this shift?`)) remove.mutate(shift.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          Remove
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit ? (
                <button
                  type="button"
                  className={`${secondaryButtonClass} mt-2 w-full text-xs`}
                  onClick={() => openAdd(day.date)}
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Add
                </button>
              ) : null}
            </section>
          ))}
        </div>
      )}

      {canEdit ? (
        <AddShiftModal
          open={addOpen}
          busy={create.isPending}
          defaults={addDefaults}
          clashMessage={clashMessage}
          onClose={() => {
            setAddOpen(false);
            setClashMessage(null);
          }}
          onSubmit={(body) => create.mutate(body)}
        />
      ) : null}
    </div>
  );
}

function AddShiftModal({
  open,
  busy,
  defaults,
  clashMessage,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  defaults: { startsAt: string; endsAt: string };
  clashMessage: string | null;
  onClose: () => void;
  onSubmit: (body: { kind: DutyKind; userId: string; startsAt: string; endsAt: string; notes?: string }) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<DutyKind>('phone');
  const [userId, setUserId] = useState('');
  const [startsAt, setStartsAt] = useState(defaults.startsAt);
  const [endsAt, setEndsAt] = useState(defaults.endsAt);
  const [notes, setNotes] = useState('');

  // Reseed the times whenever the modal is opened from a different day.
  useEffect(() => {
    if (!open) return;
    setStartsAt(defaults.startsAt);
    setEndsAt(defaults.endsAt);
  }, [open, defaults.startsAt, defaults.endsAt]);

  const people = useQuery({
    queryKey: qk.people.list({ status: 'active' }),
    queryFn: () => api.get<UserListResponse>('/api/users', { status: 'active', limit: 500 }),
    enabled: open,
  });

  return (
    <Modal open={open} title="Add a shift" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const start = new Date(startsAt);
          const end = new Date(endsAt);
          if (!userId) {
            toast.error('Choose who is on.');
            return;
          }
          if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            toast.error('Fill in both the start and the end.');
            return;
          }
          if (end <= start) {
            toast.error('The shift has to end after it starts.');
            return;
          }
          onSubmit({
            kind,
            userId,
            startsAt: start.toISOString(),
            endsAt: end.toISOString(),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          });
        }}
      >
        {clashMessage ? (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-slate-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-white">
            {clashMessage}
          </p>
        ) : null}

        <div>
          <label htmlFor="duty-kind" className={labelClass}>
            Kind of duty
          </label>
          <select
            id="duty-kind"
            className={inputClass}
            value={kind}
            onChange={(event) => setKind(event.target.value as DutyKind)}
          >
            {DUTY_KINDS.map((value) => (
              <option key={value} value={value}>
                {titleCase(value)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="duty-person" className={labelClass}>
            Who is on
          </label>
          {people.isPending ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Loading people…</p>
          ) : people.isError ? (
            <p className="text-sm text-[#E31E24]">{errorMessage(people.error)}</p>
          ) : (
            <select
              id="duty-person"
              className={inputClass}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            >
              <option value="">Choose somebody</option>
              {people.data.users.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.fullName}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="duty-start" className={labelClass}>
              From
            </label>
            <input
              id="duty-start"
              type="datetime-local"
              className={inputClass}
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="duty-end" className={labelClass}>
              Until
            </label>
            <input
              id="duty-end"
              type="datetime-local"
              className={inputClass}
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <label htmlFor="duty-notes" className={labelClass}>
            Notes (optional)
          </label>
          <input
            id="duty-notes"
            className={inputClass}
            maxLength={300}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Reachable on the house line after 9"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryButtonClass} disabled={busy}>
            {busy ? 'Adding…' : 'Add the shift'}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

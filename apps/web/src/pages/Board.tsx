/**
 * Dispatcher board.
 *
 * Replaces the old flat list of every trip in one column — at 200 open trips
 * that screen was unusable and the thing you needed (who still has no driver)
 * was somewhere in the middle of it.
 *
 * Here the board is segmented, and within a segment trips are grouped by
 * urgency and sorted by pickup time, so the top of the screen is always the
 * work that cannot wait.
 *
 * Three things sit around the list. The context strip at the top answers the
 * questions a dispatcher otherwise asks out loud — what is today, when does
 * Shabbos come in, who has the phone, what is waiting elsewhere. The rest-period
 * marker on a row says when a pickup falls inside Shabbos or yom tov; it is a
 * label, never a block, because a ride during Shabbos is precisely what this
 * organisation exists for. And the bulk bar lets one person move a morning's
 * worth of rides at once — reporting each failure by name, because a bulk
 * action that says "done" while having quietly skipped three is worse than no
 * bulk action at all.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertOctagon, CalendarDays, Car, CheckCircle2, ClipboardList, Flame, MessageSquare, Package, Phone, Plus, Search,
  Send, UserCheck, X,
} from 'lucide-react';
import type { TripDto, TripStatus } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { invalidateTrips, qk, type TripListParams } from '@/lib/query';
import { formatDateTime, formatTime, priorityRank, telHref } from '@/lib/format';
import { isFullTrip, type BoardSummaryResponse, type TripListResponse, type UserListResponse } from '@/types/api';
import { TripCard } from '@/components/TripCard';
import { TripForm } from '@/components/TripForm';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, InlineSpinner, ListSkeleton, PageHeader, inputClass, labelClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';
import { cn } from '@/lib/utils';

interface Segment {
  id: string;
  label: string;
  status?: readonly TripStatus[];
  history?: boolean;
  todayOnly?: boolean;
  empty: { title: string; hint?: string };
}

/** Shapes from `GET /api/board/context`. Declared here because this strip is
 *  the only consumer and the endpoint composes them from five services. */
interface RestPeriod {
  startsAt: string;
  endsAt: string;
  label: string;
  kind: string;
}
interface BoardContextResponse {
  onDutyNow: { userId: string; fullName: string; phone: string | null; startsAt: string; endsAt: string } | null;
  unreadConversations: number;
  applications: Record<string, number>;
  overdueEquipment: number;
  restPeriods: RestPeriod[];
  hebrewToday: {
    date: string;
    hebrewDate: string;
    hebrewDateHe: string;
    parsha: string | null;
    holidays: string[];
    isRoshChodesh: boolean;
    isFastDay: boolean;
    isYomTov: boolean;
    candleLighting: string | null;
    havdalah: string | null;
  } | null;
  zmanim: { sunset: string | null; tzeit: string | null } | null;
}

interface BulkResultRow {
  tripId: string;
  ok: boolean;
  offered?: number;
  error?: string;
}
interface BulkResponse {
  results: BulkResultRow[];
  assigned?: number;
  offered?: number;
  failed: number;
}

const SEGMENTS: Segment[] = [
  {
    id: 'needs-driver',
    label: 'Needs driver',
    status: ['new', 'pending', 'expired'],
    empty: { title: 'Every ride has a driver right now.', hint: 'New requests will appear here the moment they come in.' },
  },
  {
    id: 'offered',
    label: 'Offered',
    status: ['offered'],
    empty: { title: 'Nothing is out with volunteers right now.', hint: 'Offer a ride from the "Needs driver" tab to start the clock.' },
  },
  {
    id: 'assigned',
    label: 'Assigned',
    status: ['assigned', 'accepted'],
    empty: { title: 'No rides are waiting to start.', hint: 'Accepted rides land here until the volunteer sets off.' },
  },
  {
    id: 'in-progress',
    label: 'In progress',
    status: ['en_route', 'in_progress'],
    empty: { title: 'Nobody is on the road at the moment.' },
  },
  {
    id: 'today',
    label: 'Today',
    todayOnly: true,
    empty: { title: 'Nothing else is scheduled for today.' },
  },
  {
    id: 'completed',
    label: 'Completed',
    status: ['completed'],
    history: true,
    empty: { title: 'No completed rides yet.', hint: 'Rides land here when the volunteer marks one done.' },
  },
  {
    id: 'all',
    label: 'All open',
    empty: { title: 'The board is clear.', hint: 'Every open ride is handled.' },
  },
];

function dayBounds(): { from: string; to: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

const chipClass =
  'inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200';

/**
 * The strip above the board.
 *
 * Everything here is context, not work, so a failure renders nothing at all:
 * an error banner about the Hebrew date would push the actual rides down the
 * screen to tell a dispatcher something they did not ask for.
 */
function BoardContextStrip(): React.JSX.Element | null {
  const context = useQuery({
    queryKey: qk.board.context(),
    queryFn: () => api.get<BoardContextResponse>('/api/board/context'),
    retry: false,
  });

  const data = context.data;
  if (!data) return null;

  const now = Date.now();
  const nextRest = data.restPeriods.find((period) => new Date(period.endsAt).getTime() > now) ?? null;
  const waitingApplications = (data.applications.submitted ?? 0) + (data.applications.info_requested ?? 0);
  const hebrew = data.hebrewToday;

  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <div className="flex w-max items-stretch gap-2 pb-1 lg:w-full lg:flex-wrap">
        {hebrew ? (
          <span className={chipClass}>
            <CalendarDays className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
            <span>
              <span className="font-medium text-slate-900 dark:text-white">{hebrew.hebrewDate}</span>
              {hebrew.parsha ? (
                <span className="block text-xs text-slate-500 dark:text-slate-400">{hebrew.parsha}</span>
              ) : hebrew.holidays.length > 0 ? (
                <span className="block text-xs text-slate-500 dark:text-slate-400">{hebrew.holidays.join(' · ')}</span>
              ) : null}
            </span>
          </span>
        ) : null}

        {nextRest ? (
          <span className={chipClass}>
            <Flame className="h-4 w-4 flex-shrink-0 text-amber-500" aria-hidden="true" />
            <span>
              <span className="font-medium text-slate-900 dark:text-white">{nextRest.label}</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                Candles {formatDateTime(nextRest.startsAt)} · out {formatTime(nextRest.endsAt)}
              </span>
            </span>
          </span>
        ) : null}

        <span className={chipClass}>
          <Phone className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
          {data.onDutyNow ? (
            <span>
              <span className="font-medium text-slate-900 dark:text-white">{data.onDutyNow.fullName}</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                on the phone until {formatTime(data.onDutyNow.endsAt)}
              </span>
            </span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">Nobody is on the phone right now</span>
          )}
        </span>
        {data.onDutyNow?.phone ? (
          <a className={`${chipClass} font-medium text-[#E31E24]`} href={telHref(data.onDutyNow.phone)}>
            <Phone className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            {data.onDutyNow.phone}
          </a>
        ) : null}

        <Link className={chipClass} to="/messages">
          <MessageSquare className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
          <span className="font-medium text-slate-900 dark:text-white">{data.unreadConversations}</span>
          unread
        </Link>
        <Link className={chipClass} to="/admin/applications">
          <ClipboardList className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
          <span className="font-medium text-slate-900 dark:text-white">{waitingApplications}</span>
          waiting
        </Link>
        <Link className={chipClass} to="/equipment">
          <Package className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
          <span className="font-medium text-slate-900 dark:text-white">{data.overdueEquipment}</span>
          overdue
        </Link>
      </div>
    </div>
  );
}

export function BoardPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [segmentId, setSegmentId] = useState(SEGMENTS[0]!.id);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(params.get('new') === '1');
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkDialog, setBulkDialog] = useState<'assign' | 'offer' | null>(null);
  const [bulkVolunteerId, setBulkVolunteerId] = useState('');
  const [bulkReason, setBulkReason] = useState('');
  const [bulkMinutes, setBulkMinutes] = useState('');
  const [bulkResult, setBulkResult] = useState<{ kind: 'assign' | 'offer'; response: BulkResponse } | null>(null);

  // Search hits the server: a client-side filter over one page of results
  // silently hides matches that are not in the page, which is how the old
  // screen "lost" trips people knew existed.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (params.get('new') === '1') {
      setFormOpen(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  // A selection that survives a change of segment would act on trips that are
  // no longer on screen.
  useEffect(() => {
    setSelected([]);
  }, [segmentId, search]);

  const segment = SEGMENTS.find((item) => item.id === segmentId) ?? SEGMENTS[0]!;

  const listParams = useMemo<TripListParams>(() => {
    const bounds = segment.todayOnly ? dayBounds() : null;
    return {
      scope: segment.history ? ('history' as const) : ('board' as const),
      ...(segment.status ? { status: segment.status } : {}),
      ...(search ? { search } : {}),
      ...(bounds ? { from: bounds.from, to: bounds.to } : {}),
      limit: 100,
    };
  }, [segment, search]);

  const summary = useQuery({
    queryKey: qk.trips.summary(),
    queryFn: () => api.get<BoardSummaryResponse>('/api/trips/summary'),
  });

  const trips = useQuery({
    queryKey: qk.trips.list(listParams),
    queryFn: () =>
      api.get<TripListResponse>('/api/trips', {
        scope: segment.history ? 'history' : 'board',
        ...(listParams.status ? { status: [...listParams.status] } : {}),
        ...(listParams.search ? { search: listParams.search } : {}),
        ...(listParams.from ? { from: listParams.from } : {}),
        ...(listParams.to ? { to: listParams.to } : {}),
        limit: 100,
      }),
  });

  // Rest periods are read here too so a row can be marked; the strip's copy is
  // the same cached query, not a second request.
  const context = useQuery({
    queryKey: qk.board.context(),
    queryFn: () => api.get<BoardContextResponse>('/api/board/context'),
    retry: false,
  });
  const restPeriods = context.data?.restPeriods ?? [];

  const volunteers = useQuery({
    queryKey: qk.people.list({ role: 'volunteer' }),
    queryFn: () => api.get<UserListResponse>('/api/users', { role: 'volunteer', limit: 200 }),
    enabled: bulkDialog === 'assign',
  });

  const grouped = useMemo(() => {
    const items = (trips.data?.items ?? []).filter(isFullTrip);
    const sorted = [...items].sort((a, b) => {
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
      if (byPriority !== 0) return byPriority;
      return new Date(a.pickupAt).getTime() - new Date(b.pickupAt).getTime();
    });
    return {
      all: sorted,
      needsAttention: sorted.filter((trip) => trip.isOverdue || trip.priority === 'emergency'),
      urgent: sorted.filter((trip) => !trip.isOverdue && trip.priority === 'urgent'),
      scheduled: sorted.filter((trip) => !trip.isOverdue && trip.priority === 'routine'),
      total: sorted.length,
    };
  }, [trips.data]);

  const referenceOf = (tripId: string): string =>
    grouped.all.find((trip) => trip.id === tripId)?.reference ?? tripId.slice(0, 8);

  const restPeriodFor = (pickupAt: string): RestPeriod | null => {
    const at = new Date(pickupAt).getTime();
    if (Number.isNaN(at)) return null;
    return (
      restPeriods.find(
        (period) => at >= new Date(period.startsAt).getTime() && at <= new Date(period.endsAt).getTime(),
      ) ?? null
    );
  };

  const toggleSelected = (tripId: string): void => {
    setSelected((current) =>
      current.includes(tripId) ? current.filter((id) => id !== tripId) : [...current, tripId],
    );
  };

  const closeBulk = (): void => {
    setBulkDialog(null);
    setBulkVolunteerId('');
    setBulkReason('');
    setBulkMinutes('');
    setBulkResult(null);
  };

  const bulkMutation = useMutation({
    mutationFn: async (kind: 'assign' | 'offer'): Promise<{ kind: 'assign' | 'offer'; response: BulkResponse }> => {
      const response =
        kind === 'assign'
          ? await api.post<BulkResponse>('/api/trips/bulk/assign', {
              tripIds: selected,
              volunteerId: bulkVolunteerId,
              ...(bulkReason.trim() ? { reason: bulkReason.trim() } : {}),
            })
          : await api.post<BulkResponse>('/api/trips/bulk/offer', {
              tripIds: selected,
              ...(bulkMinutes ? { expiresInMinutes: Number(bulkMinutes) } : {}),
            });
      return { kind, response };
    },
    onSuccess: ({ kind, response }) => {
      invalidateTrips(queryClient);
      setBulkResult({ kind, response });
      // Whatever went through is done; what failed stays selected so the next
      // attempt acts on exactly the rides that still need it.
      const failedIds = response.results.filter((row) => !row.ok).map((row) => row.tripId);
      setSelected(failedIds);
      const succeeded = response.results.length - response.failed;
      if (response.failed === 0) {
        toast.success(kind === 'assign' ? `${succeeded} assigned.` : `${succeeded} offered.`);
      } else {
        toast.error(`${response.failed} of ${response.results.length} did not go through — see the list.`);
      }
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const stats = summary.data;

  const renderRow = (trip: TripDto): React.JSX.Element => {
    const rest = restPeriodFor(trip.pickupAt);
    const checked = selected.includes(trip.id);
    return (
      <div key={trip.id} className="flex items-start gap-2">
        <label className="grid min-h-[44px] min-w-[44px] flex-shrink-0 cursor-pointer place-items-center rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[#E31E24]"
            checked={checked}
            onChange={() => toggleSelected(trip.id)}
            aria-label={`Select ride ${trip.reference} for a bulk action`}
          />
        </label>
        <div className="min-w-0 flex-1">
          {rest ? (
            <p className="mb-1 inline-flex flex-wrap items-center gap-2 rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200">
              <Flame className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              During {rest.label}
              <span className="font-normal text-indigo-600 dark:text-indigo-300">
                ({formatTime(rest.startsAt)} – {formatTime(rest.endsAt)})
              </span>
            </p>
          ) : null}
          <TripCard trip={trip} />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dispatch board"
        subtitle="Open rides, most urgent first"
        actions={
          <button type="button" className={primaryButtonClass} onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New trip
          </button>
        }
      />

      <BoardContextStrip />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: 'Needs attention', value: stats?.needsAttention, accent: 'text-[#E31E24]' },
          { label: 'Offered', value: stats?.offered },
          { label: 'Assigned', value: stats?.assigned },
          { label: 'In progress', value: stats?.inProgress },
          { label: 'Overdue', value: stats?.overdue, accent: 'text-[#E31E24]' },
          { label: 'Unanswered', value: stats?.unanswered, accent: 'text-amber-600 dark:text-amber-400' },
        ].map((tile) => (
          <div
            key={tile.label}
            className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
          >
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{tile.label}</p>
            <p className={cn('mt-1 text-2xl font-bold text-slate-900 dark:text-white', tile.accent)}>
              {summary.isPending ? '–' : (tile.value ?? 0)}
            </p>
          </div>
        ))}
      </div>
      {summary.isError ? (
        <p className="text-sm text-[#E31E24]">
          The summary counts did not load.{' '}
          <button type="button" className="underline" onClick={() => void summary.refetch()}>
            Try again
          </button>
        </p>
      ) : null}

      <div className="-mx-4 overflow-x-auto px-4">
        <div role="tablist" aria-label="Board segments" className="flex w-max gap-2 pb-1">
          {SEGMENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === segmentId}
              onClick={() => setSegmentId(item.id)}
              className={cn(
                'min-h-[44px] whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors',
                item.id === segmentId
                  ? 'bg-[#E31E24] text-white'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          className={`${inputClass} pl-10`}
          placeholder="Search name, phone, reference or address…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          aria-label="Search trips"
        />
      </div>

      {trips.isPending ? (
        <ListSkeleton rows={4} lines={4} />
      ) : trips.isError ? (
        <ErrorState error={trips.error} onRetry={() => void trips.refetch()} what="the board" />
      ) : grouped.total === 0 ? (
        <EmptyState
          icon={Car}
          title={search ? `Nothing matches "${search}".` : segment.empty.title}
          {...(search ? { hint: 'Try a phone number, a reference like 250914-03, or part of an address.' } : segment.empty.hint ? { hint: segment.empty.hint } : {})}
        />
      ) : (
        <div className="space-y-8">
          {grouped.needsAttention.length > 0 ? (
            <section aria-labelledby="group-attention">
              <h2 id="group-attention" className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[#E31E24]">
                <AlertOctagon className="h-4 w-4" aria-hidden="true" />
                Needs attention now ({grouped.needsAttention.length})
              </h2>
              <div className="space-y-4">{grouped.needsAttention.map(renderRow)}</div>
            </section>
          ) : null}

          {grouped.urgent.length > 0 ? (
            <section aria-labelledby="group-urgent">
              <h2 id="group-urgent" className="mb-3 text-sm font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                Urgent ({grouped.urgent.length})
              </h2>
              <div className="space-y-4">{grouped.urgent.map(renderRow)}</div>
            </section>
          ) : null}

          {grouped.scheduled.length > 0 ? (
            <section aria-labelledby="group-scheduled">
              <h2 id="group-scheduled" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Scheduled ({grouped.scheduled.length})
              </h2>
              <div className="space-y-4">{grouped.scheduled.map(renderRow)}</div>
            </section>
          ) : null}

          {trips.data?.nextCursor ? (
            <p className="text-center text-sm text-slate-500 dark:text-slate-400">
              Showing the first 100 open rides. Narrow the list with search or a segment above.
            </p>
          ) : null}
        </div>
      )}

      {selected.length > 0 ? (
        <div className="fixed inset-x-0 bottom-[calc(72px+env(safe-area-inset-bottom))] z-50 border-t border-slate-200 bg-white p-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)] lg:bottom-0 lg:ml-64 dark:border-slate-700 dark:bg-slate-900">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">
              {selected.length} {selected.length === 1 ? 'ride' : 'rides'} selected
            </p>
            <button type="button" className={secondaryButtonClass} onClick={() => setBulkDialog('assign')}>
              <UserCheck className="h-4 w-4" aria-hidden="true" />
              Assign to…
            </button>
            <button type="button" className={primaryButtonClass} onClick={() => setBulkDialog('offer')}>
              <Send className="h-4 w-4" aria-hidden="true" />
              Offer these
            </button>
            <button
              type="button"
              className="ml-auto inline-flex min-h-[44px] items-center gap-1 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              onClick={() => setSelected([])}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Clear
            </button>
          </div>
        </div>
      ) : null}

      <Modal
        open={bulkDialog !== null}
        title={
          bulkResult
            ? 'What happened'
            : bulkDialog === 'assign'
              ? `Assign ${selected.length} ${selected.length === 1 ? 'ride' : 'rides'}`
              : `Offer ${selected.length} ${selected.length === 1 ? 'ride' : 'rides'}`
        }
        onClose={closeBulk}
      >
        {bulkResult ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-700 dark:text-slate-200">
              {bulkResult.response.results.length - bulkResult.response.failed} went through
              {bulkResult.response.failed > 0 ? `, ${bulkResult.response.failed} did not` : ''}.
            </p>
            <ul className="space-y-2">
              {bulkResult.response.results.map((row) => (
                <li
                  key={row.tripId}
                  className={cn(
                    'flex items-start gap-2 rounded-lg border p-3 text-sm',
                    row.ok
                      ? 'border-slate-200 text-slate-700 dark:border-slate-700 dark:text-slate-200'
                      : 'border-red-200 bg-red-50 text-[#E31E24] dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300',
                  )}
                >
                  {row.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertOctagon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0">
                    <span className="font-mono">{referenceOf(row.tripId)}</span>{' '}
                    {row.ok
                      ? bulkResult.kind === 'offer'
                        ? `offered to ${row.offered ?? 0} ${row.offered === 1 ? 'volunteer' : 'volunteers'}`
                        : 'assigned'
                      : (row.error ?? 'did not go through')}
                  </span>
                </li>
              ))}
            </ul>
            {bulkResult.response.failed > 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                The ones that failed are still selected, so you can fix them and try again.
              </p>
            ) : null}
            <button type="button" className={primaryButtonClass} onClick={closeBulk}>
              Close
            </button>
          </div>
        ) : bulkDialog === 'assign' ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!bulkVolunteerId) return;
              bulkMutation.mutate('assign');
            }}
          >
            <div>
              <label htmlFor="bulk-volunteer" className={labelClass}>
                Volunteer <span aria-hidden="true">*</span>
              </label>
              {volunteers.isPending ? (
                <InlineSpinner label="Loading volunteers" />
              ) : volunteers.isError ? (
                <p className="text-sm text-[#E31E24]">
                  We could not load the volunteer list.{' '}
                  <button type="button" className="underline" onClick={() => void volunteers.refetch()}>
                    Try again
                  </button>
                </p>
              ) : (
                <select
                  id="bulk-volunteer"
                  className={inputClass}
                  value={bulkVolunteerId}
                  required
                  onChange={(event) => setBulkVolunteerId(event.target.value)}
                >
                  <option value="">Choose a volunteer…</option>
                  {(volunteers.data?.users ?? []).map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.fullName}
                      {person.phone ? ` · ${person.phone}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label htmlFor="bulk-reason" className={labelClass}>
                Reason (optional)
              </label>
              <input
                id="bulk-reason"
                className={inputClass}
                value={bulkReason}
                placeholder="So the record makes sense later"
                onChange={(event) => setBulkReason(event.target.value)}
              />
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Each ride is assigned on its own. Any that cannot be are listed back to you by reference.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={primaryButtonClass} disabled={bulkMutation.isPending}>
                {bulkMutation.isPending ? 'Assigning…' : `Assign ${selected.length}`}
              </button>
              <button type="button" className={secondaryButtonClass} onClick={closeBulk}>
                Never mind
              </button>
            </div>
          </form>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              bulkMutation.mutate('offer');
            }}
          >
            <div>
              <label htmlFor="bulk-minutes" className={labelClass}>
                Response window in minutes (optional)
              </label>
              <input
                id="bulk-minutes"
                type="number"
                min={1}
                max={1440}
                className={inputClass}
                value={bulkMinutes}
                placeholder="Leave blank for the usual window"
                onChange={(event) => setBulkMinutes(event.target.value)}
              />
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Each ride is offered on its own. Any that cannot be are listed back to you by reference.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={primaryButtonClass} disabled={bulkMutation.isPending}>
                {bulkMutation.isPending ? 'Offering…' : `Offer ${selected.length}`}
              </button>
              <button type="button" className={secondaryButtonClass} onClick={closeBulk}>
                Never mind
              </button>
            </div>
          </form>
        )}
      </Modal>

      <TripForm open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

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
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertOctagon, Car, CheckCircle2, CheckSquare, ChevronDown, Flame, Plus, Search, Send, UserCheck, X } from 'lucide-react';
import type { TripDto } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { invalidateTrips, qk, type TripListParams } from '@/lib/query';
import { formatWeekdayTime, formatPhone } from '@/lib/format';
import { isFullTrip, type BoardSummaryResponse, type TripListResponse, type UserListResponse } from '@/types/api';
import { TripCard } from '@/components/TripCard';
import { TripForm } from '@/components/TripForm';
import { OperationalStatus } from '@/components/OperationalStatus';
import { Modal } from '@/components/Modal';
import { EmptyState, ErrorState, InlineSpinner, ListSkeleton, PageHeader, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';
import { cn } from '@/lib/utils';
import { BoardContextStrip, type BoardContextResponse } from './BoardContextStrip';
import { SEGMENTS, boardListParams, findRestPeriod, groupBoardTrips, type RestPeriod } from './board-model';

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

export function BoardPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [segmentId, setSegmentId] = useState(SEGMENTS[0]!.id);
  // The trip just created: its tab opens and the row is highlighted, so a new
  // trip never "disappears" into a tab the dispatcher is not looking at.
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const showCreated = (trip: TripDto): void => {
    const home = SEGMENTS.find((s) => !s.history && !s.todayOnly && s.status?.includes(trip.status));
    setSearchInput('');
    setSegmentId(home?.id ?? 'all');
    setJustCreatedId(trip.id);
    window.setTimeout(() => {
      document.getElementById(`board-row-${trip.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 600);
    window.setTimeout(() => setJustCreatedId((id) => (id === trip.id ? null : id)), 15_000);
  };
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(params.get('new') === '1');
  const [selected, setSelected] = useState<string[]>([]);
  // Bulk selection is a mode, not a permanent column: the checkbox gutter cost
  // every card a sixth of its width on a phone for a once-a-morning action.
  const [selectMode, setSelectMode] = useState(false);
  // On a phone the six tiles pushed the first ride below the fold; they now
  // sit behind a one-line summary (always open on a desktop).
  const [statsOpen, setStatsOpen] = useState(false);
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

  const listParams = useMemo<TripListParams>(() => boardListParams(segment, search), [segment, search]);

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

  const grouped = useMemo(() => groupBoardTrips((trips.data?.items ?? []).filter(isFullTrip)), [trips.data]);

  const referenceOf = (tripId: string): string =>
    grouped.all.find((trip) => trip.id === tripId)?.reference ?? tripId.slice(0, 8);

  const restPeriodFor = (pickupAt: string): RestPeriod | null => findRestPeriod(restPeriods, pickupAt);


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
      <div
        key={trip.id}
        id={`board-row-${trip.id}`}
        className={cn(
          'flex items-start gap-2',
          justCreatedId === trip.id && 'rounded-xl ring-2 ring-[#EA0029] ring-offset-2 dark:ring-offset-slate-950',
        )}
      >
        {selectMode ? (
        <label className="grid min-h-[44px] min-w-[44px] flex-shrink-0 cursor-pointer place-items-center rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[#EA0029]"
            checked={checked}
            onChange={() => toggleSelected(trip.id)}
            aria-label={`Select ride ${trip.reference} for a bulk action`}
          />
        </label>
        ) : null}
        <div className="min-w-0 flex-1">
          {justCreatedId === trip.id ? (
            <p className="mb-1 mr-2 inline-flex rounded-lg bg-[#EA0029] px-2 py-1 text-xs font-semibold text-white">Just created</p>
          ) : null}
          {rest ? (
            <p className="mb-1 inline-flex flex-wrap items-center gap-2 rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200">
              <Flame className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              During {rest.label}
              <span className="font-normal text-indigo-600 dark:text-indigo-300">
                ({formatWeekdayTime(rest.startsAt)} – {formatWeekdayTime(rest.endsAt)})
              </span>
            </p>
          ) : null}
          <TripCard trip={trip} compact />
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

      <OperationalStatus />
      <BoardContextStrip />

      <button
        type="button"
        className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 text-left text-sm text-slate-700 lg:hidden dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        aria-expanded={statsOpen}
        onClick={() => setStatsOpen((open) => !open)}
      >
        <span>
          {summary.isPending ? (
            'Loading counts…'
          ) : (
            <>
              <span className="font-semibold text-[#EA0029]">{stats?.needsAttention ?? 0}</span> need a driver
              {' · '}
              <span className={cn('font-semibold', (stats?.overdue ?? 0) > 0 && 'text-[#EA0029]')}>{stats?.overdue ?? 0}</span> overdue
              {' · '}
              <span className="font-semibold">{stats?.unanswered ?? 0}</span> unanswered
            </>
          )}
        </span>
        <ChevronDown className={cn('h-4 w-4 flex-shrink-0 transition-transform', statsOpen && 'rotate-180')} aria-hidden="true" />
      </button>
      <div className={cn('grid-cols-2 gap-3 sm:grid-cols-3 lg:grid lg:grid-cols-6', statsOpen ? 'grid' : 'hidden')}>
        {[
          { label: 'Needs attention', value: stats?.needsAttention, accent: 'text-[#EA0029]' },
          { label: 'Offered', value: stats?.offered },
          { label: 'Assigned', value: stats?.assigned },
          { label: 'In progress', value: stats?.inProgress },
          { label: 'Overdue', value: stats?.overdue, accent: 'text-[#EA0029]' },
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
        <p className="text-sm text-[#EA0029]">
          The summary counts did not load.{' '}
          <button type="button" className="underline" onClick={() => void summary.refetch()}>
            Try again
          </button>
        </p>
      ) : null}

      <div className="flex items-start gap-2">
        <div role="tablist" aria-label="Board segments" className="flex flex-1 flex-wrap gap-2">
          {SEGMENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={item.id === segmentId}
              onClick={() => setSegmentId(item.id)}
              className={cn(
                'min-h-[44px] whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors',
                item.id === segmentId
                  ? 'bg-[#EA0029] text-white'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
      <div className="relative flex-1">
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
        <button
          type="button"
          aria-pressed={selectMode}
          className={cn(
            'inline-flex min-h-[44px] flex-shrink-0 items-center gap-1 rounded-lg px-3 text-sm font-medium',
            selectMode
              ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
              : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
          )}
          onClick={() => {
            if (selectMode) setSelected([]);
            setSelectMode((on) => !on);
          }}
        >
          <CheckSquare className="h-4 w-4" aria-hidden="true" />
          {selectMode ? 'Done' : 'Select'}
        </button>
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
              <h2 id="group-attention" className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-[#EA0029]">
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
              onClick={() => {
                setSelected([]);
                setSelectMode(false);
              }}
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
                      : 'border-red-200 bg-red-50 text-[#EA0029] dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300',
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
                <p className="text-sm text-[#EA0029]">
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
                      {person.phone ? ` · ${formatPhone(person.phone)}` : ''}
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

      <TripForm open={formOpen} onClose={() => setFormOpen(false)} onCreated={showCreated} />
    </div>
  );
}

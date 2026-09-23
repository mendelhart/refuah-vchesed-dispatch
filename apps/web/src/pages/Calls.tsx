/**
 * Call log.
 *
 * Each row says which way the call went, how long it lasted ("—" when it never
 * connected — that is not the same as zero seconds), and, when it failed, why,
 * on the same line: "Incoming · No answer". Names are resolved server-side;
 * where there is no name the server sends the last four digits, never the full
 * number.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Phone } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime } from '@/lib/format';
import type { CallListResponse } from '@/types/api';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass,
} from '@/components/states';

const DIRECTIONS = [
  { value: '', label: 'All calls' },
  { value: 'inbound', label: 'Incoming' },
  { value: 'outbound', label: 'Outgoing' },
];

export function CallsPage(): React.JSX.Element {
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');

  const calls = useQuery({
    queryKey: qk.calls.list({ ...(direction ? { direction } : {}), ...(status ? { status } : {}) }),
    queryFn: () =>
      api.get<CallListResponse>('/api/calls', {
        ...(direction ? { direction } : {}),
        ...(status ? { status } : {}),
        limit: 100,
      }),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Call log" subtitle="Connected calls, missed calls, and why they failed" />

      <div className="flex flex-wrap gap-3">
        <select
          className={`${inputClass} sm:w-48`}
          value={direction}
          onChange={(event) => setDirection(event.target.value)}
          aria-label="Filter by direction"
        >
          {DIRECTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className={`${inputClass} sm:w-48`}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Filter by outcome"
        >
          <option value="">Any outcome</option>
          <option value="completed">Connected</option>
          <option value="missed">No answer</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {calls.isPending ? (
        <ListSkeleton rows={5} lines={1} />
      ) : calls.isError ? (
        <ErrorState error={calls.error} onRetry={() => void calls.refetch()} what="the call log" />
      ) : calls.data.calls.length === 0 ? (
        <EmptyState
          icon={Phone}
          title="No calls match these filters."
          hint="Calls placed through the app appear here as soon as they are dialled."
        />
      ) : (
        <ul className="space-y-2">
          {calls.data.calls.map((call) => {
            const incoming = call.direction === 'inbound';
            const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
            return (
              <li key={call.id} className={`${cardClass} p-4`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span
                      className={`mt-0.5 grid h-9 w-9 flex-shrink-0 place-items-center rounded-full ${
                        call.outcomeLabel
                          ? 'bg-red-50 text-[#EA0029] dark:bg-red-950/40'
                          : 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400'
                      }`}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900 dark:text-white">{call.counterparty}</p>
                      <p className="text-sm text-slate-600 dark:text-slate-400">
                        {incoming ? 'Incoming' : 'Outgoing'}
                        {call.outcomeLabel ? ` · ${call.outcomeLabel}` : ''}
                        {call.failureReason ? ` · ${call.failureReason}` : ''}
                      </p>
                      <p className="text-xs text-slate-400 dark:text-slate-500">
                        {formatDateTime(call.startedAt)} · by {call.initiatedByName}
                        {call.tripReference ? (
                          <>
                            {' · '}
                            <Link className="underline" to={call.tripId ? `/trips/${call.tripId}` : '#'}>
                              {call.tripReference}
                            </Link>
                          </>
                        ) : null}
                      </p>
                    </div>
                  </div>
                  <span className="whitespace-nowrap text-sm font-medium text-slate-600 dark:text-slate-300">
                    {call.durationLabel}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

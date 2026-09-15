/**
 * Notification deliveries — the screen that makes a failed message impossible
 * to miss. A failure shows its last error inline; nothing is hidden behind a
 * status code.
 */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellRing, MessageSquare } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime, titleCase } from '@/lib/format';
import type { DeliveriesResponse, SmsEventsResponse } from '@/types/api';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass,
} from '@/components/states';

const STATUS_CLASSES: Record<string, string> = {
  queued: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  delivered: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  skipped: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
};

export function NotificationsAdminPage(): React.JSX.Element {
  const [status, setStatus] = useState('');

  const deliveries = useQuery({
    queryKey: qk.admin.deliveries({ ...(status ? { status } : {}) }),
    queryFn: () => api.get<DeliveriesResponse>('/api/notifications/deliveries', { ...(status ? { status } : {}), limit: 150 }),
  });
  const smsEvents = useQuery({
    queryKey: qk.admin.smsEvents(),
    queryFn: () => api.get<SmsEventsResponse>('/api/sms-events', { limit: 50 }),
  });

  const health = deliveries.data?.health;

  return (
    <div className="space-y-6">
      <PageHeader title="Notification deliveries" subtitle="Last 24 hours of messages, and what happened to them" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Delivered', value: health?.delivered, accent: '' },
          { label: 'Queued', value: health?.queued, accent: '' },
          { label: 'Failed', value: health?.failed, accent: 'text-[#E31E24]' },
          { label: 'Skipped', value: health?.skipped, accent: 'text-amber-600 dark:text-amber-400' },
        ].map((tile) => (
          <div key={tile.label} className={`${cardClass} p-4`}>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{tile.label}</p>
            <p className={`mt-1 text-2xl font-bold text-slate-900 dark:text-white ${tile.accent}`}>
              {deliveries.isPending ? '–' : (tile.value ?? 0)}
            </p>
          </div>
        ))}
      </div>

      <select
        className={`${inputClass} sm:w-56`}
        value={status}
        onChange={(event) => setStatus(event.target.value)}
        aria-label="Filter deliveries by status"
      >
        <option value="">All statuses</option>
        {['queued', 'sent', 'delivered', 'failed', 'skipped'].map((value) => (
          <option key={value} value={value}>
            {titleCase(value)}
          </option>
        ))}
      </select>

      {deliveries.isPending ? (
        <ListSkeleton rows={5} lines={1} />
      ) : deliveries.isError ? (
        <ErrorState error={deliveries.error} onRetry={() => void deliveries.refetch()} what="delivery history" />
      ) : deliveries.data.deliveries.length === 0 ? (
        <EmptyState icon={BellRing} title="No messages match this filter." hint="Offers and reminders show up here the moment they are queued." />
      ) : (
        <ul className="space-y-2">
          {deliveries.data.deliveries.map((row) => (
            <li key={row.id} className={`${cardClass} p-4`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 dark:text-white">
                    {row.title ?? titleCase(row.event)}
                  </p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {row.recipientName} · {row.channel.toUpperCase()} · attempt {row.attempts}
                  </p>
                  {row.lastError ? (
                    <p className="mt-1 break-words text-sm font-medium text-[#E31E24]">{row.lastError}</p>
                  ) : null}
                </div>
                <div className="text-right">
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_CLASSES[row.status] ?? STATUS_CLASSES.queued}`}>
                    {titleCase(row.status)}
                  </span>
                  <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{formatDateTime(row.sentAt ?? row.queuedAt)}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-white">
          <MessageSquare className="h-5 w-5" aria-hidden="true" />
          Inbound SMS
        </h2>
        {smsEvents.isPending ? (
          <ListSkeleton rows={2} lines={1} />
        ) : smsEvents.isError ? (
          <ErrorState error={smsEvents.error} onRetry={() => void smsEvents.refetch()} what="inbound SMS events" />
        ) : smsEvents.data.events.length === 0 ? (
          <EmptyState title="No inbound messages recorded." hint="Replies from volunteers appear here with how they were matched." />
        ) : (
          <ul className="space-y-2">
            {smsEvents.data.events.map((event) => (
              <li key={event.id} className={`${cardClass} p-4 text-sm`}>
                <p className="font-medium text-slate-900 dark:text-white">
                  {titleCase(event.direction)} · {titleCase(event.outcome)}
                  {event.signatureValid === false ? (
                    <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-500/15 dark:text-red-300">
                      Bad signature
                    </span>
                  ) : null}
                </p>
                <p className="text-slate-600 dark:text-slate-400">
                  {event.matchedUserName ?? 'Unmatched number'}
                  {event.detail ? ` · ${event.detail}` : ''}
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500">{formatDateTime(event.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

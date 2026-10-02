/**
 * Audit log. Read-only by construction on the server; this screen only filters
 * and reads. Every row names who did what, to which record, and when.
 */
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime, titleCase } from '@/lib/format';
import type { AuditListResponse } from '@/types/api';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass,
} from '@/components/states';

const ENTITY_TYPES = ['', 'trip', 'user', 'contact', 'equipment', 'vehicle', 'setting', 'organization'];

export function AuditPage(): React.JSX.Element {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');

  const audit = useQuery({
    queryKey: qk.admin.audit({ ...(entityType ? { entityType } : {}), ...(action ? { action } : {}) }),
    queryFn: () =>
      api.get<AuditListResponse>('/api/audit', {
        ...(entityType ? { entityType } : {}),
        ...(action ? { action } : {}),
        limit: 150,
      }),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" subtitle="Who changed what, and when" />

      <div className="flex flex-wrap gap-3">
        <select
          className={`${inputClass} sm:w-48`}
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
          aria-label="Filter by record type"
        >
          {ENTITY_TYPES.map((value) => (
            <option key={value} value={value}>
              {value ? titleCase(value) : 'All record types'}
            </option>
          ))}
        </select>
        <input
          className={`${inputClass} sm:w-64`}
          placeholder="Action, e.g. trip.claimed"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          aria-label="Filter by action"
        />
      </div>

      {audit.isPending ? (
        <ListSkeleton rows={6} lines={1} />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} what="the audit log" />
      ) : audit.data.events.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Nothing matches these filters."
          hint="Try a broader record type, or clear the action filter."
        />
      ) : (
        <ul className="space-y-2">
          {audit.data.events.map((event) => (
            <li key={event.id} className={`${cardClass} p-4`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 dark:text-white">{titleCase(event.action)}</p>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {event.actorName} ({event.actorRole}) · {titleCase(event.entityType)}{' '}
                    {event.entityType === 'trip' ? (
                      <Link className="underline" to={`/trips/${event.entityId}`}>
                        {event.entityId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs">{event.entityId.slice(0, 8)}</span>
                    )}
                  </p>
                </div>
                <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                  {formatDateTime(event.occurredAt)}
                </span>
              </div>
              {event.metadata ? (
                <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {JSON.stringify(event.metadata)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

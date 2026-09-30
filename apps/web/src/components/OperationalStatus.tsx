import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Status {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  databaseExpiresAt: string | null;
}

/** Independent of the worker: a silent worker cannot hide its own failure. */
export function OperationalStatus(): React.JSX.Element | null {
  const { user } = useAuth();
  const health = useQuery({ queryKey: ['admin-health'], queryFn: () => api.get<Status>('/api/admin/health'),
    enabled: user?.role === 'admin', refetchInterval: 60_000, retry: false });
  if (user?.role !== 'admin') return null;
  const failures = health.data?.checks.filter((check) => !check.ok) ?? [];
  const expires = health.data?.databaseExpiresAt;
  const days = expires ? Math.ceil((Date.parse(`${expires}T00:00:00`) - Date.now()) / 86_400_000) : null;
  return <section className="space-y-2" aria-label="System status">
    {(health.isError || failures.length > 0) && <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
      <p className="font-semibold">Dispatch needs attention</p>
      {health.isError ? <p>Could not check system health. The server or database may be unavailable.</p>
        : <ul>{failures.map((check) => <li key={check.name}>{check.detail}</li>)}</ul>}
    </div>}
    {days !== null && <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      Database expires {expires}: {days > 0 ? `${days} days left` : 'expiry date reached'}. Back up the data and arrange a replacement before expiry.
    </p>}
  </section>;
}

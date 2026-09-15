/**
 * Dispatch timings. Every value is a row in the settings table, so operations
 * can tune offer windows and escalation without a deploy. The defaults the API
 * ships with are shown next to each value.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { titleCase } from '@/lib/format';
import type { OpsHealthResponse, SettingsResponse } from '@/types/api';
import {
  ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, primaryButtonClass,
} from '@/components/states';

const SETTING_LABELS: Record<string, string> = {
  'dispatch.offer_window_minutes': 'How long an offer stays open (minutes)',
  'dispatch.offer_reminder_minutes': 'Remind volunteers after (minutes)',
  'dispatch.escalation_minutes': 'Escalate an unanswered trip after (minutes)',
  'dispatch.urgent_offer_window_minutes': 'Offer window for urgent trips (minutes)',
  'dispatch.overdue_grace_minutes': 'Grace before a trip counts as overdue (minutes)',
  'notifications.max_attempts': 'Delivery attempts before giving up',
  'notifications.retry_backoff_seconds': 'Wait between delivery attempts (seconds)',
  'auth.session_ttl_hours': 'How long a sign-in lasts (hours)',
  'calling.daily_limit_per_user': 'Calls one person may place per day',
};

export function AdminSettingsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const settings = useQuery({
    queryKey: qk.admin.settings(),
    queryFn: () => api.get<SettingsResponse>('/api/settings'),
  });
  const health = useQuery({
    queryKey: qk.admin.opsHealth(),
    queryFn: () => api.get<OpsHealthResponse>('/api/ops/health'),
  });

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: number }) => api.put(`/api/settings/${key}`, { value }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: qk.admin.settings() });
      toast.success(`${SETTING_LABELS[vars.key] ?? vars.key} updated.`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Dispatch settings" subtitle="Timings and limits, changeable without a deploy" />

      <section className={cardClass}>
        <div className="p-5 md:p-6">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-white">
            <Activity className="h-5 w-5" aria-hidden="true" />
            System health
          </h2>
          {health.isPending ? (
            <ListSkeleton rows={1} lines={2} />
          ) : health.isError ? (
            <ErrorState error={health.error} onRetry={() => void health.refetch()} what="system health" />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Jobs pending', value: health.data.jobs.pending },
                { label: 'Jobs running', value: health.data.jobs.running },
                { label: 'Jobs overdue', value: health.data.jobs.overdue },
                { label: 'Dead jobs', value: health.data.jobs.dead },
              ].map((tile) => (
                <div key={tile.label}>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{tile.label}</p>
                  <p className={`text-2xl font-bold ${tile.value > 0 && tile.label !== 'Jobs pending' ? 'text-[#E31E24]' : 'text-slate-900 dark:text-white'}`}>
                    {tile.value}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {settings.isPending ? (
        <ListSkeleton rows={4} lines={1} />
      ) : settings.isError ? (
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} what="the settings" />
      ) : (
        <ul className="space-y-3">
          {Object.entries(settings.data.defaults).map(([key, defaultValue]) => {
            const current = settings.data.settings[key];
            const currentText = current === undefined ? String(defaultValue) : String(current);
            const draft = drafts[key] ?? currentText;
            return (
              <li key={key} className={`${cardClass} p-4`}>
                <label htmlFor={`setting-${key}`} className="block text-sm font-medium text-slate-900 dark:text-white">
                  {SETTING_LABELS[key] ?? titleCase(key)}
                </label>
                <p className="mt-0.5 font-mono text-xs text-slate-400 dark:text-slate-500">
                  {key} · default {defaultValue}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    id={`setting-${key}`}
                    type="number"
                    className={`${inputClass} sm:w-40`}
                    value={draft}
                    onChange={(event) => setDrafts({ ...drafts, [key]: event.target.value })}
                  />
                  <button
                    type="button"
                    className={primaryButtonClass}
                    disabled={save.isPending || draft === currentText}
                    onClick={() => save.mutate({ key, value: Number(draft) })}
                  >
                    Save
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

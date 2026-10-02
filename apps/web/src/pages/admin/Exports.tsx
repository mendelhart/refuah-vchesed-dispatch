/**
 * Exports.
 *
 * Every file this screen produces is a list of real people with their phone
 * numbers on it, so the page says that in plain words rather than burying it in
 * a policy nobody opens. The files delete themselves after seven days, which is
 * a feature worth stating: it is why an expired download is normal and not a
 * fault.
 *
 * A running export is polled rather than waited on, because a year of trips is
 * a background job and an HTTP request that hangs for two minutes is how the
 * legacy version timed out.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileSpreadsheet, ShieldAlert } from 'lucide-react';
import { EXPORT_KINDS, type ExportKind } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDate, formatDateTime, titleCase } from '@/lib/format';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, inputClass, labelClass, panelClass, primaryButtonClass,
  tableWrapClass,
} from '@/components/states';

interface ExportRow {
  id: string;
  kind: string;
  status: string;
  rowCount: number | null;
  params: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  fileId: string | null;
  requestedBy: string;
}

interface ExportListResponse {
  exports: ExportRow[];
}

const KIND_LABELS: Record<ExportKind, string> = {
  trips: 'Trips',
  volunteers: 'Volunteers',
  monthly_board: 'Monthly board report',
  equipment_loans: 'Equipment loans',
  audit: 'Audit log',
  notification_deliveries: 'Message deliveries',
};

const STATUS_CLASSES: Record<string, string> = {
  queued: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  ready: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
};

function isWorking(row: ExportRow): boolean {
  return row.status === 'queued' || row.status === 'running';
}

export function ExportsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ExportKind>('trips');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const exports = useQuery({
    queryKey: qk.exports.list(),
    queryFn: () => api.get<ExportListResponse>('/api/exports'),
    // Poll only while something is actually working, so an idle screen is idle.
    refetchInterval: (query) => ((query.state.data?.exports ?? []).some(isWorking) ? 5000 : false),
  });

  const request = useMutation({
    mutationFn: () =>
      api.post<{ export: ExportRow }>('/api/exports', {
        kind,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.exports.all() });
      toast.success('Building the file. It appears below when it is ready.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const rows = exports.data?.exports ?? [];
  const working = rows.filter(isWorking).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Exports" subtitle="Reports and data pulls, built in the background" />

      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
        <p className="flex items-start gap-2 text-sm text-slate-800 dark:text-slate-200">
          <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
          <span>
            These files contain personal information — names, phone numbers, addresses. Every request and every
            download is recorded against your account. Each file deletes itself seven days after it was made, so
            download it when you need it rather than keeping the link.
          </span>
        </p>
      </div>

      <section className={panelClass}>
        <h2 className="mb-3 font-semibold text-slate-900 dark:text-white">Build a new one</h2>
        <form
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (from && to && from > to) {
              toast.error('The end date is before the start date.');
              return;
            }
            request.mutate();
          }}
        >
          <div className="sm:col-span-2">
            <label htmlFor="export-kind" className={labelClass}>
              What to export
            </label>
            <select
              id="export-kind"
              className={inputClass}
              value={kind}
              onChange={(event) => setKind(event.target.value as ExportKind)}
            >
              {EXPORT_KINDS.map((value) => (
                <option key={value} value={value}>
                  {KIND_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="export-from" className={labelClass}>
              From (optional)
            </label>
            <input
              id="export-from"
              type="date"
              className={inputClass}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="export-to" className={labelClass}>
              To (optional)
            </label>
            <input
              id="export-to"
              type="date"
              className={inputClass}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-4">
            <button type="submit" className={primaryButtonClass} disabled={request.isPending}>
              <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
              {request.isPending ? 'Asking…' : 'Build the file'}
            </button>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Leaving the dates empty exports everything on file.
            </p>
          </div>
        </form>
      </section>

      {working > 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400" role="status">
          {working} {working === 1 ? 'file is' : 'files are'} being built. This list refreshes itself every few
          seconds.
        </p>
      ) : null}

      {exports.isPending ? (
        <ListSkeleton rows={4} lines={1} />
      ) : exports.isError ? (
        <ErrorState error={exports.error} onRetry={() => void exports.refetch()} what="your exports" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileSpreadsheet}
          title="No exports yet."
          hint="Build one above and it appears here while it runs."
        />
      ) : (
        <div className={tableWrapClass}>
          <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
            <thead className="bg-slate-50 dark:bg-slate-800">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200">
                  What
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200">
                  Rows
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200">
                  Asked for
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200">
                  Deletes itself
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold text-slate-700 dark:text-slate-200">
                  File
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white dark:divide-slate-700 dark:bg-slate-900">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900 dark:text-white">
                      {KIND_LABELS[row.kind as ExportKind] ?? titleCase(row.kind)}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {describeRange(row.params)} · by {row.requestedBy}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${
                        STATUS_CLASSES[row.status] ?? STATUS_CLASSES.queued
                      }`}
                    >
                      {titleCase(row.status)}
                    </span>
                    {row.error ? (
                      <p className="mt-1 max-w-xs break-words text-xs font-medium text-[#C80023] dark:text-red-400">{row.error}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-slate-700 dark:text-slate-200">{row.rowCount ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-400">
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600 dark:text-slate-400">
                    {row.expiresAt ? formatDate(row.expiresAt) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {row.status === 'ready' && row.fileId ? (
                      <a
                        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-[#EA0029] px-4 text-sm font-semibold text-white hover:bg-[#C80023]"
                        href={`/api/exports/${row.id}/download`}
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        Download
                      </a>
                    ) : isWorking(row) ? (
                      <span className="text-slate-500 dark:text-slate-400">Building…</span>
                    ) : (
                      <span className="text-slate-500 dark:text-slate-400">Nothing to download</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** A YYYY-MM-DD value is a calendar date, not an instant: parsing it bare
 *  gives UTC midnight, which shows as the previous day here every evening. */
function formatDateOnly(value: string): string {
  return formatDate(`${value}T00:00:00`);
}

/** The dates an export was asked for, said the way a person would say them. */
function describeRange(params: Record<string, unknown> | null): string {
  const from = typeof params?.from === 'string' ? params.from : null;
  const to = typeof params?.to === 'string' ? params.to : null;
  if (from && to) return `${formatDateOnly(from)} to ${formatDateOnly(to)}`;
  if (from) return `from ${formatDateOnly(from)}`;
  if (to) return `up to ${formatDateOnly(to)}`;
  return 'everything on file';
}

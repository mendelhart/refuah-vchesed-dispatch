/**
 * The three states every list must have: loading, failed, empty.
 *
 * The old app showed a bare "No data found" for all three, so a dispatcher
 * could not tell a quiet morning from a broken request. Each of these says
 * which one it is, and the error state always offers a way back.
 */
import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { errorMessage } from '@/lib/api';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white md:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-400 md:text-base">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** Card-shaped shimmer that matches the real card's footprint. */
export function ListSkeleton({ rows = 3, lines = 3 }: { rows?: number; lines?: number }): React.JSX.Element {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="mb-3 h-5 w-1/3 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
          <div className="space-y-2">
            {Array.from({ length: lines }, (_, lineIndex) => (
              <div
                key={lineIndex}
                className="h-3 animate-pulse rounded bg-slate-100 dark:bg-slate-800"
                style={{ width: `${90 - lineIndex * 15}%` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  what = 'this list',
}: {
  error: unknown;
  onRetry: () => void;
  what?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900/50 dark:bg-red-950/30">
      <AlertTriangle className="mx-auto h-8 w-8 text-[#E31E24]" aria-hidden="true" />
      <p className="mt-3 font-semibold text-slate-900 dark:text-white">We could not load {what}.</p>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{errorMessage(error)}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mx-auto mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-[#E31E24] px-4 text-sm font-semibold text-white hover:bg-[#C41A1F]"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon: Icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-10 text-center dark:border-slate-700 dark:bg-slate-900">
      {Icon ? <Icon className="mx-auto mb-3 h-8 w-8 text-slate-300 dark:text-slate-600" /> : null}
      <p className="font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function InlineSpinner({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#E31E24] dark:border-slate-600" />
      {label}
    </span>
  );
}

/** One place for the card chrome so light/dark stay in step across screens. */
export const cardClass =
  'rounded-xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-slate-700 dark:bg-slate-900';
export const panelClass =
  'rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900';
export const inputClass =
  'min-h-[44px] w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-[#E31E24] focus:outline-none focus:ring-1 focus:ring-[#E31E24] dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-500';
export const labelClass = 'mb-1 block text-sm font-medium text-slate-700 dark:text-slate-200';
export const primaryButtonClass =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[#E31E24] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#C41A1F] disabled:cursor-not-allowed disabled:opacity-60';
export const secondaryButtonClass =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';
export const tableWrapClass = 'overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700';

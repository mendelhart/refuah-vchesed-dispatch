/**
 * One Contacts screen for dispatch.
 *
 * Callers, the team roster and the hospital/service phone book used to be
 * three separate menu entries, which meant guessing which list a number lived
 * in mid-call. They are now three filters on one screen. Each filter renders
 * the existing page unchanged, so no data moved and every old link
 * (/callers, /directory) still works.
 */
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { FullPageSpinner } from '@/lib/auth';

const CallersPage = React.lazy(() => import('@/pages/Callers').then((m) => ({ default: m.CallersPage })));
const DirectoryPage = React.lazy(() => import('@/pages/Directory').then((m) => ({ default: m.DirectoryPage })));
const ContactsPage = React.lazy(() => import('@/pages/Contacts').then((m) => ({ default: m.ContactsPage })));

const TABS = [
  { id: 'callers', label: 'Callers' },
  { id: 'places', label: 'Phone book' },
  { id: 'team', label: 'Team' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function ContactsHubPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : 'callers';

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Contacts</h1>
      <div role="tablist" aria-label="Contact lists" className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === tab}
            onClick={() => setParams(item.id === 'callers' ? {} : { tab: item.id }, { replace: true })}
            className={cn(
              'min-h-[44px] whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors',
              item.id === tab
                ? 'bg-[#E31E24] text-white'
                : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <React.Suspense fallback={<FullPageSpinner label="Loading" />}>
        {tab === 'callers' ? <CallersPage /> : tab === 'places' ? <ContactsPage /> : <DirectoryPage />}
      </React.Suspense>
    </div>
  );
}

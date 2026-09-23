/**
 * One Contacts list for dispatch.
 *
 * Callers, the hospital/service phone book and the team roster live in one
 * list with one search box. The filter chips narrow it to one kind; picking a
 * single kind opens that kind's full screen (add, edit, saved addresses) so no
 * feature was lost. Old links (/callers, /directory, ?tab=...) still work.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight, Phone, Search, UserRound, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FullPageSpinner } from '@/lib/auth';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatPhone, telHref, titleCase } from '@/lib/format';
import type { ContactsResponse, UserListResponse } from '@/types/api';
import { EmptyState, ErrorState, ListSkeleton, cardClass, inputClass } from '@/components/states';

const CallersPage = React.lazy(() => import('@/pages/Callers').then((m) => ({ default: m.CallersPage })));
const DirectoryPage = React.lazy(() => import('@/pages/Directory').then((m) => ({ default: m.DirectoryPage })));
const ContactsPage = React.lazy(() => import('@/pages/Contacts').then((m) => ({ default: m.ContactsPage })));

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'callers', label: 'Callers' },
  { id: 'places', label: 'Hospitals' },
  { id: 'team', label: 'Team' },
] as const;

type TabId = (typeof TABS)[number]['id'];
type Kind = 'caller' | 'place' | 'team';

interface CallerLite {
  id: string;
  name: string;
  primaryPhone: string | null;
}

interface Row {
  key: string;
  kind: Kind;
  id: string;
  name: string;
  detail: string;
  phone: string | null;
}

const KIND_LABEL: Record<Kind, string> = { caller: 'Caller', place: 'Hospital / service', team: 'Team' };
const KIND_ICON: Record<Kind, typeof UserRound> = { caller: UserRound, place: Building2, team: Users };

function AllContacts({ onOpenCaller }: { onOpenCaller: (id: string) => void }): React.JSX.Element {
  const [input, setInput] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(input.trim()), 250);
    return () => clearTimeout(timer);
  }, [input]);
  const searching = term.length >= 2;

  const callers = useQuery({
    queryKey: searching ? qk.callers.search(term) : qk.callers.list({ limit: 100, offset: 0 }),
    queryFn: async (): Promise<CallerLite[]> =>
      searching
        ? (await api.get<{ results: CallerLite[] }>('/api/callers/search', { q: term, limit: 25 })).results
        : (await api.get<{ callers: CallerLite[] }>('/api/callers', { limit: 100, offset: 0 })).callers,
  });
  const places = useQuery({ queryKey: qk.contacts.list(), queryFn: () => api.get<ContactsResponse>('/api/contacts') });
  const team = useQuery({
    queryKey: qk.people.list({ status: 'active', ...(searching ? { search: term } : {}) }),
    queryFn: () =>
      api.get<UserListResponse>('/api/users', { status: 'active', ...(searching ? { search: term } : {}), limit: 200 }),
  });

  const rows = useMemo<Row[]>(() => {
    const needle = term.toLowerCase();
    const digits = term.replace(/\D/g, '');
    const out: Row[] = [];
    for (const c of callers.data ?? []) {
      out.push({ key: `c-${c.id}`, kind: 'caller', id: c.id, name: c.name, detail: KIND_LABEL.caller, phone: c.primaryPhone });
    }
    for (const p of places.data?.contacts ?? []) {
      const hit = !searching
        || p.name.toLowerCase().includes(needle)
        || (p.role ?? '').toLowerCase().includes(needle)
        || (digits.length >= 3 && p.phone.replace(/\D/g, '').includes(digits));
      if (hit) {
        out.push({
          key: `p-${p.id}`, kind: 'place', id: p.id, name: p.name,
          detail: p.role ? titleCase(p.role) : KIND_LABEL.place, phone: p.phone,
        });
      }
    }
    for (const u of team.data?.users ?? []) {
      out.push({
        key: `t-${u.id}`, kind: 'team', id: u.id, name: u.fullName,
        detail: `Team · ${u.role}`, phone: u.phone ?? null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [callers.data, places.data, team.data, term, searching]);

  const pending = callers.isPending || places.isPending || team.isPending;
  const failed = [callers, places, team].find((q) => q.isError);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          className={`${inputClass} pl-10`}
          placeholder="Search name or number…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-label="Search all contacts"
        />
      </div>
      {failed ? (
        <ErrorState error={failed.error} onRetry={() => void failed.refetch()} what="the contacts" />
      ) : pending ? (
        <ListSkeleton rows={5} lines={1} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Search}
          title={searching ? `Nothing matches "${term}".` : 'No contacts yet.'}
          hint="Use the filters above to add a caller or a hospital/service."
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const Icon = KIND_ICON[row.kind];
            const body = (
              <>
                <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-red-50 text-[#EA0029] dark:bg-red-950/40">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900 dark:text-white">{row.name}</span>
                  <span className="block truncate text-xs capitalize text-slate-500 dark:text-slate-400">
                    {row.detail}
                    {row.phone ? ` · ${formatPhone(row.phone)}` : ''}
                  </span>
                </span>
              </>
            );
            return (
              <li key={row.key} className={`${cardClass} flex items-center gap-2 p-2`}>
                {row.kind === 'caller' ? (
                  <button
                    type="button"
                    onClick={() => onOpenCaller(row.id)}
                    className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 text-left"
                    aria-label={`Open ${row.name}'s file`}
                  >
                    {body}
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-slate-400" aria-hidden="true" />
                  </button>
                ) : (
                  <div className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3">{body}</div>
                )}
                {row.phone ? (
                  <a
                    href={telHref(row.phone)}
                    className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full text-[#EA0029] hover:bg-red-50 dark:hover:bg-red-950/40"
                    aria-label={`Call ${row.name}`}
                  >
                    <Phone className="h-5 w-5" aria-hidden="true" />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ContactsHubPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : 'all';
  const callerId = params.get('caller');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Contacts</h1>
      <div role="tablist" aria-label="Show" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === tab}
            onClick={() => setParams(item.id === 'all' ? {} : { tab: item.id }, { replace: true })}
            className={cn(
              'min-h-[44px] flex-shrink-0 whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors',
              item.id === tab
                ? 'bg-[#EA0029] text-white'
                : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <React.Suspense fallback={<FullPageSpinner label="Loading" />}>
        {tab === 'all' ? (
          <AllContacts onOpenCaller={(id) => setParams({ tab: 'callers', caller: id })} />
        ) : tab === 'callers' ? (
          <CallersPage key={callerId ?? 'list'} initialCallerId={callerId} />
        ) : tab === 'places' ? (
          <ContactsPage />
        ) : (
          <DirectoryPage />
        )}
      </React.Suspense>
    </div>
  );
}

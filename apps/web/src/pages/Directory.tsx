/**
 * Volunteer directory.
 *
 * Contact details come back null for volunteers — the server redacts them, so
 * the roster is visible to everyone but phone numbers are not. This screen
 * renders whatever it is given and asks for nothing extra.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import { Mail, Pencil, Phone, Plus, Search, Users } from 'lucide-react';
import { AddPersonModal } from '@/components/AddPersonModal';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { telHref, titleCase, formatPhone } from '@/lib/format';
import type { UserListResponse } from '@/types/api';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, primaryButtonClass,
} from '@/components/states';

export function DirectoryPage({ title = 'Directory' }: { title?: string } = {}): React.JSX.Element {
  const { user } = useAuth();
  const canManage = user?.role === 'dispatcher' || user?.role === 'admin';
  const [adding, setAdding] = useState(false);
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'dispatcher' | 'volunteer'>('all');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const people = useQuery({
    queryKey: qk.people.list({ status: 'active', ...(search ? { search } : {}) }),
    queryFn: () =>
      api.get<UserListResponse>('/api/users', { status: 'active', ...(search ? { search } : {}), limit: 200 }),
  });

  // Admins, then dispatchers (the coordinators), then volunteers; A-Z within.
  const ROLE_ORDER: Record<string, number> = { admin: 0, dispatcher: 1, volunteer: 2 };
  const roster = (people.data?.users ?? [])
    .filter((p) => roleFilter === 'all' || p.role === roleFilter)
    .slice()
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.fullName.localeCompare(b.fullName));
  const ROLE_CHIPS = [
    { id: 'all', label: 'All' },
    { id: 'admin', label: 'Admins' },
    { id: 'dispatcher', label: 'Dispatchers / coordinators' },
    { id: 'volunteer', label: 'Volunteers' },
  ] as const;

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        subtitle="Everyone on the roster"
        actions={
          user?.role === 'admin' ? (
            <button type="button" className={primaryButtonClass} onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add volunteer
            </button>
          ) : undefined
        }
      />
      <AddPersonModal open={adding} onClose={() => setAdding(false)} title="Add volunteer" />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          className={`${inputClass} pl-10`}
          placeholder="Search by name…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-label="Search the directory"
        />
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" role="group" aria-label="Filter by role">
        {ROLE_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            onClick={() => setRoleFilter(chip.id)}
            className={
              roleFilter === chip.id
                ? 'min-h-[44px] flex-shrink-0 whitespace-nowrap rounded-lg border border-[#EA0029] bg-[#EA0029]/10 px-3 text-sm font-medium text-[#EA0029]'
                : 'min-h-[44px] flex-shrink-0 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
            }
          >
            {chip.label}
          </button>
        ))}
      </div>

      {people.isPending ? (
        <ListSkeleton rows={4} lines={2} />
      ) : people.isError ? (
        <ErrorState error={people.error} onRetry={() => void people.refetch()} what="the directory" />
      ) : roster.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? `Nobody on the roster matches "${search}".` : 'The roster is empty.'}
          hint={search ? 'Try part of a first or last name.' : 'An administrator can invite volunteers from the People screen.'}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {roster.map((person) => (
            <li key={person.id} className={`${cardClass} p-4`}>
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-red-50 text-sm font-semibold text-[#EA0029] dark:bg-red-950/40">
                  {person.fullName
                    .split(' ')
                    .slice(0, 2)
                    .map((part) => part[0] ?? '')
                    .join('')}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900 dark:text-white">{person.fullName}</p>
                  <p className="text-xs capitalize text-slate-500 dark:text-slate-400">
                    {person.role}
                    {person.groupSlugs.length > 0 ? ` · ${person.groupSlugs.map(titleCase).join(', ')}` : ''}
                  </p>
                  {person.phone ? (
                    <a className="mt-1 flex items-center gap-2 text-sm text-[#EA0029]" href={telHref(person.phone)}>
                      <Phone className="h-3 w-3" aria-hidden="true" />
                      {formatPhone(person.phone)}
                    </a>
                  ) : null}
                  {person.email ? (
                    <a className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400" href={`mailto:${person.email}`}>
                      <Mail className="h-3 w-3" aria-hidden="true" />
                      <span className="truncate">{person.email}</span>
                    </a>
                  ) : null}
                </div>
                {canManage && person.role === 'volunteer' ? (
                  <Link
                    to={`/volunteers?open=${person.id}`}
                    aria-label={`Edit ${person.fullName}`}
                    className="ml-auto grid h-11 w-11 flex-shrink-0 place-items-center rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

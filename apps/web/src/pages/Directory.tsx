/**
 * Volunteer directory.
 *
 * Contact details come back null for volunteers — the server redacts them, so
 * the roster is visible to everyone but phone numbers are not. This screen
 * renders whatever it is given and asks for nothing extra.
 */
import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Phone, Search, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';
import { telHref, titleCase, formatPhone } from '@/lib/format';
import type { UserListResponse } from '@/types/api';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass,
} from '@/components/states';

export function DirectoryPage(): React.JSX.Element {
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

  return (
    <div className="space-y-6">
      <PageHeader title="Directory" subtitle="Everyone on the roster" />

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

      {people.isPending ? (
        <ListSkeleton rows={4} lines={2} />
      ) : people.isError ? (
        <ErrorState error={people.error} onRetry={() => void people.refetch()} what="the directory" />
      ) : people.data.users.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? `Nobody on the roster matches "${search}".` : 'The roster is empty.'}
          hint={search ? 'Try part of a first or last name.' : 'An administrator can invite volunteers from the People screen.'}
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {people.data.users.map((person) => (
            <li key={person.id} className={`${cardClass} p-4`}>
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-red-50 text-sm font-semibold text-[#E31E24] dark:bg-red-950/40">
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
                    <a className="mt-1 flex items-center gap-2 text-sm text-[#E31E24]" href={telHref(person.phone)}>
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
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

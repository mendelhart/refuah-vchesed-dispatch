import { VolunteerDrawer } from './VolunteerDrawer';
import { FortnightView, RosterCards, RosterTable } from './volunteer-roster';
/**
 * The volunteer screen a dispatcher actually uses: one searchable list instead
 * of six.
 *
 * The single most important line of copy on this page is the availability one.
 * `availability_rules === 0` means the volunteer has stated no restriction, so
 * they can be asked at any hour — it does NOT mean they are unavailable. The
 * legacy screen showed an empty week for those people and dispatchers read it
 * as "switched off", so the most willing volunteers on the roster were the ones
 * nobody called. Every label here says it the right way round.
 *
 * The drawer exists for the phone call: "I can't do Thursdays any more" has to
 * be fixable while the volunteer is still on the line, by the person taking the
 * call, without an email to an administrator.
 */
import { AddPersonModal } from '@/components/AddPersonModal';

import { PhotoRequests } from '@/components/PhotoRequests';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, inputClass, primaryButtonClass } from '@/components/states';

import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';


import { qk } from '@/lib/query';
import type { GroupsResponse } from '@/types/api';

import { useQuery } from '@tanstack/react-query';
import { CalendarDays, List, Plus, Search, Users } from 'lucide-react';
import React,{ useEffect,useState } from 'react';


/** Snake case on purpose: this row comes straight from a raw SQL projection. */
interface VolunteerRow {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  role: string;
  status: string;
  volunteer_number: string | null;
  capabilities: string[];
  languages: string[];
  service_area: string | null;
  muted_until: string | null;
  suspended_until: string | null;
  suspension_reason: string | null;
  last_offered_at: string | null;
  notification_preference: string | null;
  group_slugs: string[];
  group_names: string[];
  service_slugs: string[];
  availability_rules: number;
  completed_trips: number;
  last_trip_at: string | null;
  open_trips: number;
  licence_status: string | null;
}

interface OverviewResponse {
  volunteers: VolunteerRow[];
}

interface ServicesResponse {
  services: { id: string; slug: string; name: string; description: string | null }[];
}

export function VolunteersPage(): React.JSX.Element {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [groupSlug, setGroupSlug] = useState('');
  const [serviceSlug, setServiceSlug] = useState('');
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const [view, setView] = useState<'list' | 'calendar'>('list');
  // ?open=<id> (from Contacts > Volunteers) opens that volunteer straight away.
  const { user } = useAuth();
  // Admins and coordinators can both add volunteers.
  const canAdd = user?.role === 'admin' || user?.role === 'dispatcher';
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('open'));

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filters = {
    ...(search ? { search } : {}),
    ...(groupSlug ? { groupSlug } : {}),
    ...(serviceSlug ? { serviceSlug } : {}),
    status,
  };

  const overview = useQuery({
    queryKey: qk.volunteers.overview(filters),
    queryFn: () => api.get<OverviewResponse>('/api/volunteers/overview', { ...filters, limit: 200 }),
  });

  const groups = useQuery({
    queryKey: qk.people.groups(),
    queryFn: () => api.get<GroupsResponse>('/api/groups'),
  });
  const services = useQuery({
    queryKey: qk.services.list(),
    queryFn: () => api.get<ServicesResponse>('/api/services'),
  });

  const rows = overview.data?.volunteers ?? [];
  const selected = rows.find((row) => row.id === openId) ?? null;
  const unrestrictedCount = rows.filter((row) => row.availability_rules === 0).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Volunteers"
        subtitle="Who is on the roster, what they do, and when they can be asked"
        actions={
          canAdd ? (
            <button type="button" className={primaryButtonClass} onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add volunteer
            </button>
          ) : undefined
        }
      />
      <AddPersonModal open={adding} onClose={() => setAdding(false)} title="Add volunteer" />
      <PhotoRequests />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <input
            type="search"
            className={`${inputClass} pl-10`}
            placeholder="Search name, phone or email…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            aria-label="Search volunteers"
          />
        </div>
        <select
          className={inputClass}
          value={groupSlug}
          onChange={(event) => setGroupSlug(event.target.value)}
          aria-label="Filter by group"
        >
          <option value="">All groups</option>
          {(groups.data?.groups ?? []).map((group) => (
            <option key={group.slug} value={group.slug}>
              {group.name}
            </option>
          ))}
        </select>
        <select
          className={inputClass}
          value={serviceSlug}
          onChange={(event) => setServiceSlug(event.target.value)}
          aria-label="Filter by service"
        >
          <option value="">All services</option>
          {(services.data?.services ?? []).map((service) => (
            <option key={service.slug} value={service.slug}>
              {service.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          className={`${inputClass} sm:w-48`}
          value={status}
          onChange={(event) => setStatus(event.target.value as 'active' | 'all')}
          aria-label="Filter by account status"
        >
          <option value="active">Active accounts</option>
          <option value="all">Everyone, including paused</option>
        </select>
        <div role="tablist" aria-label="How to show the roster" className="flex gap-2">
          {([
            { id: 'list' as const, label: 'List', icon: List },
            { id: 'calendar' as const, label: 'Calendar', icon: CalendarDays },
          ]).map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              onClick={() => setView(item.id)}
              className={`inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors ${
                view === item.id
                  ? 'bg-[#EA0029] text-white'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
              }`}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {overview.isPending ? (
        <ListSkeleton rows={6} lines={2} />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} what="the roster" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nobody matches these filters."
          hint="Try clearing the search, or widening the group and service."
        />
      ) : view === 'list' ? (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {rows.length} {rows.length === 1 ? 'person' : 'people'} · {unrestrictedCount} have stated no restriction,
            so they can be asked at any time.
          </p>
          <RosterTable rows={rows} onOpen={setOpenId} />
          <RosterCards rows={rows} onOpen={setOpenId} />
        </>
      ) : (
        <FortnightView rows={rows} />
      )}

      {selected ? (
        <VolunteerDrawer
          row={selected}
          services={services.data?.services ?? []}
          canManage={canAdd}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

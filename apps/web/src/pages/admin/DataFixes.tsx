/**
 * Admin > Data fixes.
 *
 * The small corrections that used to need someone to edit the database by
 * hand. Admin only. Every change asks for a reason and lands in the audit log
 * with the before and after, so nothing here is silent.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, UserX, Wrench } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';

interface NeverSetUp {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: string;
  createdAt: string;
  hasLiveInvite: boolean;
}

interface FoundTrip {
  trip: { id: string; reference: string; status: string; pickupAt: string; cancellationReason: string | null };
  canCorrect: boolean;
}

const STATUS_LABEL: Record<string, string> = { completed: 'Done', cancelled: 'Cancelled' };
const ROLE_LABEL: Record<string, string> = { dispatcher: 'Coordinator', admin: 'Admin', volunteer: 'Volunteer' };

function NeverSetUpSection(): React.JSX.Element {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['admin', 'data-fixes', 'never-set-up'],
    queryFn: () => api.get<{ people: NeverSetUp[] }>('/api/admin/data-fixes/never-set-up'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.post(`/api/users/${id}/deactivate`, { reason: 'Never set up their account (Data fixes)' }),
    onSuccess: () => {
      toast.success('Removed.');
      setConfirming(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'data-fixes'] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <section className={cardClass}>
      <div className="p-5 md:p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Accounts never set up</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Added more than a week ago and never chose a password. Removing one clears their phone and email and is kept in
          the audit log.
        </p>
        <div className="mt-4">
          {list.isPending ? (
            <ListSkeleton rows={2} lines={2} />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} what="the list" />
          ) : list.data.people.length === 0 ? (
            <EmptyState icon={UserX} title="Nobody to tidy up." hint="Everyone added more than a week ago has set up their account." />
          ) : (
            <ul className="space-y-2">
              {list.data.people.map((p) => (
                <li key={p.id} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 dark:text-white">{p.fullName}</p>
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        {[ROLE_LABEL[p.role] ?? p.role, p.email, p.phone].filter(Boolean).join(' · ')}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Added {formatDate(p.createdAt)}
                        {p.hasLiveInvite ? ' · their invitation link still works' : ' · invitation expired'}
                      </p>
                    </div>
                    {confirming === p.id ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="min-h-[44px] rounded-lg bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(p.id)}
                        >
                          Remove {p.fullName.split(' ')[0]}
                        </button>
                        <button type="button" className={secondaryButtonClass} onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button type="button" className={secondaryButtonClass} onClick={() => setConfirming(p.id)}>
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function TripOutcomeSection(): React.JSX.Element {
  const [reference, setReference] = useState('');
  const [found, setFound] = useState<FoundTrip | null>(null);
  const [reason, setReason] = useState('');
  const [searching, setSearching] = useState(false);

  const lookUp = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!reference.trim()) return;
    setSearching(true);
    try {
      setFound(await api.get<FoundTrip>(`/api/admin/data-fixes/trips/by-reference/${encodeURIComponent(reference.trim())}`));
      setReason('');
    } catch (err) {
      setFound(null);
      toast.error(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const correct = useMutation({
    mutationFn: (status: 'completed' | 'cancelled') =>
      api.post<{ trip: { status: string } }>(`/api/admin/data-fixes/trips/${found!.trip.id}/outcome`, { status, reason }),
    onSuccess: (res) => {
      toast.success(`Now marked ${STATUS_LABEL[res.trip.status] ?? res.trip.status}. Logged in the audit log.`);
      setFound((prev) => (prev ? { ...prev, trip: { ...prev.trip, status: res.trip.status } } : prev));
      setReason('');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const target = found?.trip.status === 'completed' ? 'cancelled' : 'completed';

  return (
    <section className={cardClass}>
      <div className="p-5 md:p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Correct how a ride ended</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          For a ride marked done that never happened, or cancelled by mistake after it was driven. Open rides are changed
          on the board as usual.
        </p>
        <form onSubmit={(e) => void lookUp(e)} className="mt-4 flex gap-2">
          <label htmlFor="fix-reference" className="sr-only">Ride reference</label>
          <input
            id="fix-reference"
            className={inputClass}
            placeholder="Ride reference (RVC-…)"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            autoCapitalize="characters"
          />
          <button type="submit" className={secondaryButtonClass} disabled={searching}>
            <Search className="h-4 w-4" aria-hidden="true" />
            Find
          </button>
        </form>

        {found ? (
          <div className="mt-4 rounded-lg bg-slate-50 p-4 dark:bg-slate-800/60">
            <p className="font-medium text-slate-900 dark:text-white">{found.trip.reference}</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Pickup {formatDateTime(found.trip.pickupAt)} · now marked{' '}
              <strong>{STATUS_LABEL[found.trip.status] ?? found.trip.status.replace('_', ' ')}</strong>
            </p>
            {found.canCorrect ? (
              <div className="mt-3 space-y-3">
                <div>
                  <label htmlFor="fix-reason" className={labelClass}>Why (kept in the audit log)</label>
                  <input
                    id="fix-reason"
                    className={inputClass}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Passenger was in hospital, ride never happened"
                  />
                </div>
                <button
                  type="button"
                  className={primaryButtonClass}
                  disabled={reason.trim().length < 3 || correct.isPending}
                  onClick={() => correct.mutate(target)}
                >
                  Mark as {STATUS_LABEL[target]}
                </button>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">This ride is still open. Change it from the board.</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function DataFixesPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader title="Data fixes" subtitle="Small corrections, each with a reason and logged" />
      <TripOutcomeSection />
      <NeverSetUpSection />
      <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <Wrench className="h-4 w-4" aria-hidden="true" />
        Every change here shows in Admin &gt; Audit log with who made it and why.
      </p>
    </div>
  );
}

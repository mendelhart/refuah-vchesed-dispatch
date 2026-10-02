/**
 * Admin > Google sign-in (item 9). An administrator chooses, by name, who
 * may sign in with Google. The person's account email must be their Google
 * address. Password sign-in keeps working for everyone.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';

interface Approval { id: string; userId: string; fullName: string; email: string; role: string; approvedAt: string; approvedBy: string | null; lastUsedAt: string | null; stillMatches: boolean }
interface Person { id: string; fullName: string; email: string; role: string }

const ROLE: Record<string, string> = { admin: 'Administrator', dispatcher: 'Coordinator', volunteer: 'Volunteer' };
const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Toronto' });

export function GoogleSignInAdminPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['google-signin'], queryFn: () => api.get<{ approvals: Approval[]; people: Person[] }>('/api/admin/google-signin') });
  const done = (msg: string) => { toast.success(msg); void queryClient.invalidateQueries({ queryKey: ['google-signin'] }); };
  const approve = useMutation({
    mutationFn: () => api.post('/api/admin/google-signin', { userId }),
    onSuccess: () => { setUserId(''); done('Approved. They can now sign in with Google.'); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/google-signin/${id}/revoke`),
    onSuccess: () => { setConfirmRevoke(null); done('Removed. They sign in with their password from now on.'); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Google sign-in" subtitle="Only the people listed here can sign in with Google. Everyone can still use their password." />
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} what="the list" /> : null}
      {q.isPending ? <ListSkeleton rows={2} lines={2} /> : null}
      {q.data ? (
        <>
          <form className={`${cardClass} space-y-3 p-4`} onSubmit={(e) => { e.preventDefault(); if (userId) approve.mutate(); }}>
            <div>
              <label htmlFor="gs-person" className={labelClass}>Approve a person</label>
              <select id="gs-person" className={inputClass} value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose someone…</option>
                {q.data.people.map((p) => <option key={p.id} value={p.id}>{p.fullName} · {p.email} · {ROLE[p.role] ?? p.role}</option>)}
              </select>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">The email on their account must be the Google address they will use.</p>
            </div>
            <button type="submit" className={primaryButtonClass} disabled={!userId || approve.isPending}>Approve for Google sign-in</button>
          </form>

          {q.data.approvals.length === 0 ? <EmptyState title="Nobody is approved yet" hint="Until someone is approved here, Google sign-in lets nobody in." /> : (
            <ul className="space-y-2" aria-label="Approved people">
              {q.data.approvals.map((a) => (
                <li key={a.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2 p-4`}>
                  <span className="min-w-0 text-sm text-slate-800 dark:text-slate-100">
                    <span className="block font-semibold text-slate-900 dark:text-white">{a.fullName}</span>
                    <span className="block break-words">{a.email} · {ROLE[a.role] ?? a.role}</span>
                    <span className="block text-slate-600 dark:text-slate-300">Approved {day(a.approvedAt)}{a.approvedBy ? ` by ${a.approvedBy}` : ''} · {a.lastUsedAt ? `last used ${day(a.lastUsedAt)}` : 'not used yet'}</span>
                    {!a.stillMatches ? <span className="mt-1 block font-medium text-[#C80023] dark:text-red-400">Not working: the account’s email changed, or the account is paused.</span> : null}
                  </span>
                  {confirmRevoke === a.id ? (
                    <span className="flex gap-2">
                      <button type="button" className={primaryButtonClass} onClick={() => revoke.mutate(a.id)} disabled={revoke.isPending}>Yes, remove</button>
                      <button type="button" className={secondaryButtonClass} onClick={() => setConfirmRevoke(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button type="button" className={secondaryButtonClass} onClick={() => setConfirmRevoke(a.id)} aria-label={`Remove Google sign-in for ${a.fullName}`}>Remove</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}

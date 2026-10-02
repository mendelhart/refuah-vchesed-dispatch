/**
 * Lift assist (item 6). One page, by role:
 *   everyone     "I can help lift and carry" (opt in or out)
 *   volunteers   requests they were asked to, with Yes / No
 *   coordinators ask for help, see suggested people by name, ask exactly
 *                them once, follow the answers, pick the lead
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HandHelping } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';

interface Request {
  id: string; title: string; location: string; startsAt: string; durationMinutes: number; needed: number; accepted: number;
  status: 'open' | 'filled' | 'cancelled'; notes: string | null; leadName: string | null; myStatus: string | null;
  invites?: Array<{ userId: string; fullName: string; status: string }>;
}
interface Preview { needed: number; count: number; recipients: Array<{ id: string; fullName: string; area: string | null }>; audienceHash: string; enough: boolean }

const STATUS: Record<Request['status'], string> = { open: 'Looking for helpers', filled: 'All set', cancelled: 'Cancelled' };

function HelperToggle(): React.JSX.Element {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['lift', 'helper'], queryFn: () => api.get<{ willing: boolean }>('/api/lift-assist/helper') });
  // Shown at once; put back if the server says no.
  const [shown, setShown] = useState<boolean | null>(null);
  const willing = shown ?? q.data?.willing ?? false;
  const set = useMutation({
    mutationFn: (next: boolean) => api.put('/api/lift-assist/helper', { willing: next }),
    onMutate: (next: boolean) => setShown(next),
    onSuccess: (_d, next) => {
      toast.success(next ? 'Thank you. You may be asked to help lift.' : 'You will not be asked to help lift.');
      void queryClient.invalidateQueries({ queryKey: ['lift', 'helper'] });
    },
    onError: (e: unknown) => { setShown(null); toast.error(errorMessage(e)); },
  });
  return (
    <section className={`${cardClass} p-4`}>
      <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-900 dark:text-white">
        <input type="checkbox" className="h-5 w-5 accent-[#C80023]" checked={willing} disabled={q.isPending}
          onChange={(e) => set.mutate(e.target.checked)} />
        <span>
          <span className="block font-medium">I can help lift and carry</span>
          <span className="block text-slate-600 dark:text-slate-300">For things like moving a hospital bed. You are only asked when you are free, and you can always say no.</span>
        </span>
      </label>
    </section>
  );
}

function RequestCard({ r, staff }: { r: Request; staff: boolean }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['lift', 'list'] });
  const answer = useMutation({
    mutationFn: (accept: boolean) => api.post<{ status: string }>(`/api/lift-assist/${r.id}/respond`, { accept }),
    onSuccess: (_d, accept) => { toast.success(accept ? 'Thank you. You are on the team.' : 'Thanks for letting us know.'); refresh(); },
    onError: (e: unknown) => { toast.error(errorMessage(e)); refresh(); },
  });
  const find = useMutation({
    mutationFn: (ids?: string[]) => api.post<Preview>(`/api/lift-assist/${r.id}/preview`, ids ? { userIds: ids } : {}),
    onSuccess: (p) => { setPreview(p); setPicked(new Set(p.recipients.map((x) => x.id))); },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const invite = useMutation({
    mutationFn: async () => {
      const exact = await api.post<Preview>(`/api/lift-assist/${r.id}/preview`, { userIds: [...picked] });
      return api.post<{ invited: number }>(`/api/lift-assist/${r.id}/invite`, { userIds: [...picked], audienceHash: exact.audienceHash, confirm: true });
    },
    onSuccess: (res) => { toast.success(`Asked ${res.invited} ${res.invited === 1 ? 'person' : 'people'}.`); setAsking(false); setPreview(null); refresh(); },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const lead = useMutation({
    mutationFn: (userId: string) => api.post(`/api/lift-assist/${r.id}/lead`, { userId }),
    onSuccess: () => { toast.success('Lead changed.'); refresh(); },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });

  return (
    <li className={`${cardClass} p-4`}>
      <p className="font-medium text-slate-900 dark:text-white">{r.title}</p>
      <p className="text-sm text-slate-700 dark:text-slate-200">{formatDateTime(r.startsAt)} · {r.location}</p>
      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
        {STATUS[r.status]}: {r.accepted} of {r.needed} said yes{r.leadName ? ` · ${r.leadName} leads` : ''}
      </p>
      {r.notes ? <p className="text-sm text-slate-600 dark:text-slate-300">{r.notes}</p> : null}

      {!staff && r.myStatus === 'invited' && r.status === 'open' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={primaryButtonClass} disabled={answer.isPending} onClick={() => answer.mutate(true)}>Yes, I can help</button>
          <button type="button" className={secondaryButtonClass} disabled={answer.isPending} onClick={() => answer.mutate(false)}>I can't</button>
        </div>
      ) : null}
      {!staff && r.myStatus === 'accepted' ? <p className="mt-2 text-sm font-medium text-green-800 dark:text-green-300">You said yes. Thank you.</p> : null}

      {staff && r.invites?.length ? (
        <ul className="mt-2 space-y-1 text-sm text-slate-800 dark:text-slate-100">
          {r.invites.map((i) => (
            <li key={i.userId} className="flex flex-wrap items-center gap-2">
              {i.fullName}: {i.status === 'accepted' ? 'yes' : i.status === 'declined' ? 'no' : 'no answer yet'}
              {i.status === 'accepted' && r.leadName !== i.fullName ? (
                <button type="button" className="min-h-[44px] text-sm font-medium text-[#C80023] underline dark:text-red-400" onClick={() => lead.mutate(i.userId)}>Make lead</button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {staff && r.status === 'open' ? (
        <button type="button" className={`${secondaryButtonClass} mt-3`} onClick={() => { setAsking(true); setPreview(null); find.mutate(undefined); }}>Find helpers</button>
      ) : null}

      <Modal open={asking} title={`Helpers for "${r.title}"`} onClose={() => { setAsking(false); setPreview(null); }}>
        {find.isPending || !preview ? <ListSkeleton rows={1} lines={3} /> : preview.recipients.length === 0 ? (
          <p className="text-sm text-slate-700 dark:text-slate-200">Nobody who offered to help lift is free then. Try another time or a wider area.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-700 dark:text-slate-200">These people offered to help lift and are free then. {r.needed} are needed. Untick anyone you do not want to ask.</p>
            <ul className="space-y-1">
              {preview.recipients.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-800 dark:text-slate-100">
                    <input type="checkbox" className="h-5 w-5 accent-[#C80023]" checked={picked.has(p.id)}
                      onChange={() => setPicked((cur) => { const n = new Set(cur); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} />
                    {p.fullName}{p.area ? ` · ${p.area}` : ''}
                  </label>
                </li>
              ))}
            </ul>
            {picked.size < r.needed ? <p className="text-sm font-medium text-amber-800 dark:text-amber-300">That is fewer people than needed; some may say no.</p> : null}
            <button type="button" className={primaryButtonClass} disabled={picked.size === 0 || invite.isPending} onClick={() => invite.mutate()}>
              {invite.isPending ? 'Asking…' : `Ask these ${picked.size} ${picked.size === 1 ? 'person' : 'people'}`}
            </button>
          </div>
        )}
      </Modal>
    </li>
  );
}

function NewRequest(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [when, setWhen] = useState('');
  const [needed, setNeeded] = useState('2');
  const [area, setArea] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/api/lift-assist', { title, location, startsAt: new Date(when).toISOString(), needed: Number(needed), area: area || null }),
    onSuccess: () => { toast.success('Request created. Now find helpers.'); setTitle(''); setLocation(''); setWhen(''); void queryClient.invalidateQueries({ queryKey: ['lift', 'list'] }); },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  return (
    <form className={`${cardClass} space-y-3 p-4`} onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <h2 className="font-semibold text-slate-900 dark:text-white">Ask for lifting help</h2>
      <div><label htmlFor="la-title" className={labelClass}>What needs lifting</label><input id="la-title" className={inputClass} value={title} placeholder="Move a hospital bed upstairs" onChange={(e) => setTitle(e.target.value)} /></div>
      <div><label htmlFor="la-where" className={labelClass}>Where</label><input id="la-where" className={inputClass} value={location} onChange={(e) => setLocation(e.target.value)} /></div>
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <div><label htmlFor="la-when" className={labelClass}>When</label><input id="la-when" type="datetime-local" className={inputClass} value={when} onChange={(e) => setWhen(e.target.value)} /></div>
        <div><label htmlFor="la-needed" className={labelClass}>People needed</label><input id="la-needed" type="number" inputMode="numeric" min={2} max={10} className={inputClass} value={needed} onChange={(e) => setNeeded(e.target.value)} /></div>
      </div>
      <div><label htmlFor="la-area" className={labelClass}>Only people in this area (optional)</label><input id="la-area" className={inputClass} value={area} placeholder="Outremont" onChange={(e) => setArea(e.target.value)} /></div>
      <button type="submit" className={primaryButtonClass} disabled={!title.trim() || location.trim().length < 3 || !when || create.isPending}>Create request</button>
    </form>
  );
}

export function LiftAssistPage(): React.JSX.Element {
  const { user } = useAuth();
  const staff = user?.role === 'dispatcher' || user?.role === 'admin';
  const list = useQuery({ queryKey: ['lift', 'list'], queryFn: () => api.get<{ requests: Request[] }>('/api/lift-assist'), refetchInterval: 60_000 });
  const rows = list.data?.requests ?? [];
  return (
    <div className="space-y-4">
      <PageHeader title="Lift assist" subtitle={staff ? 'A few helpers for heavy lifting, one lead' : 'Helping lift and carry'} />
      {!staff ? <HelperToggle /> : <NewRequest />}
      {list.isPending ? <ListSkeleton rows={2} lines={3} /> : null}
      {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} what="the requests" /> : null}
      {list.data && rows.length === 0 ? (
        <EmptyState icon={HandHelping} title={staff ? 'No requests yet' : 'Nothing to answer'} hint={staff ? undefined : 'When you are asked to help lift, it shows here.'} />
      ) : null}
      <ul className="space-y-2">{rows.map((r) => <RequestCard key={r.id} r={r} staff={staff} />)}</ul>
    </div>
  );
}

/**
 * Food (item 5, coordinators). Four tabs, each one job:
 *   Kitchen   who is coming to each preparation slot, and what is being made
 *   Stock     what is on hand, what is low, count deliveries in or use out
 *   Runs      distribution runs: route, how many people, who is driving
 *   Shopping  write a list, choose a few people, preview, then send once
 */
import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CookingPot, ShoppingBasket, Truck, Warehouse } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';
import { Modal } from '@/components/Modal';
import { dayLabel, groupByDay, parseShoppingLines, type SlotOccurrence } from './food-model';
import { SlotCard } from './Kitchen';

type Tab = 'kitchen' | 'stock' | 'runs' | 'shopping';
const TABS: Array<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'kitchen', label: 'Kitchen', icon: CookingPot },
  { id: 'stock', label: 'Stock', icon: Warehouse },
  { id: 'runs', label: 'Runs', icon: Truck },
  { id: 'shopping', label: 'Shopping', icon: ShoppingBasket },
];

interface Item { id: string; name: string; unit: string; onHand: number; parLevel: number | null; low: boolean; vendorName: string | null }
interface Run { id: string; runDate: string; route: string; recipientsCount: number; status: string; volunteers: string[] }
interface ListRow { id: string; title: string; items: number; lastSentAt: string | null }
interface Person { id: string; fullName: string; role: string }

function KitchenTab(): React.JSX.Element {
  const q = useQuery({ queryKey: ['food', 'upcoming', 'staff'], queryFn: () => api.get<{ slots: SlotOccurrence[] }>('/api/food/prep-slots/upcoming', { days: 14 }) });
  const days = groupByDay(q.data?.slots ?? []);
  if (q.isPending) return <ListSkeleton rows={3} lines={3} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} what="the kitchen times" />;
  if (days.length === 0) return <EmptyState icon={CookingPot} title="No preparation slots yet" hint="Slots are set up once and repeat every week." />;
  return (
    <div className="space-y-4">
      {days.map((day) => (
        <section key={day.date} aria-labelledby={`fday-${day.date}`}>
          <h2 id={`fday-${day.date}`} className="mb-2 text-base font-semibold text-slate-900 dark:text-white">{dayLabel(day.date)}</h2>
          <ul className="space-y-2">{day.slots.map((s) => <SlotCard key={`${s.slotId}-${s.date}`} slot={s} />)}</ul>
        </section>
      ))}
    </div>
  );
}

function StockTab(): React.JSX.Element {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['food', 'items'], queryFn: () => api.get<{ items: Item[] }>('/api/food/items') });
  const [adjusting, setAdjusting] = useState<Item | null>(null);
  const [change, setChange] = useState('');
  const [reason, setReason] = useState('');
  const [newName, setNewName] = useState('');
  const [newUnit, setNewUnit] = useState('each');
  const [newPar, setNewPar] = useState('');
  const adjust = useMutation({
    mutationFn: () => api.post<{ onHand: number }>(`/api/food/items/${adjusting?.id ?? ''}/adjust`, { change: Number(change), reason }),
    onSuccess: (r) => {
      toast.success(`${adjusting?.name ?? 'Item'}: ${r.onHand} ${adjusting?.unit ?? ''} on hand.`);
      setAdjusting(null); setChange(''); setReason('');
      void queryClient.invalidateQueries({ queryKey: ['food', 'items'] });
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const add = useMutation({
    mutationFn: () => api.post('/api/food/items', { name: newName, unit: newUnit || 'each', parLevel: newPar ? Number(newPar) : null }),
    onSuccess: () => {
      toast.success(`${newName} added.`);
      setNewName(''); setNewUnit('each'); setNewPar('');
      void queryClient.invalidateQueries({ queryKey: ['food', 'items'] });
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-4">
      {q.isPending ? <ListSkeleton rows={3} lines={2} /> : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} what="the stock" /> : null}
      {q.data && items.length === 0 ? <EmptyState icon={Warehouse} title="No items yet" hint="Add what the kitchen keeps, below." /> : null}
      <ul className="space-y-2">
        {items.map((it) => (
          <li key={it.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2 p-4`}>
            <span>
              <span className="block font-medium text-slate-900 dark:text-white">{it.name}</span>
              <span className="block text-sm text-slate-700 dark:text-slate-200">
                {it.onHand} {it.unit} on hand{it.parLevel !== null ? `, keep ${it.parLevel}` : ''}{it.vendorName ? ` · from ${it.vendorName}` : ''}
              </span>
              {it.low ? (
                <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Running low
                </span>
              ) : null}
            </span>
            <button type="button" className={secondaryButtonClass} onClick={() => setAdjusting(it)}>Count in or out</button>
          </li>
        ))}
      </ul>
      <form className={`${cardClass} space-y-3 p-4`} onSubmit={(e) => { e.preventDefault(); if (newName.trim()) add.mutate(); }}>
        <h2 className="font-semibold text-slate-900 dark:text-white">Add an item</h2>
        <div><label htmlFor="item-name" className={labelClass}>Name</label><input id="item-name" className={inputClass} value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <div><label htmlFor="item-unit" className={labelClass}>Counted in</label><input id="item-unit" className={inputClass} value={newUnit} placeholder="each, kg, litre" onChange={(e) => setNewUnit(e.target.value)} /></div>
          <div><label htmlFor="item-par" className={labelClass}>Warn me below (optional)</label><input id="item-par" type="number" inputMode="decimal" min={0} className={inputClass} value={newPar} onChange={(e) => setNewPar(e.target.value)} /></div>
        </div>
        <button type="submit" className={primaryButtonClass} disabled={!newName.trim() || add.isPending}>Add item</button>
      </form>
      <Modal open={Boolean(adjusting)} title={`Count ${adjusting?.name ?? ''}`} onClose={() => setAdjusting(null)}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); adjust.mutate(); }}>
          <p className="text-sm text-slate-700 dark:text-slate-200">Use a plain number to count a delivery in, or a minus sign for what was used (for example −5).</p>
          <div><label htmlFor="adj-change" className={labelClass}>How many {adjusting?.unit}</label><input id="adj-change" type="number" inputMode="decimal" className={inputClass} value={change} onChange={(e) => setChange(e.target.value)} /></div>
          <div><label htmlFor="adj-reason" className={labelClass}>Why</label><input id="adj-reason" className={inputClass} value={reason} placeholder="Delivery, Friday cooking, spoiled" onChange={(e) => setReason(e.target.value)} /></div>
          <button type="submit" className={primaryButtonClass} disabled={!change || !reason.trim() || adjust.isPending}>Save count</button>
        </form>
      </Modal>
    </div>
  );
}

function RunsTab(): React.JSX.Element {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['food', 'runs'], queryFn: () => api.get<{ runs: Run[] }>('/api/food/runs') });
  const done = useMutation({
    mutationFn: (id: string) => api.post(`/api/food/runs/${id}/status`, { status: 'done' }),
    onSuccess: () => { toast.success('Run marked done.'); void queryClient.invalidateQueries({ queryKey: ['food', 'runs'] }); },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const runs = q.data?.runs ?? [];
  if (q.isPending) return <ListSkeleton rows={3} lines={2} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} what="the runs" />;
  if (runs.length === 0) return <EmptyState icon={Truck} title="No distribution runs yet" />;
  return (
    <ul className="space-y-2">
      {runs.map((r) => (
        <li key={r.id} className={`${cardClass} p-4`}>
          <p className="font-medium text-slate-900 dark:text-white">{dayLabel(r.runDate)} · {r.status === 'done' ? 'Done' : r.status === 'cancelled' ? 'Cancelled' : 'Planned'}</p>
          <p className="whitespace-pre-line text-sm text-slate-700 dark:text-slate-200">{r.route}</p>
          <p className="text-sm text-slate-600 dark:text-slate-300">{r.recipientsCount} people · {r.volunteers.length ? r.volunteers.join(', ') : 'No volunteers yet'}</p>
          {r.status === 'planned' ? <button type="button" className={`${secondaryButtonClass} mt-2`} onClick={() => done.mutate(r.id)}>Mark done</button> : null}
        </li>
      ))}
    </ul>
  );
}

function ShoppingTab(): React.JSX.Element {
  const queryClient = useQueryClient();
  const lists = useQuery({ queryKey: ['food', 'lists'], queryFn: () => api.get<{ lists: ListRow[] }>('/api/food/shopping-lists') });
  const people = useQuery({ queryKey: ['users', 'active'], queryFn: () => api.get<{ users: Person[] }>('/api/users', { status: 'active', limit: 500 }) });
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState('');
  const [sendFor, setSendFor] = useState<ListRow | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<{ count: number; recipients: Array<{ fullName: string }>; audienceHash: string; alreadySent: boolean } | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/api/food/shopping-lists', { title, items: parseShoppingLines(lines) }),
    onSuccess: () => { toast.success('List saved.'); setTitle(''); setLines(''); void queryClient.invalidateQueries({ queryKey: ['food', 'lists'] }); },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const doPreview = useMutation({
    mutationFn: () => api.post<NonNullable<typeof preview>>(`/api/food/shopping-lists/${sendFor?.id ?? ''}/preview`, { userIds: [...picked] }),
    onSuccess: (p) => setPreview(p),
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const send = useMutation({
    mutationFn: () => api.post<{ sentTo: number }>(`/api/food/shopping-lists/${sendFor?.id ?? ''}/send`, { userIds: [...picked], audienceHash: preview?.audienceHash, confirm: true }),
    onSuccess: (r) => {
      toast.success(`Sent to ${r.sentTo} ${r.sentTo === 1 ? 'person' : 'people'}.`);
      setSendFor(null); setPreview(null); setPicked(new Set());
      void queryClient.invalidateQueries({ queryKey: ['food', 'lists'] });
    },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const visible = useMemo(
    () => (people.data?.users ?? []).filter((p) => p.fullName.toLowerCase().includes(search.toLowerCase())).slice(0, 50),
    [people.data, search],
  );
  const parsed = parseShoppingLines(lines);

  return (
    <div className="space-y-4">
      <form className={`${cardClass} space-y-3 p-4`} onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <h2 className="font-semibold text-slate-900 dark:text-white">New shopping list</h2>
        <div><label htmlFor="list-title" className={labelClass}>Name</label><input id="list-title" className={inputClass} value={title} placeholder="Thursday shopping" onChange={(e) => setTitle(e.target.value)} /></div>
        <div>
          <label htmlFor="list-lines" className={labelClass}>One item per line</label>
          <textarea id="list-lines" rows={5} className={`${inputClass} py-2`} value={lines} placeholder={'6 dozen eggs\n10 kg flour\nsalt'} onChange={(e) => setLines(e.target.value)} />
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{parsed.length} {parsed.length === 1 ? 'item' : 'items'}</p>
        </div>
        <button type="submit" className={primaryButtonClass} disabled={!title.trim() || parsed.length === 0 || create.isPending}>Save list</button>
      </form>
      {lists.isError ? <ErrorState error={lists.error} onRetry={() => void lists.refetch()} what="the lists" /> : null}
      <ul className="space-y-2">
        {(lists.data?.lists ?? []).map((l) => (
          <li key={l.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2 p-4`}>
            <span>
              <span className="block font-medium text-slate-900 dark:text-white">{l.title}</span>
              <span className="block text-sm text-slate-600 dark:text-slate-300">{l.items} items{l.lastSentAt ? ' · sent' : ' · not sent yet'}</span>
            </span>
            <button type="button" className={secondaryButtonClass} onClick={() => { setSendFor(l); setPreview(null); setPicked(new Set()); }}>Send to…</button>
          </li>
        ))}
      </ul>

      <Modal open={Boolean(sendFor)} title={`Send "${sendFor?.title ?? ''}"`} onClose={() => { setSendFor(null); setPreview(null); }}>
        {!preview ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-700 dark:text-slate-200">Choose up to 25 people. Nothing is sent until you check the list of names and confirm.</p>
            <div><label htmlFor="send-search" className={labelClass}>Find a person</label><input id="send-search" className={inputClass} value={search} onChange={(e) => setSearch(e.target.value)} /></div>
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {visible.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-[44px] items-center gap-3 rounded-lg px-2 text-sm text-slate-800 dark:text-slate-100">
                    <input type="checkbox" className="h-5 w-5 accent-[#C80023]" checked={picked.has(p.id)}
                      disabled={!picked.has(p.id) && picked.size >= 25}
                      onChange={() => setPicked((cur) => { const n = new Set(cur); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} />
                    {p.fullName}
                  </label>
                </li>
              ))}
            </ul>
            <button type="button" className={primaryButtonClass} disabled={picked.size === 0 || doPreview.isPending} onClick={() => doPreview.mutate()}>
              Check who gets it ({picked.size})
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {preview.alreadySent ? (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-100">
                These exact people already got this list. It will not be sent again.
              </p>
            ) : (
              <p className="text-sm font-medium text-slate-900 dark:text-white">This will go to {preview.count} {preview.count === 1 ? 'person' : 'people'}:</p>
            )}
            <ul className="list-disc space-y-1 ps-5 text-sm text-slate-800 dark:text-slate-100">{preview.recipients.map((r) => <li key={r.fullName}>{r.fullName}</li>)}</ul>
            <div className="flex flex-wrap gap-2">
              {!preview.alreadySent ? (
                <button type="button" className={primaryButtonClass} disabled={send.isPending} onClick={() => send.mutate()}>
                  {send.isPending ? 'Sending…' : `Yes, send to ${preview.count}`}
                </button>
              ) : null}
              <button type="button" className={secondaryButtonClass} onClick={() => setPreview(null)}>Change people</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export function FoodPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('kitchen');
  return (
    <div className="space-y-4">
      <PageHeader title="Food" subtitle="Kitchen, stock, runs and shopping" />
      <div role="tablist" aria-label="Food sections" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`inline-flex min-h-[44px] items-center gap-2 rounded-full px-4 text-sm font-medium ${tab === t.id ? 'bg-[#C80023] text-white' : 'border border-slate-300 bg-white text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100'}`}>
            <t.icon className="h-4 w-4" aria-hidden="true" />{t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'kitchen' ? <KitchenTab /> : tab === 'stock' ? <StockTab /> : tab === 'runs' ? <RunsTab /> : <ShoppingTab />}
      </div>
    </div>
  );
}

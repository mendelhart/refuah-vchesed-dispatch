/**
 * Help in the kitchen (item 5, food operations). Upcoming preparation slots
 * for the next two weeks, how many people each still needs, and one button
 * to sign up or to withdraw.
 */
import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CookingPot } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { formatMinuteOfDay } from '@/lib/format';
import { EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';
import { dayLabel, groupByDay, staffingLabel, type SlotOccurrence } from './food-model';

export function SlotCard({ slot, onSignUp, onWithdraw, busy }: {
  slot: SlotOccurrence; onSignUp?: () => void; onWithdraw?: () => void; busy?: boolean;
}): React.JSX.Element {
  return (
    <li className={`${cardClass} p-4`}>
      <p className="font-medium text-slate-900 dark:text-white">{slot.title}</p>
      <p className="text-sm text-slate-700 dark:text-slate-200">
        {formatMinuteOfDay(slot.startMinute)} to {formatMinuteOfDay(slot.endMinute)}
      </p>
      <p className={`mt-1 text-sm font-medium ${slot.stillNeeded > 0 ? 'text-amber-800 dark:text-amber-300' : 'text-green-800 dark:text-green-300'}`}>
        {staffingLabel(slot)}
      </p>
      {slot.names?.length ? <p className="text-sm text-slate-600 dark:text-slate-300">Coming: {slot.names.join(', ')}</p> : null}
      {slot.items.length ? (
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Making: {slot.items.map((i) => `${i.quantity} ${i.unit} ${i.name}`).join(', ')}
        </p>
      ) : null}
      {slot.notes ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{slot.notes}</p> : null}
      {slot.iAmSignedUp && onWithdraw ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-green-800 dark:text-green-300">You are signed up. Thank you.</span>
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onWithdraw}>I can no longer come</button>
        </div>
      ) : null}
      {!slot.iAmSignedUp && slot.stillNeeded > 0 && onSignUp ? (
        <button type="button" className={`${primaryButtonClass} mt-3`} disabled={busy} onClick={onSignUp}>I can help</button>
      ) : null}
    </li>
  );
}

export function KitchenPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['food', 'upcoming'],
    queryFn: () => api.get<{ slots: SlotOccurrence[] }>('/api/food/prep-slots/upcoming', { days: 14 }),
  });
  const act = useMutation({
    mutationFn: ({ slot, kind }: { slot: SlotOccurrence; kind: 'signup' | 'withdraw' }) =>
      api.post(`/api/food/prep-slots/${slot.slotId}/${kind}`, { onDate: slot.date }),
    onSuccess: (_d, v) => {
      toast.success(v.kind === 'signup' ? 'You are signed up.' : 'You are no longer signed up.');
      void queryClient.invalidateQueries({ queryKey: ['food'] });
    },
    onError: (e: unknown) => {
      toast.error(errorMessage(e));
      void queryClient.invalidateQueries({ queryKey: ['food'] });
    },
  });
  const days = groupByDay(q.data?.slots ?? []);
  return (
    <div className="space-y-4">
      <PageHeader title="Help in the kitchen" subtitle="Cooking and packing in the next two weeks" />
      {q.isPending ? <ListSkeleton rows={3} lines={3} /> : null}
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} what="the kitchen times" /> : null}
      {q.data && days.length === 0 ? <EmptyState icon={CookingPot} title="Nothing planned yet" hint="When the kitchen needs help, the times show here." /> : null}
      {days.map((day) => (
        <section key={day.date} aria-labelledby={`day-${day.date}`}>
          <h2 id={`day-${day.date}`} className="mb-2 text-base font-semibold text-slate-900 dark:text-white">{dayLabel(day.date)}</h2>
          <ul className="space-y-2">
            {day.slots.map((slot) => (
              <SlotCard
                key={`${slot.slotId}-${slot.date}`}
                slot={slot}
                busy={act.isPending}
                onSignUp={() => act.mutate({ slot, kind: 'signup' })}
                onWithdraw={() => act.mutate({ slot, kind: 'withdraw' })}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

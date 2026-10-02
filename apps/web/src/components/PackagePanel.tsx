/** Trip detail: the package on a delivery and its proof of delivery (item 6).
 *  Visible to coordinators and to the trip's own driver. */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Package as PackageIcon, CheckCircle2 } from 'lucide-react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDateTime, formatPhone } from '@/lib/format';
import { inputClass, labelClass, primaryButtonClass } from './states';
import { SIZE_LABELS, type PackageSize } from './package-model';

interface PackageView {
  description: string; size: PackageSize; weightKg: number | null; recipientName: string; recipientPhone: string | null;
  handlingNotes: string | null; deliveredAt: string | null; receivedBy: string | null; deliveryNote: string | null;
}

export function PackagePanel({ tripId, cardClass, canMarkDelivered }: { tripId: string; cardClass: string; canMarkDelivered: boolean }): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ['trips', tripId, 'package'],
    queryFn: async () => {
      try {
        return (await api.get<{ package: PackageView }>(`/api/trips/${tripId}/package`)).package;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
  const [receivedBy, setReceivedBy] = useState('');
  const [note, setNote] = useState('');
  const mark = useMutation({
    mutationFn: () => api.post(`/api/trips/${tripId}/package/delivered`, { receivedBy, note: note || null }),
    onSuccess: () => { toast.success('Marked delivered.'); void queryClient.invalidateQueries({ queryKey: ['trips', tripId, 'package'] }); },
    onError: (e: unknown) => toast.error(errorMessage(e)),
  });
  const p = q.data;
  if (!p) return null;
  return (
    <section className={cardClass} aria-labelledby="package-panel-heading">
      <div className="p-5 md:p-6">
        <h2 id="package-panel-heading" className="mb-2 flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-white">
          <PackageIcon className="h-5 w-5" aria-hidden="true" /> Package
        </h2>
        <dl className="grid gap-1 text-sm text-slate-800 dark:text-slate-100">
          <div><dt className="inline font-medium">What: </dt><dd className="inline">{p.description}</dd></div>
          <div><dt className="inline font-medium">Size: </dt><dd className="inline">{SIZE_LABELS[p.size]}{p.weightKg ? `, ${p.weightKg} kg` : ''}</dd></div>
          <div><dt className="inline font-medium">For: </dt><dd className="inline">{p.recipientName}{p.recipientPhone ? ` · ${formatPhone(p.recipientPhone)}` : ''}</dd></div>
          {p.handlingNotes ? <div><dt className="inline font-medium">Handling: </dt><dd className="inline">{p.handlingNotes}</dd></div> : null}
        </dl>
        {p.deliveredAt ? (
          <p className="mt-3 flex items-center gap-2 text-sm font-medium text-green-800 dark:text-green-300">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Delivered {formatDateTime(p.deliveredAt)} to {p.receivedBy}{p.deliveryNote ? ` (${p.deliveryNote})` : ''}
          </p>
        ) : canMarkDelivered ? (
          <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); mark.mutate(); }}>
            <div><label htmlFor="pkg-received" className={labelClass}>Who took it</label>
              <input id="pkg-received" className={inputClass} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} /></div>
            <div><label htmlFor="pkg-note" className={labelClass}>Note (optional)</label>
              <input id="pkg-note" className={inputClass} value={note} placeholder="Left with a neighbour in 3B" onChange={(e) => setNote(e.target.value)} /></div>
            <button type="submit" className={primaryButtonClass} disabled={!receivedBy.trim() || mark.isPending}>Mark delivered</button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

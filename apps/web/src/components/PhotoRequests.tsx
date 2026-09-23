import React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, X } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cardClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';

interface PhotoRequest {
  userId: string;
  fullName: string;
  action: 'set' | 'remove';
  requestedAt: string;
  newPhoto: string | null;
  currentPhoto: string | null;
}

/** Photo changes waiting for a coordinator/admin. Renders nothing when there are none. */
export function PhotoRequests(): React.JSX.Element | null {
  const q = useQuery({
    queryKey: ['photo-requests'],
    queryFn: () => api.get<{ requests: PhotoRequest[] }>('/api/photo-requests'),
    refetchInterval: 60_000,
  });
  const decide = useMutation({
    mutationFn: ({ userId, approve }: { userId: string; approve: boolean }) =>
      api.post(`/api/photo-requests/${userId}/${approve ? 'approve' : 'reject'}`),
    onSuccess: (_d, v) => {
      toast.success(v.approve ? 'Photo change approved.' : 'Photo change declined.');
      void q.refetch();
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      void q.refetch();
    },
  });

  const requests = q.data?.requests ?? [];
  if (requests.length === 0) return null;

  return (
    <section className={cardClass} aria-labelledby="photo-requests-heading">
      <div className="p-5 md:p-6">
        <h2 id="photo-requests-heading" className="text-lg font-semibold text-slate-900 dark:text-white">
          Photo changes to approve ({requests.length})
        </h2>
        <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
          {requests.map((r) => (
            <li key={r.userId} className="flex flex-wrap items-center gap-4 py-3">
              <div className="flex items-center gap-2">
                {r.currentPhoto ? (
                  <img src={r.currentPhoto} alt={`Current photo of ${r.fullName}`} className="h-14 w-14 rounded-full object-cover" />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-[10px] text-slate-500 dark:bg-slate-800">None</div>
                )}
                <span aria-hidden="true" className="text-slate-400">→</span>
                {r.action === 'set' && r.newPhoto ? (
                  <img src={r.newPhoto} alt={`New photo from ${r.fullName}`} className="h-14 w-14 rounded-full object-cover ring-2 ring-amber-400" />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-[10px] text-amber-800 ring-2 ring-amber-400">Remove</div>
                )}
              </div>
              <div className="min-w-[10rem] flex-1">
                <p className="font-medium text-slate-900 dark:text-white">{r.fullName}</p>
                <p className="text-xs text-slate-500">{r.action === 'set' ? 'New photo' : 'Wants the photo removed'} · {formatDateTime(r.requestedAt)}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className={primaryButtonClass} disabled={decide.isPending}
                  onClick={() => decide.mutate({ userId: r.userId, approve: true })}>
                  <Check className="h-4 w-4" aria-hidden="true" /> Approve
                </button>
                <button type="button" className={secondaryButtonClass} disabled={decide.isPending}
                  onClick={() => decide.mutate({ userId: r.userId, approve: false })}>
                  <X className="h-4 w-4" aria-hidden="true" /> Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

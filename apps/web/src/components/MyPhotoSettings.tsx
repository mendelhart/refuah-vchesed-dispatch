import React, { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Camera, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { photoFileToDataUrl } from '@/lib/photo';
import { formatDateTime } from '@/lib/format';
import { cardClass, secondaryButtonClass } from '@/components/states';

interface MyPhotoResponse {
  photo: string | null;
  pending: { action: 'set' | 'remove'; requestedAt: string; photo: string | null } | null;
}

/**
 * Settings: your ID card photo. For everyone except admins, a new photo or a
 * removal is a request that a coordinator or admin approves before it shows on
 * the card.
 */
export function MyPhotoSettings({ isAdmin }: { isAdmin: boolean }): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['me', 'photo'], queryFn: () => api.get<MyPhotoResponse>('/api/me/photo') });

  const run = async (fn: () => Promise<{ pending?: boolean } | unknown>, done: string, pendingMsg: string): Promise<void> => {
    setBusy(true);
    try {
      const res = (await fn()) as { pending?: boolean } | undefined;
      toast.success(res?.pending ? pendingMsg : done);
      await q.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const data = q.data;
  const pending = data?.pending ?? null;

  return (
    <section className={cardClass} aria-labelledby="photo-heading">
      <div className="p-5 md:p-6">
        <h2 id="photo-heading" className="text-lg font-semibold text-slate-900 dark:text-white">ID card photo</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          A clear photo of your face, so reception desks can match you to your card.
          {isAdmin ? null : ' Changes are checked by a coordinator before they appear on your card.'}
        </p>

        <div className="mt-4 flex flex-wrap items-start gap-6">
          <figure className="text-center">
            {data?.photo ? (
              <img src={data.photo} alt="Your current ID card photo" className="h-24 w-24 rounded-full object-cover" />
            ) : (
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-slate-100 text-xs text-slate-500 dark:bg-slate-800">No photo</div>
            )}
            <figcaption className="mt-1 text-xs text-slate-500">On your card now</figcaption>
          </figure>
          {pending ? (
            <figure className="text-center">
              {pending.action === 'set' && pending.photo ? (
                <img src={pending.photo} alt="Your new photo, waiting for approval" className="h-24 w-24 rounded-full object-cover opacity-80 ring-2 ring-amber-400" />
              ) : (
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-amber-50 px-2 text-xs text-amber-800 ring-2 ring-amber-400 dark:bg-amber-950/30 dark:text-amber-200">Removal requested</div>
              )}
              <figcaption className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                Waiting for approval
                <span className="block text-slate-500">{formatDateTime(pending.requestedAt)}</span>
              </figcaption>
            </figure>
          ) : null}
        </div>

        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void run(
              async () => api.put('/api/me/photo', { photo: await photoFileToDataUrl(file) }),
              'Photo saved.',
              'Photo sent for approval. It will show on your card once approved.',
            );
          }}
        />
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => input.current?.click()}>
            <Camera className="h-4 w-4" aria-hidden="true" />
            {busy ? 'Saving…' : data?.photo || pending ? 'Upload a new photo' : 'Add a photo'}
          </button>
          {data?.photo && pending?.action !== 'remove' ? (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Remove your photo?')) return;
                void run(() => api.del('/api/me/photo'), 'Photo removed.', 'Removal sent for approval.');
              }}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Remove photo
            </button>
          ) : null}
          {pending ? (
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() => void run(() => api.del('/api/me/photo/pending'), 'Request withdrawn.', 'Request withdrawn.')}
            >
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              Withdraw request
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

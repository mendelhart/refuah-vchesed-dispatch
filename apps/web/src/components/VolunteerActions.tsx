import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { IdCard, MessageCircle, MessageSquare, PauseCircle, Pencil, PlayCircle, Trash2, X } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';

interface Person {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  role: string;
  status: string;
  suspended_until?: string | null;
  suspension_reason?: string | null;
}

type Panel = 'none' | 'edit' | 'sms' | 'whatsapp' | 'pause' | 'remove' | 'card';

function tomorrow(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Edit, message, pause, reissue the ID card and remove, on a volunteer's card.
 *
 * Shown to coordinators and admins only; the server checks the same rule, so a
 * volunteer cannot do any of this even by calling the API directly.
 */
export function VolunteerActions({ person, onRemoved }: { person: Person; onRemoved: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel>('none');
  const [form, setForm] = useState({ fullName: person.full_name, phone: person.phone ?? '', email: person.email ?? '' });
  const [message, setMessage] = useState('');
  const [pauseMode, setPauseMode] = useState<'open' | 'until'>('until');
  const [pauseUntil, setPauseUntil] = useState(tomorrow());
  const [pauseReason, setPauseReason] = useState('');
  const [removeReason, setRemoveReason] = useState('No longer volunteering');
  const paused = person.status === 'inactive';

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.volunteers.all() });
    void queryClient.invalidateQueries({ queryKey: ['people'] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch<unknown>(`/api/users/${person.id}`, {
        fullName: form.fullName.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
      }),
    onSuccess: () => {
      refresh();
      setPanel('none');
      toast.success('Saved.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const send = useMutation({
    mutationFn: (channel: 'sms' | 'whatsapp') =>
      api.post<{ threadId: string | null }>(`/api/users/${person.id}/message`, { channel, body: message }),
    onSuccess: (_data, channel) => {
      setMessage('');
      setPanel('none');
      toast.success(
        channel === 'sms'
          ? `Text sent to ${person.full_name}. Their reply shows in Messages.`
          : `WhatsApp sent to ${person.full_name}.`,
      );
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const pause = useMutation({
    mutationFn: () =>
      api.post<unknown>(`/api/users/${person.id}/suspend`, {
        // Back on at the start of the chosen day, local time.
        until: pauseMode === 'until' ? new Date(`${pauseUntil}T00:00:00`).toISOString() : null,
        reason: pauseReason.trim() || null,
      }),
    onSuccess: () => {
      refresh();
      setPanel('none');
      toast.success(
        pauseMode === 'until'
          ? `${person.full_name} is paused until ${new Date(`${pauseUntil}T00:00:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}. They switch back on by themselves.`
          : `${person.full_name} is paused until you reactivate them.`,
      );
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const reactivate = useMutation({
    mutationFn: () => api.post<unknown>(`/api/users/${person.id}/reactivate`, {}),
    onSuccess: () => {
      refresh();
      toast.success(`${person.full_name} is active again.`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (reason: string) => api.post<unknown>(`/api/users/${person.id}/deactivate`, { reason }),
    onSuccess: () => {
      refresh();
      toast.success(`${person.full_name} was removed.`);
      onRemoved();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const reissue = useMutation({
    mutationFn: () => api.post<unknown>(`/api/volunteers/${person.id}/card/reissue`, {}),
    onSuccess: () => {
      setPanel('none');
      void queryClient.invalidateQueries({ queryKey: qk.volunteers.all() });
      toast.success(`New card code for ${person.full_name}. The old card no longer checks out.`);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const toggle = (next: Panel): void => setPanel((current) => (current === next ? 'none' : next));
  const noPhone = !person.phone;

  return (
    <section className="space-y-3">
      {paused ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="font-semibold">
            Paused
            {person.suspended_until
              ? ` until ${new Date(person.suspended_until).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`
              : ' until reactivated'}
          </p>
          {person.suspension_reason ? <p className="mt-1">{person.suspension_reason}</p> : null}
          <p className="mt-1 text-xs">No ride offers and no sign-in while paused. Nothing is deleted.</p>
          <button type="button" className={`${primaryButtonClass} mt-2`} disabled={reactivate.isPending} onClick={() => reactivate.mutate()}>
            <PlayCircle className="h-4 w-4" aria-hidden="true" />
            {reactivate.isPending ? 'Reactivating…' : 'Reactivate now'}
          </button>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <button type="button" className={secondaryButtonClass} onClick={() => toggle('edit')}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Edit details
        </button>
        <button type="button" className={secondaryButtonClass} disabled={noPhone} onClick={() => toggle('sms')}>
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          Text
        </button>
        <button type="button" className={secondaryButtonClass} disabled={noPhone} onClick={() => toggle('whatsapp')}>
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          WhatsApp
        </button>
        {!paused ? (
          <button type="button" className={secondaryButtonClass} onClick={() => toggle('pause')}>
            <PauseCircle className="h-4 w-4" aria-hidden="true" />
            Pause
          </button>
        ) : null}
        <button type="button" className={secondaryButtonClass} onClick={() => toggle('card')}>
          <IdCard className="h-4 w-4" aria-hidden="true" />
          Lost card
        </button>
        <button
          type="button"
          className={`${secondaryButtonClass} !border-red-300 !text-red-700 dark:!border-red-500/50 dark:!text-red-300`}
          disabled={remove.isPending}
          onClick={() => toggle('remove')}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {remove.isPending ? 'Removing…' : 'Remove'}
        </button>
      </div>
      {noPhone ? <p className="text-xs text-slate-500 dark:text-slate-400">Add a mobile number to text or WhatsApp them.</p> : null}

      {panel === 'edit' ? (
        <form
          className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div>
            <label htmlFor={`edit-name-${person.id}`} className={labelClass}>Full name</label>
            <input id={`edit-name-${person.id}`} className={inputClass} value={form.fullName} required minLength={2}
              onChange={(event) => setForm({ ...form, fullName: event.target.value })} />
          </div>
          <div>
            <label htmlFor={`edit-phone-${person.id}`} className={labelClass}>Mobile number</label>
            <input id={`edit-phone-${person.id}`} className={inputClass} type="tel" inputMode="tel" value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </div>
          <div>
            <label htmlFor={`edit-email-${person.id}`} className={labelClass}>Email{person.role === 'volunteer' ? ' (optional)' : ''}</label>
            <input id={`edit-email-${person.id}`} className={inputClass} type="email" value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setPanel('none')}>
              <X className="h-4 w-4" aria-hidden="true" />
              Cancel
            </button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Services, hours and how we reach them are further down this card.</p>
        </form>
      ) : null}

      {panel === 'pause' ? (
        <form
          className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
          onSubmit={(event) => {
            event.preventDefault();
            pause.mutate();
          }}
        >
          <p className="text-sm text-slate-700 dark:text-slate-200">
            Pausing stops ride offers and sign-in for {person.full_name}. Their details, history and ID card are kept.
          </p>
          <fieldset className="space-y-2">
            <legend className={labelClass}>For how long</legend>
            <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700 dark:text-slate-200">
              <input type="radio" name={`pause-${person.id}`} className="h-5 w-5" checked={pauseMode === 'until'} onChange={() => setPauseMode('until')} />
              Until a date (switches back on by itself)
            </label>
            {pauseMode === 'until' ? (
              <input type="date" aria-label="Back on" className={inputClass} min={tomorrow()} value={pauseUntil} required
                onChange={(event) => setPauseUntil(event.target.value)} />
            ) : null}
            <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700 dark:text-slate-200">
              <input type="radio" name={`pause-${person.id}`} className="h-5 w-5" checked={pauseMode === 'open'} onChange={() => setPauseMode('open')} />
              Until I reactivate them
            </label>
          </fieldset>
          <div>
            <label htmlFor={`pause-reason-${person.id}`} className={labelClass}>Reason (optional)</label>
            <input id={`pause-reason-${person.id}`} className={inputClass} value={pauseReason} maxLength={500}
              placeholder="Away for the winter, taking a break, …" onChange={(event) => setPauseReason(event.target.value)} />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={pause.isPending}>
              {pause.isPending ? 'Pausing…' : 'Pause'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setPanel('none')}>Cancel</button>
          </div>
        </form>
      ) : null}

      {panel === 'card' ? (
        <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-sm text-slate-700 dark:text-slate-200">
            Issue a new QR code for {person.full_name}&apos;s ID card. Anyone scanning the old card will see it is not
            valid. Their volunteer number stays the same; they print the new card from My ID card.
          </p>
          <div className="flex gap-2">
            <button type="button" className={primaryButtonClass} disabled={reissue.isPending} onClick={() => reissue.mutate()}>
              {reissue.isPending ? 'Issuing…' : 'Issue a new code'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setPanel('none')}>Cancel</button>
          </div>
        </div>
      ) : null}

      {panel === 'remove' ? (
        <form
          className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/30"
          onSubmit={(event) => {
            event.preventDefault();
            remove.mutate(removeReason.trim() || 'No longer volunteering');
          }}
        >
          <p className="text-sm font-medium text-slate-900 dark:text-white">
            Remove {person.full_name}? They will no longer get ride offers or be able to sign in. Their phone and email
            are cleared. To keep them on file, use Pause instead.
          </p>
          <div>
            <label htmlFor={`remove-reason-${person.id}`} className={labelClass}>Reason (kept in the audit log)</label>
            <input id={`remove-reason-${person.id}`} className={inputClass} value={removeReason} maxLength={300}
              onChange={(event) => setRemoveReason(event.target.value)} />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={`${primaryButtonClass} !bg-red-700 hover:!bg-red-800`} disabled={remove.isPending}>
              {remove.isPending ? 'Removing…' : `Remove ${person.full_name}`}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setPanel('none')}>Cancel</button>
          </div>
        </form>
      ) : null}

      {panel === 'sms' || panel === 'whatsapp' ? (
        <form
          className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
          onSubmit={(event) => {
            event.preventDefault();
            send.mutate(panel);
          }}
        >
          <label htmlFor={`msg-${person.id}`} className={labelClass}>
            {panel === 'sms' ? 'Text message' : 'WhatsApp message'} to {person.full_name}
          </label>
          <textarea id={`msg-${person.id}`} className={`${inputClass} min-h-[96px]`} value={message} maxLength={1200} required
            onChange={(event) => setMessage(event.target.value)} />
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={send.isPending || !message.trim()}>
              {send.isPending ? 'Sending…' : panel === 'sms' ? 'Send text' : 'Send WhatsApp'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setPanel('none')}>Cancel</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

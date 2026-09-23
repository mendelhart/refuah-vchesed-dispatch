import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageCircle, MessageSquare, Pencil, Trash2, X } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';

interface Person {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  role: string;
}

type Panel = 'none' | 'edit' | 'sms' | 'whatsapp';

/**
 * Edit, message and remove, on a volunteer's card.
 *
 * Shown to coordinators and admins only; the server checks the same rule, so a
 * volunteer cannot do any of this even by calling the API directly.
 */
export function VolunteerActions({ person, onRemoved }: { person: Person; onRemoved: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel>('none');
  const [form, setForm] = useState({ fullName: person.full_name, phone: person.phone ?? '', email: person.email ?? '' });
  const [message, setMessage] = useState('');

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

  const remove = useMutation({
    mutationFn: (reason: string) => api.post<unknown>(`/api/users/${person.id}/deactivate`, { reason }),
    onSuccess: () => {
      refresh();
      toast.success(`${person.full_name} was removed.`);
      onRemoved();
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const confirmRemove = (): void => {
    if (!window.confirm(`Remove ${person.full_name}? They will no longer get ride offers or be able to sign in.`)) return;
    const reason = window.prompt('Reason (kept in the audit log):', 'No longer volunteering');
    if (reason === null) return;
    remove.mutate(reason.trim() || 'No longer volunteering');
  };

  const toggle = (next: Panel): void => setPanel((current) => (current === next ? 'none' : next));
  const noPhone = !person.phone;

  return (
    <section className="space-y-3">
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
        <button
          type="button"
          className={`${secondaryButtonClass} !border-red-300 !text-red-700 dark:!border-red-500/50 dark:!text-red-300`}
          disabled={remove.isPending}
          onClick={confirmRemove}
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

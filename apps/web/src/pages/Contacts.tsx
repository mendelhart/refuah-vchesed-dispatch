/**
 * Contacts — the numbers dispatch calls that are not a caller or a volunteer
 * (clinics, hospital desks, the on-call rav). Calls are placed through the
 * masked-calling endpoint so neither side sees the other's real number.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ClipboardList, PhoneCall, Plus, Trash2 } from 'lucide-react';
import { contactSchema } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';
import type { ContactsResponse, StartCallResponse } from '@/types/api';

export function ContactsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', role: '', notes: '' });

  const contacts = useQuery({
    queryKey: qk.contacts.list(),
    queryFn: () => api.get<ContactsResponse>('/api/contacts'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/contacts', {
        name: form.name.trim(),
        phone: form.phone.trim(),
        role: form.role.trim() || null,
        notes: form.notes.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.contacts.list() });
      toast.success('Contact saved.');
      setOpen(false);
      setForm({ name: '', phone: '', role: '', notes: '' });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/contacts/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.contacts.list() });
      toast.success('Contact removed.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const call = useMutation({
    mutationFn: (contactId: string) =>
      api.post<StartCallResponse>('/api/calls', { counterparty: 'contact', contactId }),
    onSuccess: (data) => toast.success(data.message),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        subtitle="Numbers dispatch calls regularly"
        actions={
          <button type="button" className={primaryButtonClass} onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add contact
          </button>
        }
      />

      {contacts.isPending ? (
        <ListSkeleton rows={4} lines={1} />
      ) : contacts.isError ? (
        <ErrorState error={contacts.error} onRetry={() => void contacts.refetch()} what="the contact list" />
      ) : contacts.data.contacts.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No contacts saved yet." hint="Add the numbers you call often so nobody has to hunt for them mid-shift." />
      ) : (
        <ul className="space-y-2">
          {contacts.data.contacts.map((contact) => (
            <li key={contact.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-4`}>
              <div className="min-w-0">
                <p className="font-medium text-slate-900 dark:text-white">{contact.name}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {contact.role ? `${contact.role} · ` : ''}
                  {contact.phone}
                </p>
                {contact.notes ? <p className="text-xs text-slate-500 dark:text-slate-400">{contact.notes}</p> : null}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={secondaryButtonClass}
                  disabled={call.isPending}
                  onClick={() => call.mutate(contact.id)}
                >
                  <PhoneCall className="h-4 w-4" aria-hidden="true" />
                  Call
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${contact.name}`}
                  className="grid h-11 w-11 place-items-center rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
                  onClick={() => {
                    if (window.confirm(`Remove ${contact.name} from contacts?`)) remove.mutate(contact.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={open} title="Add a contact" onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = contactSchema.safeParse({
              name: form.name,
              phone: form.phone,
              role: form.role || null,
              notes: form.notes || null,
            });
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            create.mutate();
          }}
        >
          <div>
            <label htmlFor="contact-name" className={labelClass}>
              Name
            </label>
            <input id="contact-name" className={inputClass} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </div>
          <div>
            <label htmlFor="contact-phone" className={labelClass}>
              Phone
            </label>
            <input id="contact-phone" type="tel" className={inputClass} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} required />
          </div>
          <div>
            <label htmlFor="contact-role" className={labelClass}>
              Role
            </label>
            <input id="contact-role" className={inputClass} value={form.role} placeholder="Clinic desk, on-call, …" onChange={(event) => setForm({ ...form, role: event.target.value })} />
          </div>
          <div>
            <label htmlFor="contact-notes" className={labelClass}>
              Notes
            </label>
            <input id="contact-notes" className={inputClass} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </div>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={create.isPending}>
              Save contact
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

import { FILTERS, HOSPITAL_ROLE, type Filter } from './contacts-model';
import { useConfirmation } from '@/components/useConfirmation';
/**
 * Contacts — the numbers dispatch calls that are not a caller or a volunteer
 * (clinics, hospital desks, the on-call rav). Calls are placed through the
 * masked-calling endpoint so neither side sees the other's real number.
 *
 * Everything known about a contact is captured on the one form — name,
 * number, role, notes AND the address — because the dispatcher adding "the
 * CLSC desk" mid-shift does not have a second form in them. Contacts with the
 * role "Hospital" surface under their own filter: that is the hospital phone
 * book.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ClipboardList, Plus } from 'lucide-react';
import { contactSchema } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { Modal } from '@/components/Modal';
import { AddressFields, emptyAddress, toAddressInput, type AddressDraft } from '@/components/AddressAutocomplete';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, inputClass, labelClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';
import type { ContactRow, ContactsResponse, StartCallResponse } from '@/types/api';
import { ContactCard } from './ContactCard';

export function ContactsPage(): React.JSX.Element {
  const confirmation = useConfirmation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('hospitals');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', phone: '', role: HOSPITAL_ROLE, notes: '' });
  const [address, setAddress] = useState<AddressDraft>(emptyAddress());

  const contacts = useQuery({
    queryKey: qk.contacts.list(),
    queryFn: () => api.get<ContactsResponse>('/api/contacts'),
  });

  const openNew = (): void => {
    setEditingId(null);
    setForm({ name: '', phone: '', role: filter === 'other' ? '' : HOSPITAL_ROLE, notes: '' });
    setAddress(emptyAddress());
    setOpen(true);
  };

  const openEdit = (contact: ContactRow): void => {
    setEditingId(contact.id);
    setForm({ name: contact.name, phone: contact.phone, role: contact.role ?? '', notes: contact.notes ?? '' });
    const a = contact.address;
    setAddress(
      a
        ? {
            line1: a.line1 ?? '', unit: a.unit ?? '', city: a.city ?? 'Montreal', province: a.province ?? 'QC',
            postalCode: a.postalCode ?? '', country: a.country ?? 'CA', notes: a.notes ?? '',
            latitude: a.latitude ?? null, longitude: a.longitude ?? null,
          }
        : emptyAddress(),
    );
    setOpen(true);
  };

  const create = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        role: form.role.trim() || null,
        notes: form.notes.trim() || null,
        address: address.line1.trim() ? toAddressInput(address) : null,
      };
      return editingId ? api.patch(`/api/contacts/${editingId}`, body) : api.post('/api/contacts', body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.contacts.list() });
      toast.success(editingId ? 'Changes saved.' : 'Contact saved.');
      setOpen(false);
      setEditingId(null);
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

  const all = contacts.data?.contacts ?? [];
  const visible = all.filter((contact) => {
    const hospital = contact.role?.toLowerCase() === HOSPITAL_ROLE.toLowerCase();
    if (filter === 'hospitals') return hospital;
    if (filter === 'other') return !hospital;
    return true;
  });

  return (
    <div className="space-y-6">
      {confirmation.dialog}
      <PageHeader
        title="Hospitals"
        subtitle="Hospitals, clinics and other numbers dispatch calls"
        actions={
          <button type="button" className={primaryButtonClass} onClick={openNew}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add contact
          </button>
        }
      />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter contacts">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={
              filter === item.value
                ? 'inline-flex min-h-[44px] items-center rounded-lg border border-[#EA0029] bg-[#EA0029]/10 px-3 text-sm font-medium text-[#C80023] dark:text-red-400'
                : 'inline-flex min-h-[44px] items-center rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
            }
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {contacts.isPending ? (
        <ListSkeleton rows={4} lines={1} />
      ) : contacts.isError ? (
        <ErrorState error={contacts.error} onRetry={() => void contacts.refetch()} what="the contact list" />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={filter === 'hospitals' ? 'No hospitals in the phone book yet.' : 'No contacts saved yet.'}
          hint="Add the numbers you call often so nobody has to hunt for them mid-shift."
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((contact) => (
            <ContactCard key={contact.id} contact={contact} calling={call.isPending} onCall={(id) => call.mutate(id)} onEdit={openEdit}
              onRemove={(row) => confirmation.ask({ title: `Remove ${row.name} from contacts?`, action: () => remove.mutate(row.id) })} />
          ))}
        </ul>
      )}

      <Modal open={open} title={editingId ? `Edit ${form.name || 'contact'}` : 'Add a contact'} onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = contactSchema.safeParse({
              name: form.name,
              phone: form.phone,
              role: form.role || null,
              notes: form.notes || null,
              address: address.line1.trim() ? toAddressInput(address) : null,
            });
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            create.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          </div>
          <div>
            <label htmlFor="contact-role" className={labelClass}>
              Role
            </label>
            <input id="contact-role" className={inputClass} value={form.role} placeholder="Hospital, clinic desk, on-call, …" onChange={(event) => setForm({ ...form, role: event.target.value })} />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Use the role &quot;Hospital&quot; and it lands in the hospital phone book automatically.
            </p>
          </div>
          <AddressFields
            id="contact-address"
            label="Address"
            value={address}
            onChange={setAddress}
            notesPlaceholder="Which entrance, extension, floor"
          />
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

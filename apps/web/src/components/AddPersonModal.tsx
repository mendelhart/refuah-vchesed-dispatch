/**
 * The add-person form, shared by Admin > People and the Volunteers screens.
 * Adding people stays admin-only on the server (POST /api/users).
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ROLES, createUserSchema, type InviteChannel, type Role, roleLabel } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { Modal } from '@/components/Modal';
import { useAuth } from '@/lib/auth';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';
import type { CreateUserResponse, GroupsResponse } from '@/types/api';

const INVITE_OPTIONS: { channel: InviteChannel; label: string }[] = [
  { channel: 'sms', label: 'Text' },
  { channel: 'whatsapp', label: 'WhatsApp' },
  { channel: 'email', label: 'Email' },
];
export const channelLabel = (c: InviteChannel): string => (c === 'sms' ? 'text' : c === 'whatsapp' ? 'WhatsApp' : 'email');

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded?: (data: CreateUserResponse) => void;
  defaultRole?: Role;
  title?: string;
}

export function AddPersonModal({ open, onClose, onAdded, defaultRole = 'volunteer', title = 'Add someone' }: Props): React.JSX.Element {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  // Coordinators may add volunteers; only admins choose another role.
  const roleChoices = me?.role === 'admin' ? ROLES : (['volunteer'] as const);
  const emptyForm = { email: '', fullName: '', phone: '', role: defaultRole, groupSlug: '', inviteVia: [] as InviteChannel[] };
  const [form, setForm] = useState(emptyForm);
  const toggleVia = (channel: InviteChannel) =>
    setForm((f) => ({
      ...f,
      inviteVia: f.inviteVia.includes(channel) ? f.inviteVia.filter((c) => c !== channel) : [...f.inviteVia, channel],
    }));
  const payload = () => ({
    email: form.email.trim() || null,
    fullName: form.fullName.trim(),
    phone: form.phone.trim() || null,
    role: form.role,
    groupSlugs: form.groupSlug ? [form.groupSlug] : [],
    status: 'active' as const,
    // Staff always get a link back to pass on; volunteers only when ticked.
    sendInvite: form.role !== 'volunteer',
    inviteVia: form.inviteVia.filter((c) => (c === 'email' ? form.email.trim() : form.phone.trim())),
  });

  const groups = useQuery({
    enabled: open,
    queryKey: qk.people.groups(),
    queryFn: () => api.get<GroupsResponse>('/api/groups'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<CreateUserResponse>('/api/users', payload()),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      void queryClient.invalidateQueries({ queryKey: ['volunteers'] });
      const via = data.invitedVia ?? [];
      toast.success(
        via.length
          ? `${data.user.fullName} added. Invite sent by ${via.map(channelLabel).join(' and ')}.`
          : `${data.user.fullName} added. They will get ride offers by text.`,
      );
      onAdded?.(data);
      onClose();
      setForm(emptyForm);
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
      <Modal open={open} title={title} onClose={onClose}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = createUserSchema.safeParse(payload());
            if (!parsed.success) {
              toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
              return;
            }
            create.mutate();
          }}
        >
          <div>
            <label htmlFor="person-name" className={labelClass}>
              Full name
            </label>
            <input id="person-name" className={inputClass} value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} required />
          </div>
          <div>
            <label htmlFor="person-phone" className={labelClass}>
              Mobile number{form.role === 'volunteer' ? '' : ' (optional)'}
            </label>
            <input
              id="person-phone"
              type="tel"
              inputMode="tel"
              className={inputClass}
              placeholder="514 555 1234"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
              required={form.role === 'volunteer'}
            />
          </div>
          <div>
            <label htmlFor="person-email" className={labelClass}>
              Email{form.role === 'volunteer' ? ' (optional)' : ''}
            </label>
            <input
              id="person-email"
              type="email"
              className={inputClass}
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required={form.role !== 'volunteer'}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="person-role" className={labelClass}>
                Role
              </label>
              <select id="person-role" className={inputClass} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>
                {roleChoices.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="person-group" className={labelClass}>
                Group
              </label>
              <select id="person-group" className={inputClass} value={form.groupSlug} onChange={(event) => setForm({ ...form, groupSlug: event.target.value })}>
                <option value="">No group</option>
                {(groups.data?.groups ?? []).map((group) => (
                  <option key={group.slug} value={group.slug}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <fieldset>
            <legend className={labelClass}>Send an invite to set up the app (optional)</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {INVITE_OPTIONS.map(({ channel, label }) => {
                const missing = channel === 'email' ? !form.email.trim() : !form.phone.trim();
                return (
                  <label
                    key={channel}
                    className={`flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm dark:border-slate-600 ${missing ? 'opacity-50' : ''}`}
                  >
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-[#EA0029]"
                      checked={form.inviteVia.includes(channel) && !missing}
                      disabled={missing}
                      onChange={() => toggleVia(channel)}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Leave all unticked to add them quietly. Volunteers get ride offers by text either way.
            </p>
          </fieldset>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={create.isPending}>
              {form.inviteVia.length ? 'Add and invite' : 'Add'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
  );
}

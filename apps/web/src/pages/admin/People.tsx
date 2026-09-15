/**
 * People: the roster an administrator maintains. Invites come back as a link
 * the admin passes on by hand until transactional email is wired up, which is
 * why the link is displayed rather than assumed sent.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, UserPlus, Users } from 'lucide-react';
import { ROLES, createUserSchema, type Role } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { titleCase } from '@/lib/format';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';
import type { CreateUserResponse, GroupsResponse, InviteUrlResponse, UserListResponse } from '@/types/api';

export function PeoplePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', fullName: '', phone: '', role: 'volunteer' as Role, groupSlug: '' });

  const people = useQuery({
    queryKey: qk.people.list({}),
    queryFn: () => api.get<UserListResponse>('/api/users', { limit: 500 }),
  });
  const groups = useQuery({
    queryKey: qk.people.groups(),
    queryFn: () => api.get<GroupsResponse>('/api/groups'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<CreateUserResponse>('/api/users', {
        email: form.email.trim(),
        fullName: form.fullName.trim(),
        phone: form.phone.trim() || null,
        role: form.role,
        groupSlugs: form.groupSlug ? [form.groupSlug] : [],
        status: 'active',
        sendInvite: true,
      }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: qk.people.list({}) });
      toast.success(`${data.user.fullName} added.`);
      setInviteUrl(data.inviteUrl);
      setOpen(false);
      setForm({ email: '', fullName: '', phone: '', role: 'volunteer', groupSlug: '' });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.post(`/api/users/${id}/role`, { role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.people.list({}) });
      toast.success('Role changed.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const resendInvite = useMutation({
    mutationFn: (id: string) => api.post<InviteUrlResponse>(`/api/users/${id}/resend-invite`),
    onSuccess: (data) => {
      setInviteUrl(data.inviteUrl);
      toast.success('New invitation link created.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const deactivate = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post(`/api/users/${id}/deactivate`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.people.list({}) });
      toast.success('Account deactivated.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        subtitle="Volunteers, dispatchers and administrators"
        actions={
          <button type="button" className={primaryButtonClass} onClick={() => setOpen(true)}>
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Invite someone
          </button>
        }
      />

      {inviteUrl ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Send this invitation link to the new volunteer — it expires in a week.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 text-xs dark:bg-slate-900">{inviteUrl}</code>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                void navigator.clipboard.writeText(inviteUrl).then(
                  () => toast.success('Link copied.'),
                  () => toast.error('Copy it by hand — the clipboard is blocked here.'),
                );
              }}
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              Copy
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => setInviteUrl(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}

      {people.isPending ? (
        <ListSkeleton rows={5} lines={1} />
      ) : people.isError ? (
        <ErrorState error={people.error} onRetry={() => void people.refetch()} what="the roster" />
      ) : people.data.users.length === 0 ? (
        <EmptyState icon={Users} title="Nobody on the roster yet." hint="Invite your first dispatcher or volunteer to get started." />
      ) : (
        <ul className="space-y-2">
          {people.data.users.map((person) => (
            <li key={person.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-4`}>
              <div className="min-w-0">
                <p className="font-medium text-slate-900 dark:text-white">{person.fullName}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {person.email ?? 'No email on file'}
                  {person.phone ? ` · ${person.phone}` : ''}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {titleCase(person.status)}
                  {person.groupSlugs.length > 0 ? ` · ${person.groupSlugs.map(titleCase).join(', ')}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`role-${person.id}`}>
                  Role for {person.fullName}
                </label>
                <select
                  id={`role-${person.id}`}
                  className={`${inputClass} w-36`}
                  value={person.role}
                  onChange={(event) => changeRole.mutate({ id: person.id, role: event.target.value as Role })}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {titleCase(role)}
                    </option>
                  ))}
                </select>
                <button type="button" className={secondaryButtonClass} onClick={() => resendInvite.mutate(person.id)}>
                  Invite link
                </button>
                {person.status !== 'deactivated' ? (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => {
                      const reason = window.prompt(`Why is ${person.fullName} being deactivated?`);
                      if (reason) deactivate.mutate({ id: person.id, reason });
                    }}
                  >
                    Deactivate
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={open} title="Invite someone" onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = createUserSchema.safeParse({
              email: form.email,
              fullName: form.fullName,
              phone: form.phone || null,
              role: form.role,
              groupSlugs: form.groupSlug ? [form.groupSlug] : [],
              status: 'active',
              sendInvite: true,
            });
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
            <label htmlFor="person-email" className={labelClass}>
              Email
            </label>
            <input id="person-email" type="email" className={inputClass} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
          </div>
          <div>
            <label htmlFor="person-phone" className={labelClass}>
              Mobile number
            </label>
            <input id="person-phone" type="tel" className={inputClass} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="person-role" className={labelClass}>
                Role
              </label>
              <select id="person-role" className={inputClass} value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {titleCase(role)}
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
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={create.isPending}>
              Create account
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

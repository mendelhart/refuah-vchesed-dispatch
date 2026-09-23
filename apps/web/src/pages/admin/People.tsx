/**
 * People: the roster an administrator maintains. Invites come back as a link
 * the admin passes on by hand until transactional email is wired up, which is
 * why the link is displayed rather than assumed sent.
 */
import { channelOptions, channelShort } from '@/lib/channels';
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, UserPlus, Users } from 'lucide-react';
import { ROLES, type InviteChannel, type Role, roleLabel } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { titleCase, formatPhone } from '@/lib/format';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, primaryButtonClass,
  secondaryButtonClass,
} from '@/components/states';
import type { InviteUrlResponse, UserListResponse } from '@/types/api';
import { setViewAs } from '@/lib/viewAs';
import { AddPersonModal, channelLabel } from '@/components/AddPersonModal';
import { PhotoButton } from '@/components/PhotoButton';

export function PeoplePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [invitedVia, setInvitedVia] = useState<InviteChannel[]>([]);
  const people = useQuery({
    queryKey: qk.people.list({}),
    queryFn: () => api.get<UserListResponse>('/api/users', { limit: 500 }),
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
      setInvitedVia(data.invitedVia ?? []);
      toast.success('New invitation link created.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const changeChannel = useMutation({
    mutationFn: (vars: { id: string; name: string; value: string }) =>
      api.patch<unknown>(`/api/users/${vars.id}`, { notificationPreference: vars.value }),
    onSuccess: (_d, vars) => {
      void queryClient.invalidateQueries();
      toast.success(`${vars.name} will be reached by ${channelShort(vars.value)}.`);
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

  const resetMfa = useMutation({
    mutationFn: (id: string) => api.post(`/api/users/${id}/mfa/reset`, {}),
    onSuccess: () => toast.success('Two-step sign-in reset. They set it up again at their next sign-in.'),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        subtitle="Volunteers, coordinators and admins"
        actions={
          <button type="button" className={primaryButtonClass} onClick={() => setOpen(true)}>
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Add someone
          </button>
        }
      />

      {inviteUrl ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {invitedVia.length
              ? `Invite sent by ${invitedVia.map(channelLabel).join(' and ')}. You can also pass on this link yourself - it expires in a week.`
              : 'Send this set-up link to them - it expires in a week.'}
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
            <button type="button" className={secondaryButtonClass} onClick={() => { setInviteUrl(null); setInvitedVia([]); }}>
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
        <EmptyState icon={Users} title="Nobody on the roster yet." hint="Invite your first coordinator or volunteer to get started." />
      ) : (
        <ul className="space-y-2">
          {people.data.users.map((person) => (
            <li key={person.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-3 p-4`}>
              <div className="flex min-w-0 items-center gap-3">
                {person.photoUrl ? (
                  <img src={person.photoUrl} alt="" className="h-12 w-12 flex-shrink-0 rounded-full object-cover" />
                ) : null}
              <div className="min-w-0">
                <p className="font-medium text-slate-900 dark:text-white">{person.fullName}</p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {person.email ?? 'No email on file'}
                  {person.phone ? ` · ${formatPhone(person.phone)}` : ''}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {titleCase(person.status)}
                  {person.activated === false ? ' · Offers by text only (no app account yet)' : ''}
                  {person.groupSlugs.length > 0 ? ` · ${person.groupSlugs.map(titleCase).join(', ')}` : ''}
                </p>
              </div>
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
                      {roleLabel(role)}
                    </option>
                  ))}
                </select>
                <label className="sr-only" htmlFor={`reach-${person.id}`}>
                  How to reach {person.fullName}
                </label>
                <select
                  id={`reach-${person.id}`}
                  className={`${inputClass} w-44`}
                  value={person.notificationPreference ?? 'sms'}
                  onChange={(event) => changeChannel.mutate({ id: person.id, name: person.fullName, value: event.target.value })}
                >
                  {channelOptions(person.notificationPreference).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <PhotoButton
                  endpoint={`/api/users/${person.id}/photo`}
                  hasPhoto={Boolean(person.photoUrl)}
                  onChanged={() => void people.refetch()}
                  compact
                />
                <button type="button" className={secondaryButtonClass} onClick={() => resendInvite.mutate(person.id)}>
                  Invite link
                </button>
                {person.role !== 'volunteer' ? (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    title="Lost phone: clear their authenticator. They are signed out and set it up again."
                    onClick={() => {
                      if (window.confirm(`Reset two-step sign-in for ${person.fullName}? They will be signed out and set up a new authenticator at next sign-in.`)) resetMfa.mutate(person.id);
                    }}
                  >
                    Reset 2-step
                  </button>
                ) : null}
                {person.status === 'active' && person.role !== 'admin' ? (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    onClick={() => void startViewAs(person)}
                    title="See the app exactly as this person sees it. Read-only."
                  >
                    View as
                  </button>
                ) : null}
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

      <AddPersonModal
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}


/** Record the preview on the server (audited), then reload as that person. */
async function startViewAs(person: { id: string; fullName: string; role: string }): Promise<void> {
  try {
    await api.post(`/api/admin/view-as/${person.id}`);
    setViewAs({ id: person.id, name: person.fullName, role: person.role });
    window.location.assign('/');
  } catch (error) {
    toast.error(errorMessage(error));
  }
}

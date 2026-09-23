/**
 * The add-person form, shared by Admin > People and the Volunteers screens.
 * Admins add anyone; coordinators add volunteers (checked on the server).
 * After adding, the set-up link is shown with buttons to pass it on.
 */
import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Mail, MessageCircle, MessageSquare, Share2 } from 'lucide-react';
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
type ChannelState = 'live' | 'test' | 'off';
interface MessagingStatus { channels: Record<'email' | 'sms' | 'whatsapp' | 'push', ChannelState> }

function digits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length === 10 ? `1${d}` : d;
}

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
  const [done, setDone] = useState<{ data: CreateUserResponse; phone: string; email: string; via: InviteChannel[] } | null>(null);
  const status = useQuery({
    enabled: open,
    queryKey: ['messaging', 'status'],
    queryFn: () => api.get<MessagingStatus>('/api/messaging/status'),
    staleTime: 60_000,
  });
  const channelState = (c: InviteChannel): ChannelState => status.data?.channels[c] ?? 'live';
  const close = (): void => {
    setDone(null);
    setForm(emptyForm);
    onClose();
  };
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
    // Always get a set-up link back, so it can be shown and passed on by hand.
    sendInvite: true,
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
      toast.success(`${data.user.fullName} added.`);
      onAdded?.(data);
      setDone({ data, phone: form.phone.trim(), email: form.email.trim(), via: data.invitedVia ?? [] });
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (done) {
    const url = done.data.inviteUrl;
    const first = done.data.user.fullName.split(/\s+/)[0] ?? '';
    const text = `Hi ${first}, here is your link to set up the Refuah V'Chesed app (valid 7 days): ${url ?? ''}`;
    return (
      <Modal open={open} title={`${done.data.user.fullName} added`} onClose={close}>
        <div className="space-y-4">
          {done.via.length ? (
            <ul className="space-y-1 text-sm">
              {done.via.map((c) => (
                <li key={c} className={channelState(c) === 'live' ? 'text-green-700 dark:text-green-300' : 'text-amber-800 dark:text-amber-300'}>
                  {channelState(c) === 'live'
                    ? `Invite sent by ${channelLabel(c)}.`
                    : c === 'email'
                      ? 'Email invite NOT sent: email is not set up yet. It is logged in Admin > Notifications. Use the buttons below to send the link yourself.'
                      : `${channelLabel(c)} invite NOT sent: ${channelLabel(c)} is in test mode. It is logged in Admin > Notifications. Use the buttons below to send the link yourself.`}
                </li>
              ))}
            </ul>
          ) : null}
          {url ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
              <p className="text-sm font-medium text-slate-900 dark:text-white">Set-up link (valid 7 days)</p>
              <code className="mt-2 block break-all rounded bg-white px-2 py-1 text-xs dark:bg-slate-900">{url}</code>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className={secondaryButtonClass}
                  onClick={() => {
                    void navigator.clipboard.writeText(url).then(
                      () => toast.success('Link copied.'),
                      () => toast.error('Copy it by hand - the clipboard is blocked here.'),
                    );
                  }}
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Copy
                </button>
                {typeof navigator.share === 'function' ? (
                  <button type="button" className={secondaryButtonClass} onClick={() => void navigator.share({ text }).catch(() => undefined)}>
                    <Share2 className="h-4 w-4" aria-hidden="true" />
                    Share
                  </button>
                ) : null}
                {done.phone ? (
                  <a className={secondaryButtonClass} href={`sms:${digits(done.phone)}?&body=${encodeURIComponent(text)}`}>
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    Text it
                  </a>
                ) : null}
                {done.phone ? (
                  <a className={secondaryButtonClass} href={`https://wa.me/${digits(done.phone)}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
                    <MessageCircle className="h-4 w-4" aria-hidden="true" />
                    WhatsApp it
                  </a>
                ) : null}
                {done.email ? (
                  <a className={secondaryButtonClass} href={`mailto:${done.email}?subject=${encodeURIComponent("Your Refuah V'Chesed account")}&body=${encodeURIComponent(text)}`}>
                    <Mail className="h-4 w-4" aria-hidden="true" />
                    Email it
                  </a>
                ) : null}
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">These buttons open your own phone&apos;s apps, so they work even before the app&apos;s own texting and email are switched on.</p>
            </div>
          ) : null}
          <button type="button" className={primaryButtonClass} onClick={close}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
      <Modal open={open} title={title} onClose={close}>
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
                    {!missing && channelState(channel) !== 'live' ? (
                      <span className="text-xs text-amber-700 dark:text-amber-300">
                        {channel === 'email' ? '(not set up yet)' : '(test mode)'}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Leave all unticked to add them quietly. Either way you get a set-up link to copy or send yourself.
            </p>
            {status.data && status.data.channels.email !== 'live' ? (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                Email is not set up yet, so an email invite is logged but not sent. You can still email the link yourself on the next screen.
              </p>
            ) : null}
          </fieldset>
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={create.isPending}>
              {form.inviteVia.length ? 'Add and invite' : 'Add'}
            </button>
            <button type="button" className={secondaryButtonClass} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
  );
}

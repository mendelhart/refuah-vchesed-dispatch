/**
 * Broadcasts to the roster.
 *
 * One click here reaches every volunteer, costs real money per segment, and
 * cannot be recalled. So the design is deliberately not convenient: the
 * audience count is live while the filters change, the send button carries the
 * exact number rather than the word "send", and the number has to be typed back
 * before anything goes out. The server refuses a send whose count has drifted
 * since drafting, and that refusal is shown in the reviewer's own words —
 * "this now reaches 512 people, not the 38 you confirmed" is the whole point of
 * the check and must never be flattened into "something went wrong".
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Megaphone, Users } from 'lucide-react';
import { NOTIFICATION_CHANNELS, ROLES, type NotificationChannel, type Role, ROLE_LABELS_PLURAL } from '@rvc/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime, titleCase } from '@/lib/format';
import { Modal } from '@/components/Modal';
import {
  EmptyState, ErrorState, InlineSpinner, ListSkeleton, PageHeader, cardClass, inputClass, labelClass,
  panelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';
import type { GroupsResponse } from '@/types/api';

interface Audience {
  groupSlugs?: string[];
  serviceSlugs?: string[];
  roles?: string[];
  minCompletedTrips?: number;
  includeSnoozed?: boolean;
}

interface PreviewResponse {
  count: number;
  max: number;
  overLimit: boolean;
  sample: string[];
}

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  status: string;
  channels: string[];
  recipientCount: number | null;
  sentAt: string | null;
  createdAt: string;
  createdBy: string;
}

interface AnnouncementListResponse {
  announcements: AnnouncementRow[];
}

interface ServicesResponse {
  services: { id: string; slug: string; name: string; description: string | null }[];
}

const STATUS_CLASSES: Record<string, string> = {
  draft: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
  sending: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  sent: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
};

/** GSM 03.38 basic set; anything outside it drops a segment to 70 characters. */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'.split(
    '',
  ),
);
const GSM_EXTENDED = new Set('^{}\\[~]|€'.split(''));

/** Kept local rather than shared with the template editor so the two screens
 *  stay in separate bundles; the rule is short and does not drift. */
function smsSegments(body: string): { segments: number; unicode: boolean } {
  let units = 0;
  let unicode = false;
  for (const char of [...body]) {
    if (GSM_BASIC.has(char)) units += 1;
    else if (GSM_EXTENDED.has(char)) units += 2;
    else unicode = true;
  }
  if (unicode) units = body.length;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return { segments: units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi), unicode };
}

export function AnnouncementsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [channels, setChannels] = useState<NotificationChannel[]>(['sms']);
  const [groupSlugs, setGroupSlugs] = useState<string[]>([]);
  const [serviceSlugs, setServiceSlugs] = useState<string[]>([]);
  const [roles, setRoles] = useState<Role[]>(['volunteer']);
  const [minCompletedTrips, setMinCompletedTrips] = useState('');
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const audience = useMemo<Audience>(
    () => ({
      ...(groupSlugs.length ? { groupSlugs } : {}),
      ...(serviceSlugs.length ? { serviceSlugs } : {}),
      ...(roles.length ? { roles } : {}),
      ...(Number(minCompletedTrips) > 0 ? { minCompletedTrips: Number(minCompletedTrips) } : {}),
      ...(includeSnoozed ? { includeSnoozed: true } : {}),
    }),
    [groupSlugs, serviceSlugs, roles, minCompletedTrips, includeSnoozed],
  );

  // The preview is a POST, so it has no entry in `qk`; its key hangs off the
  // announcements root so sending clears it along with everything else.
  const audienceKey = JSON.stringify(audience);
  const [debouncedKey, setDebouncedKey] = useState(audienceKey);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKey(audienceKey), 350);
    return () => window.clearTimeout(timer);
  }, [audienceKey]);

  const preview = useQuery({
    queryKey: [...qk.announcements.all(), 'preview', debouncedKey] as const,
    queryFn: () => api.post<PreviewResponse>('/api/announcements/preview', JSON.parse(debouncedKey) as Audience),
  });

  const groups = useQuery({
    queryKey: qk.people.groups(),
    queryFn: () => api.get<GroupsResponse>('/api/groups'),
  });
  const services = useQuery({
    queryKey: qk.services.list(),
    queryFn: () => api.get<ServicesResponse>('/api/services'),
  });
  const history = useQuery({
    queryKey: qk.announcements.list(),
    queryFn: () => api.get<AnnouncementListResponse>('/api/announcements'),
  });

  // A refused send leaves its draft behind, so the same unchanged draft is
  // reused on the retry rather than piling up a row per attempt. Any edit to
  // the wording or the audience invalidates it and a fresh draft is written.
  const draftRef = useRef<{ signature: string; id: string } | null>(null);

  const send = useMutation({
    mutationFn: async (count: number) => {
      const signature = JSON.stringify({ title: title.trim(), body: body.trim(), audience, channels });
      let draftId = draftRef.current?.signature === signature ? draftRef.current.id : null;
      if (!draftId) {
        const created = await api.post<{ announcement: { id: string } }>('/api/announcements', {
          title: title.trim(),
          body: body.trim(),
          audience,
          channels,
        });
        draftId = created.announcement.id;
        draftRef.current = { signature, id: draftId };
      }
      return api.post<{ queued: number }>(`/api/announcements/${draftId}/send`, {
        confirmRecipientCount: count,
      });
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: qk.announcements.all() });
      draftRef.current = null;
      setConfirmOpen(false);
      setConflictMessage(null);
      setTitle('');
      setBody('');
      toast.success(`Queued for ${data.queued} people.`);
    },
    onError: (error: unknown) => {
      // A 409 here is the audience-drift guard doing its job. Its message names
      // both numbers, which is the only useful thing anybody could be told.
      if (error instanceof ApiError && error.isConflict) {
        setConflictMessage(error.message);
        void preview.refetch();
        return;
      }
      setConflictMessage(null);
      toast.error(errorMessage(error));
    },
  });

  const count = preview.data?.count ?? null;
  const overLimit = preview.data?.overLimit ?? false;
  const segments = smsSegments(body).segments;
  const smsSelected = channels.includes('sms');
  const ready = title.trim().length > 0 && body.trim().length > 0 && channels.length > 0 && (count ?? 0) > 0;

  const toggle = <T extends string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <div className="space-y-6">
      <PageHeader title="Announcements" subtitle="A message to many people at once, sent on purpose" />

      <section className={panelClass}>
        <h2 className="mb-3 font-semibold text-slate-900 dark:text-white">Who it goes to</h2>

        <fieldset className="mb-4">
          <legend className={labelClass}>Groups</legend>
          {groups.isPending ? (
            <InlineSpinner label="Loading groups" />
          ) : groups.isError ? (
            <p className="text-sm text-[#EA0029]">{errorMessage(groups.error)}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {groups.data.groups.map((group) => (
                <li key={group.slug}>
                  <label
                    className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border px-4 text-sm ${
                      groupSlugs.includes(group.slug)
                        ? 'border-[#EA0029] bg-[#EA0029] text-white'
                        : 'border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={groupSlugs.includes(group.slug)}
                      onChange={() => setGroupSlugs((current) => toggle(current, group.slug))}
                    />
                    {group.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            No group ticked means every group.
          </p>
        </fieldset>

        <fieldset className="mb-4">
          <legend className={labelClass}>Services</legend>
          {services.isPending ? (
            <InlineSpinner label="Loading services" />
          ) : services.isError ? (
            <p className="text-sm text-[#EA0029]">{errorMessage(services.error)}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {services.data.services.map((service) => (
                <li key={service.slug}>
                  <label
                    className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border px-4 text-sm ${
                      serviceSlugs.includes(service.slug)
                        ? 'border-[#EA0029] bg-[#EA0029] text-white'
                        : 'border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={serviceSlugs.includes(service.slug)}
                      onChange={() => setServiceSlugs((current) => toggle(current, service.slug))}
                    />
                    {service.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset className="mb-4">
          <legend className={labelClass}>Roles</legend>
          <ul className="flex flex-wrap gap-2">
            {ROLES.map((role) => (
              <li key={role}>
                <label
                  className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border px-4 text-sm ${
                    roles.includes(role)
                      ? 'border-[#EA0029] bg-[#EA0029] text-white'
                      : 'border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={roles.includes(role)}
                    onChange={() => setRoles((current) => toggle(current, role))}
                  />
                  {ROLE_LABELS_PLURAL[role]}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="min-trips" className={labelClass}>
              Only people with at least this many completed trips
            </label>
            <input
              id="min-trips"
              type="number"
              min={0}
              max={1000}
              className={inputClass}
              value={minCompletedTrips}
              onChange={(event) => setMinCompletedTrips(event.target.value)}
              placeholder="0"
            />
          </div>
          <label className="flex min-h-[44px] items-center gap-3 self-end text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-slate-300 text-[#EA0029] focus:ring-[#EA0029] dark:border-slate-600 dark:bg-slate-800"
              checked={includeSnoozed}
              onChange={(event) => setIncludeSnoozed(event.target.checked)}
            />
            Include people who have snoozed notifications
          </label>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/60">
          {preview.isPending ? (
            <InlineSpinner label="Counting the audience" />
          ) : preview.isError ? (
            <ErrorState error={preview.error} onRetry={() => void preview.refetch()} what="the audience count" />
          ) : (
            <>
              <p className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white">
                <Users className="h-5 w-5 text-slate-400" aria-hidden="true" />
                {preview.data.count} {preview.data.count === 1 ? 'person' : 'people'}
                {preview.isFetching ? <InlineSpinner label="Updating" /> : null}
              </p>
              {preview.data.sample.length > 0 ? (
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Starting with {preview.data.sample.slice(0, 5).join(', ')}
                  {preview.data.count > 5 ? ' and others' : ''}.
                </p>
              ) : (
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Nobody matches these filters, so there is nothing to send.
                </p>
              )}
              {overLimit ? (
                <p className="mt-2 flex items-start gap-2 text-sm font-medium text-[#EA0029]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  That is above the {preview.data.max} person limit. Narrow the audience, or raise the limit
                  deliberately in settings.
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section className={panelClass}>
        <h2 className="mb-3 font-semibold text-slate-900 dark:text-white">What it says</h2>
        <div className="mb-4">
          <label htmlFor="announcement-title" className={labelClass}>
            Title
          </label>
          <input
            id="announcement-title"
            className={inputClass}
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Office closed Monday"
          />
        </div>
        <div className="mb-4">
          <label htmlFor="announcement-body" className={labelClass}>
            Message
          </label>
          <textarea
            id="announcement-body"
            rows={6}
            maxLength={1000}
            className={`${inputClass} py-2`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{body.length} of 1000 characters</p>
        </div>

        <fieldset>
          <legend className={labelClass}>Channels</legend>
          <ul className="flex flex-wrap gap-2">
            {NOTIFICATION_CHANNELS.map((channel) => (
              <li key={channel}>
                <label
                  className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border px-4 text-sm ${
                    channels.includes(channel)
                      ? 'border-[#EA0029] bg-[#EA0029] text-white'
                      : 'border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={channels.includes(channel)}
                    onChange={() => setChannels((current) => toggle(current, channel))}
                  />
                  {channel.toUpperCase()}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        {smsSelected && count !== null && segments > 0 ? (
          <p className="mt-3 text-sm text-slate-700 dark:text-slate-300">
            Estimate: {segments} SMS {segments === 1 ? 'segment' : 'segments'} each, about {segments * count} segments
            in total for {count} {count === 1 ? 'person' : 'people'}. It is an estimate — the real number depends on
            who has a mobile number on file and what the carrier charges a segment.
            {smsSegments(body).unicode
              ? ' This message contains characters that force 70 characters a segment instead of 160.'
              : ''}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={primaryButtonClass}
            disabled={!ready || overLimit || preview.isFetching}
            onClick={() => {
              setConflictMessage(null);
              setConfirmOpen(true);
            }}
          >
            {count === null
              ? 'Send'
              : `Send to ${count} ${count === 1 ? 'person' : 'people'}`}
          </button>
          {ready ? null : (
            <span className="text-sm text-slate-500 dark:text-slate-400">
              A title, a message, a channel and at least one recipient are needed.
            </span>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-white">Sent before</h2>
        {history.isPending ? (
          <ListSkeleton rows={3} lines={2} />
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} what="past announcements" />
        ) : history.data.announcements.length === 0 ? (
          <EmptyState icon={Megaphone} title="Nothing has been broadcast yet." hint="Everything sent shows up here with who sent it and how many it reached." />
        ) : (
          <ul className="space-y-2">
            {history.data.announcements.map((row) => (
              <li key={row.id} className={`${cardClass} p-4`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900 dark:text-white">{row.title}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-400">{row.body}</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {row.createdBy} · {row.channels.map((channel) => channel.toUpperCase()).join(', ')} ·{' '}
                      {row.recipientCount ?? 0} {row.recipientCount === 1 ? 'person' : 'people'} ·{' '}
                      {formatDateTime(row.sentAt ?? row.createdAt)}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      STATUS_CLASSES[row.status] ?? STATUS_CLASSES.draft
                    }`}
                  >
                    {titleCase(row.status)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmSendModal
        open={confirmOpen}
        busy={send.isPending}
        count={count ?? 0}
        title={title.trim()}
        channels={channels}
        conflictMessage={conflictMessage}
        onClose={() => {
          setConfirmOpen(false);
          setConflictMessage(null);
        }}
        onConfirm={(confirmed) => send.mutate(confirmed)}
      />
    </div>
  );
}

/** Typing the number back is the last stop before a message nobody can recall. */
function ConfirmSendModal({
  open,
  busy,
  count,
  title,
  channels,
  conflictMessage,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  count: number;
  title: string;
  channels: string[];
  conflictMessage: string | null;
  onClose: () => void;
  onConfirm: (count: number) => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const matches = typed.trim() === String(count);

  return (
    <Modal open={open} title="Confirm the broadcast" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!matches) return;
          onConfirm(count);
        }}
      >
        <p className="text-sm text-slate-700 dark:text-slate-200">
          <span className="font-semibold">{title}</span> goes to {count} {count === 1 ? 'person' : 'people'} by{' '}
          {channels.map((channel) => channel.toUpperCase()).join(', ')}. It cannot be recalled.
        </p>

        {conflictMessage ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/30">
            <p className="flex items-start gap-2 text-sm font-medium text-slate-900 dark:text-white">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#EA0029]" aria-hidden="true" />
              {conflictMessage}
            </p>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Nothing was sent. Close this, check the audience count on the page, and send again.
            </p>
          </div>
        ) : null}

        <div>
          <label htmlFor="confirm-count" className={labelClass}>
            Type {count} to confirm
          </label>
          <input
            id="confirm-count"
            inputMode="numeric"
            className={inputClass}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={primaryButtonClass} disabled={!matches || busy}>
            {busy ? 'Sending…' : `Send to ${count} ${count === 1 ? 'person' : 'people'}`}
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

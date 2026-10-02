/**
 * The two-way SMS console.
 *
 * The queue, not an inbox: every conversation has a status, an owner and an
 * unread count, because the failure mode of a shared inbox is two dispatchers
 * answering the same person and neither knowing. Claiming a thread is how that
 * is avoided; it never locks anyone out, it only says who has it.
 *
 * Opening a thread marks it read on the server, so the list is refetched after
 * a thread is opened as well as on a timer.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Hand, Inbox, MessageSquare, Send, TriangleAlert } from 'lucide-react';
import { replyThreadSchema, type ThreadStatus } from '@rvc/shared';
import { cn } from '@/lib/utils';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime, relativeTime, telHref, titleCase, formatPhone } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, inputClass, panelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';

interface ThreadRow {
  id: string;
  phone: string;
  displayName: string | null;
  partyType: string;
  status: string;
  unreadCount: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  preview: string | null;
  tripId: string | null;
}
interface ThreadListResponse {
  threads: ThreadRow[];
  unread: number;
}

interface MessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  channel: string;
  status: string;
  failureReason: string | null;
  createdAt: string;
  sentById: string | null;
  sentByName: string | null;
}
/** The detail endpoint returns the thread row itself, which carries no owner name. */
interface ThreadDetailResponse {
  thread: {
    id: string;
    phone: string;
    displayName: string | null;
    partyType: string;
    status: string;
    ownerId: string | null;
    tripId: string | null;
  };
  messages: MessageRow[];
}

const MESSAGE_TABS = [
  { id: 'all-open', label: 'All open', status: 'open', mine: false },
  { id: 'mine', label: 'Mine', status: 'open', mine: true },
  { id: 'snoozed', label: 'Snoozed', status: 'snoozed', mine: false },
  { id: 'closed', label: 'Closed', status: 'closed', mine: false },
] as const;

const PARTY_LABELS: Record<string, string> = {
  volunteer: 'Volunteer',
  caller: 'Caller',
  unknown: 'Unknown number',
};

/** A GSM-7 message splits at 160 characters, and concatenated parts at 153. */
function segmentCount(length: number): number {
  if (length === 0) return 0;
  if (length <= 160) return 1;
  return Math.ceil(length / 153);
}

export function MessagesPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [statusFilter, setStatusFilter] = useState<'open' | 'snoozed' | 'closed' | 'all'>('open');
  const [mine, setMine] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const threads = useQuery({
    queryKey: qk.conversations.list({ status: statusFilter, mine }),
    queryFn: () =>
      api.get<ThreadListResponse>('/api/conversations', {
        status: statusFilter,
        ...(mine ? { mine: true } : {}),
        limit: 100,
      }),
    // A new message must appear without anyone reloading the console.
    refetchInterval: 15_000,
  });

  const thread = useQuery({
    queryKey: qk.conversations.detail(selectedId ?? ''),
    queryFn: () => api.get<ThreadDetailResponse>(`/api/conversations/${selectedId ?? ''}`),
    enabled: selectedId !== null,
  });

  /**
   * Only the list key, never the `conversations` root: the root also covers the
   * open thread, and invalidating that from the effect below would refetch the
   * thread, fire the effect again and loop.
   */
  const invalidateList = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.conversations.list({ status: statusFilter, mine }) });
  };
  const invalidateBoth = (id: string): void => {
    void queryClient.invalidateQueries({ queryKey: qk.conversations.detail(id) });
    invalidateList();
  };

  // Opening a thread clears its unread count server-side; the queue badge is
  // only right again once the list has been asked a second time.
  useEffect(() => {
    if (!thread.isSuccess) return;
    void queryClient.invalidateQueries({ queryKey: qk.conversations.list({ status: statusFilter, mine }) });
  }, [thread.isSuccess, selectedId, statusFilter, mine, queryClient]);

  useEffect(() => {
    const box = transcriptRef.current;
    // Scroll the transcript itself rather than the page: scrollIntoView would
    // drag the whole console down on a phone.
    if (box) box.scrollTop = box.scrollHeight;
  }, [thread.dataUpdatedAt, selectedId]);

  const reply = useMutation({
    mutationFn: (body: string) => api.post(`/api/conversations/${selectedId ?? ''}/reply`, { body }),
    onSuccess: () => {
      if (selectedId) invalidateBoth(selectedId);
      setDraft('');
      toast.success('Reply sent.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const claim = useMutation({
    mutationFn: (input: { id: string; release: boolean }) =>
      api.post(`/api/conversations/${input.id}/${input.release ? 'release' : 'claim'}`),
    onSuccess: (_data, input) => {
      invalidateBoth(input.id);
      toast.success(input.release ? 'Conversation released.' : 'You have this conversation.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: ThreadStatus }) =>
      api.post(`/api/conversations/${input.id}/status`, { status: input.status }),
    onSuccess: (_data, input) => {
      invalidateBoth(input.id);
      toast.success(
        input.status === 'closed'
          ? 'Conversation closed.'
          : input.status === 'snoozed'
            ? 'Conversation snoozed.'
            : 'Conversation reopened.',
      );
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const selectedRow = threads.data?.threads.find((row) => row.id === selectedId) ?? null;
  const ownerId = thread.data?.thread.ownerId ?? selectedRow?.ownerId ?? null;
  const ownerName = ownerId === user?.id ? 'you' : (selectedRow?.ownerName ?? null);
  const draftLength = draft.trim().length;
  const segments = segmentCount(draftLength);

  const sendReply = (event: React.FormEvent): void => {
    event.preventDefault();
    const parsed = replyThreadSchema.safeParse({ body: draft });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the message above.');
      return;
    }
    reply.mutate(parsed.data.body);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Messages"
        subtitle={
          threads.data && threads.data.unread > 0
            ? `${threads.data.unread} conversation${threads.data.unread === 1 ? '' : 's'} waiting for a reply`
            : 'Two-way texting with callers and volunteers'
        }
      />

      {/* Tabs instead of a dropdown plus a checkbox: the two views a dispatcher
          switches between all day are one tap each. Snoozed and closed stay
          reachable for looking something up. */}
      <div role="tablist" aria-label="Conversation views" className="flex flex-wrap gap-2">
        {MESSAGE_TABS.map((tab) => {
          const active = statusFilter === tab.status && mine === tab.mine;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setStatusFilter(tab.status);
                setMine(tab.mine);
              }}
              className={cn(
                'min-h-[44px] whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors',
                active
                  ? 'bg-[#EA0029] text-white'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <section
          aria-label="Conversations"
          className={`space-y-2 ${selectedId === null ? 'block' : 'hidden lg:block'}`}
        >
          {threads.isPending ? (
            <ListSkeleton rows={4} lines={1} />
          ) : threads.isError ? (
            <ErrorState error={threads.error} onRetry={() => void threads.refetch()} what="the conversation queue" />
          ) : threads.data.threads.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing in this part of the queue."
              hint="Replies from callers and volunteers land here the moment they arrive."
            />
          ) : (
            threads.data.threads.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => {
                  setSelectedId(row.id);
                  setDraft('');
                }}
                aria-current={selectedId === row.id ? 'true' : undefined}
                className={`w-full rounded-xl border p-4 text-left transition-colors ${
                  selectedId === row.id
                    ? 'border-[#EA0029] bg-red-50 dark:border-[#EA0029] dark:bg-red-950/30'
                    : 'border-slate-200 bg-white hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate font-medium text-slate-900 dark:text-white">
                    {row.displayName ?? row.phone}
                  </p>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    {row.unreadCount > 0 ? (
                      <span
                        className="grid min-w-[1.5rem] place-items-center rounded-full bg-[#EA0029] px-1.5 py-0.5 text-xs font-semibold text-white"
                        aria-label={`${row.unreadCount} unread`}
                      >
                        {row.unreadCount}
                      </span>
                    ) : null}
                    <span className="text-xs text-slate-500 dark:text-slate-400">{relativeTime(row.lastMessageAt)}</span>
                  </div>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">
                  {row.preview ?? 'No messages yet.'}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {PARTY_LABELS[row.partyType] ?? titleCase(row.partyType)}
                  {row.ownerName ? ` · with ${row.ownerId === user?.id ? 'you' : row.ownerName}` : ' · nobody has taken it'}
                </p>
              </button>
            ))
          )}
        </section>

        <section
          aria-label="Conversation"
          className={`${selectedId === null ? 'hidden lg:block' : 'block'}`}
        >
          {selectedId === null ? (
            <EmptyState
              icon={MessageSquare}
              title="Pick a conversation to read it."
              hint="Everything a caller or volunteer has texted is here, and you can reply from the same place."
            />
          ) : thread.isPending ? (
            <ListSkeleton rows={3} lines={2} />
          ) : thread.isError ? (
            <ErrorState error={thread.error} onRetry={() => void thread.refetch()} what="this conversation" />
          ) : (
            <div className="space-y-4">
              <div className={`${panelClass} space-y-3`}>
                <button
                  type="button"
                  className={`${secondaryButtonClass} lg:hidden`}
                  onClick={() => setSelectedId(null)}
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  Back to the queue
                </button>

                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                      {thread.data.thread.displayName ?? thread.data.thread.phone}
                    </h2>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      <a href={telHref(thread.data.thread.phone)} className="underline underline-offset-2">
                        {formatPhone(thread.data.thread.phone)}
                      </a>
                      {' · '}
                      {PARTY_LABELS[thread.data.thread.partyType] ?? titleCase(thread.data.thread.partyType)}
                      {' · '}
                      {titleCase(thread.data.thread.status)}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {ownerId ? `Taken by ${ownerName ?? 'another coordinator'}` : 'Nobody has taken this yet'}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {ownerId === null ? (
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={claim.isPending}
                        onClick={() => claim.mutate({ id: thread.data.thread.id, release: false })}
                      >
                        <Hand className="h-4 w-4" aria-hidden="true" />
                        Take this
                      </button>
                    ) : ownerId === user?.id ? (
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={claim.isPending}
                        onClick={() => claim.mutate({ id: thread.data.thread.id, release: true })}
                      >
                        Hand it back
                      </button>
                    ) : null}

                    {thread.data.thread.status === 'closed' ? (
                      <button
                        type="button"
                        className={secondaryButtonClass}
                        disabled={setStatus.isPending}
                        onClick={() => setStatus.mutate({ id: thread.data.thread.id, status: 'open' })}
                      >
                        Reopen
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={secondaryButtonClass}
                          disabled={setStatus.isPending || thread.data.thread.status === 'snoozed'}
                          onClick={() => setStatus.mutate({ id: thread.data.thread.id, status: 'snoozed' })}
                        >
                          Snooze
                        </button>
                        <button
                          type="button"
                          className={secondaryButtonClass}
                          disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ id: thread.data.thread.id, status: 'closed' })}
                        >
                          Close
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div
                ref={transcriptRef}
                className="max-h-[55vh] space-y-3 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950"
              >
                {thread.data.messages.length === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                    Nothing has been said in this conversation yet.
                  </p>
                ) : (
                  thread.data.messages.map((message) => {
                    const outbound = message.direction === 'outbound';
                    return (
                      <div key={message.id} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                        <div className="max-w-[85%] sm:max-w-[70%]">
                          <div
                            className={`whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-sm ${
                              outbound
                                ? 'rounded-br-sm bg-[#EA0029] text-white'
                                : 'rounded-bl-sm bg-white text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                            }`}
                          >
                            {message.body}
                          </div>
                          <p
                            className={`mt-1 text-xs text-slate-500 dark:text-slate-400 ${outbound ? 'text-right' : 'text-left'}`}
                          >
                            {formatDateTime(message.createdAt)}
                            {outbound && message.sentByName ? ` · ${message.sentByName}` : ''}
                          </p>
                          {message.failureReason ? (
                            <p
                              className={`mt-1 flex items-center gap-1 text-xs font-medium text-[#C80023] dark:text-red-400 ${
                                outbound ? 'justify-end' : 'justify-start'
                              }`}
                            >
                              <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                              Not delivered: {message.failureReason}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <form className="space-y-2" onSubmit={sendReply}>
                <label htmlFor="reply-body" className="sr-only">
                  Reply
                </label>
                <textarea
                  id="reply-body"
                  rows={3}
                  maxLength={1200}
                  className={`${inputClass} py-2`}
                  value={draft}
                  placeholder="Type a reply. They receive it as a text message."
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={`text-xs ${draftLength > 160 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                    {draftLength} / 1200 characters
                    {draftLength > 160 ? ` · this goes as ${segments} SMS segments` : ''}
                  </p>
                  <button type="submit" className={primaryButtonClass} disabled={reply.isPending || draftLength === 0}>
                    <Send className="h-4 w-4" aria-hidden="true" />
                    Send reply
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The words the system says to people, edited by the people responsible for
 * them rather than by a deploy.
 *
 * Two things on this screen exist because of how SMS actually bills and
 * renders: the segment count, and the warning about characters outside the GSM
 * basic set. A single curly quote pasted from a word processor drops the limit
 * from 160 characters to 70 and turns a one-segment offer into three — on every
 * offer, to every volunteer, until somebody notices the bill.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { History, MessageSquare, RotateCcw } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatDateTime, titleCase } from '@/lib/format';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, panelClass,
  primaryButtonClass, secondaryButtonClass,
} from '@/components/states';

interface TemplateRow {
  id: string;
  key: string;
  channel: string;
  locale: string;
  subject: string | null;
  body: string;
  description: string | null;
  variables: string[];
  active: boolean;
  version: number;
  updatedAt: string;
}

interface TemplateVersion {
  version: number;
  subject: string | null;
  body: string;
  changedAt: string;
  changedById: string | null;
}

interface TemplateListResponse {
  templates: TemplateRow[];
}

interface TemplateDetailResponse {
  template: TemplateRow & { versions: TemplateVersion[] };
}

const CHANNEL_CLASSES: Record<string, string> = {
  sms: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  email: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  whatsapp: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  push: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
};

/** Stand-ins for the preview. Real-looking, so a line that will wrap, wraps. */
const SAMPLE_VALUES: Record<string, string> = {
  appUrl: 'https://dispatch.example.org',
  borrowerName: 'Miriam Weiss',
  dashboardUrl: 'https://dispatch.example.org/board',
  daysOverdue: '4',
  downloadUrl: 'https://dispatch.example.org/exports/2f9c',
  dueDate: 'Thu, Sep 18',
  endClock: '4:30 pm',
  expiresIn: '20 minutes',
  failed: '2',
  fullName: 'Shimon Adler',
  inviteUrl: 'https://dispatch.example.org/invite/9d1a',
  itemName: 'Wheelchair, standard',
  kind: 'phone',
  message: 'The office is closed on Monday.',
  minutes: '20',
  offered: '12',
  orgName: "Refuah V'Chesed",
  orgPhone: '514 555 0143',
  phone: '514 555 0188',
  reason: 'The passenger cancelled.',
  reference: 'RVC-250914-014',
  resetUrl: 'https://dispatch.example.org/reset/7b2e',
  resumeUrl: 'https://dispatch.example.org/apply/7b2e',
  reviewUrl: 'https://dispatch.example.org/admin/applications',
  rowCount: '318',
  services: 'Rides, Equipment delivery',
  startClock: '9:00 am',
  title: 'Office closed Monday',
  tripCount: '3',
  untilClock: '6:00 pm',
  volunteerName: 'Chaya Klein',
  when: 'Tue, Sep 16 at 2:15 pm',
  window: '9:00 am to 4:30 pm',
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** GSM 03.38 basic set. Anything outside it forces the whole message to UCS-2. */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'.split(
    '',
  ),
);
/** Sent as an escape plus the character, so each costs two of the 160. */
const GSM_EXTENDED = new Set('^{}\\[~]|€'.split(''));

interface SmsCost {
  /** Billable units, not characters: an extended GSM character counts twice. */
  units: number;
  segments: number;
  perSegment: number;
  unicode: boolean;
  offending: string[];
}

export function smsCost(body: string): SmsCost {
  const offending: string[] = [];
  let units = 0;
  for (const char of [...body]) {
    if (GSM_BASIC.has(char)) {
      units += 1;
    } else if (GSM_EXTENDED.has(char)) {
      units += 2;
    } else {
      units += 1;
      if (!offending.includes(char)) offending.push(char);
    }
  }
  const unicode = offending.length > 0;
  // A unicode message is counted in UTF-16 code units, so an emoji is two.
  if (unicode) units = body.length;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  return { units, segments, perSegment: segments > 1 ? multi : single, unicode, offending };
}

/** Same substitution the server does, without the empty-line trimming. */
function interpolate(text: string, variables: string[]): string {
  return text.replace(PLACEHOLDER, (_match, name: string) =>
    SAMPLE_VALUES[name] ?? (variables.includes(name) ? `[${name}]` : `{{${name}}}`),
  );
}

export function TemplatesPage(): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: qk.templates.list(),
    queryFn: () => api.get<TemplateListResponse>('/api/templates'),
  });

  const grouped = useMemo(() => {
    const byKey = new Map<string, TemplateRow[]>();
    for (const row of list.data?.templates ?? []) {
      const bucket = byKey.get(row.key);
      if (bucket) bucket.push(row);
      else byKey.set(row.key, [row]);
    }
    return [...byKey.entries()];
  }, [list.data]);

  return (
    <div className="space-y-6">
      <PageHeader title="Message templates" subtitle="Every word the system sends, and its history" />

      {list.isPending ? (
        <ListSkeleton rows={5} lines={2} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} what="the templates" />
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No templates on file."
          hint="The built-in wording is being used until templates are seeded."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className={selectedId ? 'hidden lg:block' : 'block'}>
            <ul className="space-y-4">
              {grouped.map(([key, rows]) => (
                <li key={key}>
                  <h2 className="font-mono text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {key}
                  </h2>
                  <p className="mb-2 text-sm text-slate-600 dark:text-slate-400">
                    {rows[0]?.description ?? 'No description on file.'}
                  </p>
                  <ul className="space-y-2">
                    {rows.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(row.id)}
                          aria-current={row.id === selectedId}
                          className={`${cardClass} flex w-full min-h-[44px] items-center justify-between gap-3 p-3 text-left ${
                            row.id === selectedId ? 'ring-2 ring-[#EA0029]' : ''
                          }`}
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-full px-3 py-1 text-xs font-medium ${
                                CHANNEL_CLASSES[row.channel] ?? CHANNEL_CLASSES.push
                              }`}
                            >
                              {row.channel.toUpperCase()}
                            </span>
                            <span className="text-sm text-slate-700 dark:text-slate-200">
                              {row.locale.toUpperCase()} · v{row.version}
                            </span>
                          </span>
                          {row.active ? null : (
                            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">Off</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>

          <div className={selectedId ? 'block' : 'hidden lg:block'}>
            {selectedId ? (
              <TemplateEditor id={selectedId} onClose={() => setSelectedId(null)} />
            ) : (
              <EmptyState title="Pick a template to edit." hint="The preview fills in sample values as you type." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TemplateEditor({ id, onClose }: { id: string; onClose: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const seededFrom = useRef<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const [lastFocused, setLastFocused] = useState<'subject' | 'body'>('body');

  const detail = useQuery({
    queryKey: qk.templates.detail(id),
    queryFn: () => api.get<TemplateDetailResponse>(`/api/templates/${id}`),
  });

  // Seed the editable copy once per saved version, so a background refetch
  // cannot wipe an edit in progress but a real revert does land.
  const template = detail.data?.template;
  useEffect(() => {
    if (!template) return;
    const signature = `${template.id}:${template.version}`;
    if (seededFrom.current === signature) return;
    seededFrom.current = signature;
    setSubject(template.subject ?? '');
    setBody(template.body);
  }, [template]);

  const save = useMutation({
    mutationFn: (patch: { subject?: string | null; body?: string; active?: boolean }) =>
      api.patch<{ template: TemplateRow }>(`/api/templates/${id}`, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.templates.all() });
      toast.success('Template saved.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const revert = useMutation({
    mutationFn: (version: number) => api.post<{ template: TemplateRow }>(`/api/templates/${id}/revert`, { version }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.templates.all() });
      toast.success('Reverted. The old wording is back as a new version.');
    },
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  if (detail.isPending) return <ListSkeleton rows={2} lines={5} />;
  if (detail.isError) {
    return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} what="this template" />;
  }

  const current = detail.data.template;
  const isSms = current.channel === 'sms' || current.channel === 'whatsapp';
  const cost = smsCost(body);
  const dirty = body !== current.body || subject !== (current.subject ?? '');

  const insertVariable = (name: string): void => {
    const token = `{{${name}}}`;
    if (lastFocused === 'subject' && subjectRef.current) {
      const input = subjectRef.current;
      const start = input.selectionStart ?? subject.length;
      const end = input.selectionEnd ?? start;
      const next = `${subject.slice(0, start)}${token}${subject.slice(end)}`;
      setSubject(next);
      // Put the caret after the token, so chips can be clicked one after another.
      window.requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(start + token.length, start + token.length);
      });
      return;
    }
    const area = bodyRef.current;
    const start = area?.selectionStart ?? body.length;
    const end = area?.selectionEnd ?? start;
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`;
    setBody(next);
    window.requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="space-y-4">
      <button type="button" className={`${secondaryButtonClass} lg:hidden`} onClick={onClose}>
        Back to the list
      </button>

      <section className={panelClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-mono text-sm font-semibold text-slate-900 dark:text-white">{current.key}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {current.channel.toUpperCase()} · {current.locale.toUpperCase()} · version {current.version} · saved{' '}
              {formatDateTime(current.updatedAt)}
            </p>
          </div>
          <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-slate-300 text-[#EA0029] focus:ring-[#EA0029] dark:border-slate-600 dark:bg-slate-800"
              checked={current.active}
              disabled={save.isPending}
              onChange={(event) => save.mutate({ active: event.target.checked })}
            />
            In use
          </label>
        </div>
        {current.active ? null : (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            This one is switched off, so the built-in wording is sent instead.
          </p>
        )}
      </section>

      <section className={panelClass}>
        <h3 className="mb-2 font-semibold text-slate-900 dark:text-white">Available values</h3>
        {current.variables.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">This template takes no values.</p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-2">
              {current.variables.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => insertVariable(name)}
                    className="min-h-[44px] rounded-full border border-slate-300 bg-white px-3 font-mono text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    {`{{${name}}}`}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Clicking one drops it where your cursor is. A value this template does not have is refused when you save.
            </p>
          </>
        )}
      </section>

      <section className={panelClass}>
        {current.channel === 'email' ? (
          <div className="mb-4">
            <label htmlFor="template-subject" className={labelClass}>
              Subject
            </label>
            <input
              id="template-subject"
              ref={subjectRef}
              className={inputClass}
              value={subject}
              maxLength={200}
              onFocus={() => setLastFocused('subject')}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>
        ) : null}

        <label htmlFor="template-body" className={labelClass}>
          Message
        </label>
        <textarea
          id="template-body"
          ref={bodyRef}
          rows={10}
          maxLength={4000}
          className={`${inputClass} py-2 font-mono`}
          value={body}
          onFocus={() => setLastFocused('body')}
          onChange={(event) => setBody(event.target.value)}
        />

        {isSms ? (
          <div className="mt-2 space-y-1 text-sm">
            <p className="text-slate-600 dark:text-slate-400">
              {body.length} characters · {cost.segments} {cost.segments === 1 ? 'segment' : 'segments'} · billed per
              segment, per recipient
            </p>
            {cost.unicode ? (
              <p className="font-medium text-amber-700 dark:text-amber-300">
                {cost.offending.slice(0, 6).join(' ')} {cost.offending.length > 6 ? '…' : ''} cannot be sent as plain
                GSM text, so this message drops to 70 characters a segment instead of 160. Replacing curly quotes,
                dashes and accents with plain ones usually fixes it.
              </p>
            ) : (
              <p className="text-slate-500 dark:text-slate-400">
                Plain GSM text: 160 characters in one segment, then 153 for each one after.
              </p>
            )}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={primaryButtonClass}
            disabled={!dirty || save.isPending || !body.trim()}
            onClick={() =>
              save.mutate({
                body,
                ...(current.channel === 'email' ? { subject: subject.trim() || null } : {}),
              })
            }
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={!dirty}
            onClick={() => {
              setSubject(current.subject ?? '');
              setBody(current.body);
            }}
          >
            Undo my changes
          </button>
          {dirty ? (
            <span className="text-sm text-slate-500 dark:text-slate-400">Not saved yet.</span>
          ) : null}
        </div>
      </section>

      <section className={panelClass}>
        <h3 className="mb-2 font-semibold text-slate-900 dark:text-white">Preview</h3>
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
          Sample values, not real ones. The live message uses the trip and person it is about.
        </p>
        {current.channel === 'email' && subject ? (
          <p className="mb-2 text-sm font-semibold text-slate-900 dark:text-white">
            {interpolate(subject, current.variables)}
          </p>
        ) : null}
        <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-800 dark:bg-slate-800 dark:text-slate-100">
          {interpolate(body, current.variables) || 'Nothing to preview yet.'}
        </pre>
      </section>

      <section className={panelClass}>
        <h3 className="mb-2 flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
          <History className="h-5 w-5" aria-hidden="true" />
          History
        </h3>
        {current.versions.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            No earlier versions. The first edit starts the history.
          </p>
        ) : (
          <ul className="space-y-2">
            {[...current.versions]
              .sort((a, b) => b.version - a.version)
              .map((version) => (
                <li
                  key={version.version}
                  className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-900 dark:text-white">
                      Version {version.version} · {formatDateTime(version.changedAt)}
                    </p>
                    <button
                      type="button"
                      className={secondaryButtonClass}
                      disabled={revert.isPending || version.version === current.version}
                      onClick={() => revert.mutate(version.version)}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      {version.version === current.version ? 'In use' : 'Restore this'}
                    </button>
                  </div>
                  {version.subject ? (
                    <p className="mt-1 text-sm font-medium text-slate-700 dark:text-slate-200">{version.subject}</p>
                  ) : null}
                  <pre className="mt-1 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">
                    {version.body}
                  </pre>
                </li>
              ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Restoring writes the old wording forward as a new version. Nothing in the history is ever edited.
        </p>
      </section>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {titleCase(current.channel)} template. Saving takes effect on the next message that uses it.
      </p>
    </div>
  );
}

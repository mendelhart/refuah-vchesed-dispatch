/**
 * Email builder (item 9). Phone first: one column, editing and preview on
 * separate tabs; side by side on wide screens. Designs are blocks (heading,
 * paragraph, button, picture, line) with merge fields from a fixed list.
 * Every save is a version that can be brought back. "Send me a test" goes to
 * your own address only, through the test-mode email provider.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Mail, Plus, Trash2 } from 'lucide-react';
import { MERGE_FIELDS, renderEmail, type EmailBlock, type EmailDesignInput, type MergeField } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  EmptyState, ErrorState, ListSkeleton, PageHeader, cardClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass,
} from '@/components/states';
import {
  BLOCK_LABELS, FIELD_LABELS, insertField, moveBlock, newBlock, previewValues, removeBlock, sameDesign, validateDesign, type BlockType,
} from './email-builder-model';

interface Design { id: string; name: string; subject: string; blocks: EmailBlock[]; version: number; updatedAt: string; updatedBy: string | null; archived: boolean }
interface Version { version: number; name: string; subject: string; blocks: EmailBlock[]; savedAt: string; savedBy: string | null }
interface DesignResponse { design: Design; versions: Version[] }

const when = (iso: string) => new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' });
const smallButton = 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-lg border border-slate-300 px-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-100 dark:hover:bg-slate-800';

// --- list --------------------------------------------------------------------------------

export function EmailDesignsPage(): React.JSX.Element {
  const [archived, setArchived] = useState(false);
  const q = useQuery({ queryKey: ['email-designs', archived], queryFn: () => api.get<{ designs: Design[] }>('/api/email-designs', { archived }) });
  return (
    <div className="space-y-4">
      <PageHeader title="Email builder" subtitle="Design an email, preview it, and send yourself a test." actions={<Link to="/email-builder/new" className={primaryButtonClass}><Plus className="h-4 w-4" aria-hidden="true" /> New design</Link>} />
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
        <input type="checkbox" className="h-5 w-5" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived designs
      </label>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} what="the designs" /> : null}
      {q.isPending ? <ListSkeleton rows={2} lines={2} /> : null}
      {q.data && q.data.designs.length === 0 ? <EmptyState icon={Mail} title="No email designs yet" hint="Start one with New design." /> : null}
      <ul className="space-y-2">
        {q.data?.designs.map((d) => (
          <li key={d.id}>
            <Link to={`/email-builder/${d.id}`} className={`${cardClass} block p-4 hover:border-slate-400`}>
              <span className="block font-semibold text-slate-900 dark:text-white">{d.name}{d.archived ? ' (archived)' : ''}</span>
              <span className="block text-sm text-slate-700 dark:text-slate-200">{d.subject}</span>
              <span className="block text-sm text-slate-600 dark:text-slate-300">Version {d.version} · {when(d.updatedAt)}{d.updatedBy ? ` · ${d.updatedBy}` : ''}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- editor ------------------------------------------------------------------------------

type Focus = { where: 'subject' } | { where: 'block'; index: number; field: 'text' | 'label' };

function BlockEditor({ block, index, count, error, onChange, onMove, onRemove, onFocusField }: {
  block: EmailBlock; index: number; count: number; error?: string;
  onChange: (b: EmailBlock) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
  onFocusField: (field: 'text' | 'label', el: HTMLInputElement | HTMLTextAreaElement) => void;
}): React.JSX.Element {
  const n = index + 1;
  const id = `blk-${index}`;
  const name = `${BLOCK_LABELS[block.type]} ${n}`;
  return (
    <li className={`${cardClass} space-y-2 p-3`} aria-label={name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-900 dark:text-white">{name}</span>
        <span className="flex gap-1">
          <button type="button" className={smallButton} onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${name} up`}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" className={smallButton} onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move ${name} down`}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
          <button type="button" className={smallButton} onClick={onRemove} aria-label={`Remove ${name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
        </span>
      </div>
      {block.type === 'heading' ? (
        <div><label htmlFor={id} className={labelClass}>Heading text</label>
          <input id={id} className={inputClass} value={block.text} onFocus={(e) => onFocusField('text', e.currentTarget)} onSelect={(e) => onFocusField('text', e.currentTarget)} onChange={(e) => onChange({ ...block, text: e.target.value })} /></div>
      ) : null}
      {block.type === 'text' ? (
        <div><label htmlFor={id} className={labelClass}>Paragraph text</label>
          <textarea id={id} rows={4} className={inputClass} value={block.text} onFocus={(e) => onFocusField('text', e.currentTarget)} onSelect={(e) => onFocusField('text', e.currentTarget)} onChange={(e) => onChange({ ...block, text: e.target.value })} /></div>
      ) : null}
      {block.type === 'button' ? (
        <div className="grid gap-2 sm:grid-cols-2 [&>*]:min-w-0">
          <div><label htmlFor={id} className={labelClass}>Button words</label>
            <input id={id} className={inputClass} value={block.label} onFocus={(e) => onFocusField('label', e.currentTarget)} onSelect={(e) => onFocusField('label', e.currentTarget)} onChange={(e) => onChange({ ...block, label: e.target.value })} /></div>
          <div><label htmlFor={`${id}-url`} className={labelClass}>Link (https://, mailto: or tel:)</label>
            <input id={`${id}-url`} inputMode="url" className={inputClass} value={block.url} onChange={(e) => onChange({ ...block, url: e.target.value })} /></div>
        </div>
      ) : null}
      {block.type === 'image' ? (
        <div className="grid gap-2 sm:grid-cols-2 [&>*]:min-w-0">
          <div><label htmlFor={id} className={labelClass}>Picture address (https://)</label>
            <input id={id} inputMode="url" className={inputClass} value={block.url} onChange={(e) => onChange({ ...block, url: e.target.value })} /></div>
          <div><label htmlFor={`${id}-alt`} className={labelClass}>What the picture shows</label>
            <input id={`${id}-alt`} className={inputClass} value={block.alt} onChange={(e) => onChange({ ...block, alt: e.target.value })} /></div>
        </div>
      ) : null}
      {block.type === 'divider' ? <p className="text-sm text-slate-600 dark:text-slate-300">A thin line between sections.</p> : null}
      {error ? <p className="text-sm font-medium text-[#C80023] dark:text-red-400" role="alert">{error}</p> : null}
    </li>
  );
}

function Editor({ initial, versions }: { initial: Design | null; versions: Version[] }): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const org = useQuery({ queryKey: ['organization'], queryFn: () => api.get<{ organization: { name: string } | null }>('/api/organization'), staleTime: 300_000 });
  const saved: EmailDesignInput = useMemo(() => (initial ? { name: initial.name, subject: initial.subject, blocks: initial.blocks } : { name: '', subject: '', blocks: [newBlock('heading'), newBlock('text')] }),
    // Only a new save (version) resets the editor; a background refetch of the same version must not wipe unsaved work.
    [initial?.id, initial?.version]);
  const [draft, setDraft] = useState<EmailDesignInput>(saved);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [showErrors, setShowErrors] = useState(false);
  const [restoreAsk, setRestoreAsk] = useState<number | null>(null);
  const focus = useRef<{ f: Focus; pos: number | null } | null>(null);
  useEffect(() => setDraft(saved), [saved]);

  const errors = validateDesign(draft);
  const dirty = !sameDesign(draft, saved);
  const preview = useMemo(
    () => renderEmail(draft, previewValues(user?.fullName ?? 'Sample Person', org.data?.organization?.name ?? 'Refuah V’Chesed', new Date()), { imagePlaceholders: true }),
    [draft, user?.fullName, org.data],
  );

  const refresh = (data: DesignResponse) => {
    queryClient.setQueryData(['email-design', data.design.id], data);
    void queryClient.invalidateQueries({ queryKey: ['email-designs'] });
  };
  const save = useMutation({
    mutationFn: () => (initial
      ? api.put<DesignResponse>(`/api/email-designs/${initial.id}`, { ...draft, baseVersion: initial.version })
      : api.post<DesignResponse>('/api/email-designs', draft)),
    onSuccess: (data) => {
      refresh(data);
      toast.success(`Saved as version ${data.design.version}.`);
      if (!initial) navigate(`/email-builder/${data.design.id}`, { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ sentTo: string }>(`/api/email-designs/${initial!.id}/test-send`),
    onSuccess: (r) => toast.success(`Test recorded for ${r.sentTo}. Test mode: nothing leaves the app.`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.post<DesignResponse>(`/api/email-designs/${initial!.id}/restore`, { version }),
    onSuccess: (data, version) => { refresh(data); setRestoreAsk(null); toast.success(`Version ${version} is back, saved as version ${data.design.version}.`); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const archive = useMutation({
    mutationFn: (archived: boolean) => api.post<DesignResponse>(`/api/email-designs/${initial!.id}/archive`, { archived }),
    onSuccess: (data) => { refresh(data); toast.success(data.design.archived ? 'Archived.' : 'Brought back from the archive.'); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const setBlocks = (blocks: EmailBlock[]) => setDraft((d) => ({ ...d, blocks }));
  const remember = (f: Focus, el: HTMLInputElement | HTMLTextAreaElement) => { focus.current = { f, pos: el.selectionStart }; };
  const insert = (field: MergeField) => {
    const target = focus.current ?? { f: { where: 'subject' } as Focus, pos: null };
    if (target.f.where === 'subject') {
      const r = insertField(draft.subject, field, target.pos);
      setDraft((d) => ({ ...d, subject: r.text }));
      focus.current = { f: target.f, pos: r.cursor };
      return;
    }
    const { index, field: which } = target.f;
    const b = draft.blocks[index];
    if (!b || (b.type !== 'heading' && b.type !== 'text' && b.type !== 'button')) return;
    const current = which === 'label' && b.type === 'button' ? b.label : 'text' in b ? b.text : '';
    const r = insertField(current, field, target.pos);
    const next = which === 'label' && b.type === 'button' ? { ...b, label: r.text } : { ...b, text: r.text };
    setBlocks(draft.blocks.map((x, k) => (k === index ? (next as EmailBlock) : x)));
    focus.current = { f: target.f, pos: r.cursor };
  };
  const trySave = () => {
    setShowErrors(true);
    if (Object.keys(errors).length) { toast.error('Some parts need fixing first. They are marked in red.'); return; }
    save.mutate();
  };

  const archived = initial?.archived ?? false;
  const tabButton = (t: 'edit' | 'preview', label: string) => (
    <button type="button" role="tab" aria-selected={tab === t} aria-controls={`eb-${t}`} id={`eb-tab-${t}`} onClick={() => setTab(t)}
      className={`min-h-[44px] flex-1 rounded-lg px-3 text-sm font-semibold ${tab === t ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'text-slate-800 dark:text-slate-100'}`}>{label}</button>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={initial ? initial.name : 'New email design'} subtitle={initial ? `Version ${initial.version}${dirty ? ' · unsaved changes' : ''}${archived ? ' · archived' : ''}` : 'Not saved yet'} />
      <div role="tablist" aria-label="Edit or preview" className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1 lg:hidden dark:border-slate-700 dark:bg-slate-900">
        {tabButton('edit', 'Edit')}{tabButton('preview', 'Preview')}
      </div>
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <section id="eb-edit" role="tabpanel" aria-labelledby="eb-tab-edit" className={`space-y-3 ${tab === 'edit' ? '' : 'hidden lg:block'}`}>
          <div className={`${cardClass} space-y-3 p-4`}>
            <div><label htmlFor="eb-name" className={labelClass}>Design name (only staff see this)</label>
              <input id="eb-name" className={inputClass} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              {showErrors && errors.name ? <p role="alert" className="mt-1 text-sm font-medium text-[#C80023] dark:text-red-400">{errors.name}</p> : null}</div>
            <div><label htmlFor="eb-subject" className={labelClass}>Subject</label>
              <input id="eb-subject" className={inputClass} value={draft.subject} onFocus={(e) => remember({ where: 'subject' }, e.currentTarget)} onSelect={(e) => remember({ where: 'subject' }, e.currentTarget)} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              {showErrors && errors.subject ? <p role="alert" className="mt-1 text-sm font-medium text-[#C80023] dark:text-red-400">{errors.subject}</p> : null}</div>
            <div>
              <p className={labelClass} id="eb-fields">Put in a merge field (where the cursor was)</p>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="eb-fields">
                {MERGE_FIELDS.map((f) => (
                  <button key={f} type="button" className={smallButton} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(f)}>{FIELD_LABELS[f]}</button>
                ))}
              </div>
            </div>
          </div>

          <ol className="space-y-2" aria-label="Blocks">
            {draft.blocks.map((b, i) => (
              <BlockEditor key={i} block={b} index={i} count={draft.blocks.length} error={showErrors ? errors[`blocks.${i}`] : undefined}
                onChange={(nb) => setBlocks(draft.blocks.map((x, k) => (k === i ? nb : x)))}
                onMove={(by) => setBlocks(moveBlock(draft.blocks, i, by))}
                onRemove={() => setBlocks(removeBlock(draft.blocks, i))}
                onFocusField={(field, el) => remember({ where: 'block', index: i, field }, el)} />
            ))}
          </ol>
          <div className={`${cardClass} p-4`}>
            <p className={labelClass} id="eb-add">Add a block</p>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="eb-add">
              {(Object.keys(BLOCK_LABELS) as BlockType[]).map((t) => (
                <button key={t} type="button" className={smallButton} onClick={() => setBlocks([...draft.blocks, newBlock(t)])}><Plus className="h-4 w-4" aria-hidden="true" /> {BLOCK_LABELS[t]}</button>
              ))}
            </div>
          </div>
        </section>

        <section id="eb-preview" role="tabpanel" aria-labelledby="eb-tab-preview" className={`space-y-2 ${tab === 'preview' ? '' : 'hidden lg:block'}`}>
          <div className={`${cardClass} p-3`}>
            <p className="text-sm text-slate-700 dark:text-slate-200"><span className="font-semibold">Subject:</span> {preview.subject || '(no subject)'}</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">Shown with your own name. Pictures appear as labelled boxes here.</p>
          </div>
          <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[32rem] w-full rounded-xl border border-slate-200 bg-white dark:border-slate-700" />
        </section>
      </div>

      <div className={`${cardClass} flex flex-wrap gap-2 p-4`}>
        <button type="button" className={primaryButtonClass} onClick={trySave} disabled={save.isPending || archived || (!!initial && !dirty)}>{save.isPending ? 'Saving…' : initial ? 'Save a new version' : 'Save'}</button>
        {initial ? (
          <>
            <button type="button" className={secondaryButtonClass} onClick={() => test.mutate()} disabled={test.isPending || dirty} title={dirty ? 'Save first; the test uses the saved version' : undefined}>Send me a test</button>
            <button type="button" className={secondaryButtonClass} onClick={() => archive.mutate(!archived)} disabled={archive.isPending}>{archived ? 'Bring back from archive' : 'Archive'}</button>
          </>
        ) : null}
        <Link to="/email-builder" className={secondaryButtonClass}>Back to all designs</Link>
        {initial && dirty ? <p className="w-full text-sm text-slate-600 dark:text-slate-300">Save first to send a test; the test uses the saved version.</p> : null}
      </div>

      {initial ? (
        <section aria-labelledby="eb-versions" className={`${cardClass} p-4`}>
          <h2 id="eb-versions" className="mb-2 text-base font-semibold text-slate-900 dark:text-white">Saved versions</h2>
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm text-slate-800 dark:text-slate-100">
                  <span className="font-semibold">Version {v.version}</span> · {when(v.savedAt)}{v.savedBy ? ` · ${v.savedBy}` : ''}
                  <span className="block text-slate-600 dark:text-slate-300">{v.subject}</span>
                </span>
                {v.version === initial.version ? <span className="text-sm text-slate-600 dark:text-slate-300">Current</span>
                  : restoreAsk === v.version ? (
                    <span className="flex gap-2">
                      <button type="button" className={primaryButtonClass} onClick={() => restore.mutate(v.version)} disabled={restore.isPending || archived}>Yes, bring it back</button>
                      <button type="button" className={secondaryButtonClass} onClick={() => setRestoreAsk(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button type="button" className={secondaryButtonClass} onClick={() => setRestoreAsk(v.version)} disabled={archived || dirty}>Bring back version {v.version}</button>
                  )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function EmailDesignPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const q = useQuery({ queryKey: ['email-design', id], queryFn: () => api.get<DesignResponse>(`/api/email-designs/${id}`), enabled: !isNew && !!id });
  if (isNew) return <Editor initial={null} versions={[]} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} what="this design" />;
  if (!q.data) return <ListSkeleton rows={2} lines={3} />;
  return <Editor initial={q.data.design} versions={q.data.versions} />;
}

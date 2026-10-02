import { z } from 'zod';

/**
 * Email builder (item 9). A design is a subject line and a list of blocks.
 * The renderer here is shared by the API (test sends) and the web app (live
 * preview), so what a coordinator sees is exactly what is sent.
 *
 * Merge fields are `{{name}}` from a fixed list and nothing else: no
 * template language, no HTML typed by hand. Every piece of text is escaped,
 * and links must be https (or mailto:/tel: for buttons).
 */

export const MERGE_FIELDS = ['firstName', 'fullName', 'organizationName', 'today'] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string>>;

const FIELD = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Merge fields named in a piece of text that are not on the list. */
export function unknownMergeFields(text: string): string[] {
  const bad = new Set<string>();
  for (const m of text.matchAll(FIELD)) if (!(MERGE_FIELDS as readonly string[]).includes(m[1]!)) bad.add(m[1]!);
  return [...bad];
}

const mergeText = (max: number) =>
  z.string().trim().max(max).superRefine((s, ctx) => {
    const bad = unknownMergeFields(s);
    if (bad.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown merge field: ${bad.join(', ')}. Use ${MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')}.` });
  });

const httpsUrl = z.string().trim().max(2000).refine((u) => /^https:\/\/[^\s"'<>]+$/i.test(u), 'Links must start with https://');
const buttonUrl = z.string().trim().max(2000).refine(
  (u) => /^https:\/\/[^\s"'<>]+$/i.test(u) || /^mailto:[^\s"'<>]+$/i.test(u) || /^tel:\+?[0-9 ()-]+$/i.test(u),
  'Links must start with https://, mailto: or tel:',
);

export const emailBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: mergeText(200).pipe(z.string().min(1, 'A heading needs some words')) }),
  z.object({ type: z.literal('text'), text: mergeText(5000).pipe(z.string().min(1, 'A paragraph needs some words')) }),
  z.object({ type: z.literal('button'), label: mergeText(80).pipe(z.string().min(1, 'A button needs a label')), url: buttonUrl }),
  z.object({ type: z.literal('image'), url: httpsUrl, alt: z.string().trim().min(1, 'Describe the picture for people who cannot see it').max(300) }),
  z.object({ type: z.literal('divider') }),
]);
export type EmailBlock = z.infer<typeof emailBlockSchema>;
export const EMAIL_BLOCK_TYPES = ['heading', 'text', 'button', 'image', 'divider'] as const;

export const MAX_EMAIL_BLOCKS = 40;

export const emailDesignInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the design a name').max(120),
  subject: mergeText(200).pipe(z.string().min(1, 'The email needs a subject')),
  blocks: z.array(emailBlockSchema).max(MAX_EMAIL_BLOCKS, `At most ${MAX_EMAIL_BLOCKS} blocks`),
});
export type EmailDesignInput = z.infer<typeof emailDesignInputSchema>;

/** Saving: the version the editor started from, so two people editing at
 *  once cannot silently overwrite each other. */
export const emailDesignUpdateSchema = emailDesignInputSchema.extend({
  baseVersion: z.number().int().positive(),
});

// --- rendering --------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Fills merge fields; a missing value becomes empty text. */
export function merge(text: string, values: MergeValues): string {
  return text.replace(FIELD, (_m, name: string) => values[name as MergeField] ?? '');
}

export interface RenderOptions {
  /** In the in-app preview, pictures from other sites are shown as a labelled
   *  box (the app does not load images from elsewhere). */
  imagePlaceholders?: boolean;
}

export interface RenderedEmail { subject: string; html: string; text: string }

const FONT = "font-family:Arial,Helvetica,sans-serif;";

export function renderEmail(design: { subject: string; blocks: EmailBlock[] }, values: MergeValues, opts: RenderOptions = {}): RenderedEmail {
  const html: string[] = [];
  const text: string[] = [];
  for (const b of design.blocks) {
    switch (b.type) {
      case 'heading': {
        const t = merge(b.text, values);
        html.push(`<h1 style="${FONT}font-size:24px;line-height:1.3;color:#0f172a;margin:0 0 16px">${escapeHtml(t)}</h1>`);
        text.push(t.toUpperCase());
        break;
      }
      case 'text': {
        const t = merge(b.text, values);
        const paras = t.split(/\n{2,}/).map((p) => `<p style="${FONT}font-size:16px;line-height:1.5;color:#1e293b;margin:0 0 16px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
        html.push(paras.join(''));
        text.push(t);
        break;
      }
      case 'button': {
        const label = merge(b.label, values);
        html.push(`<p style="margin:8px 0 24px"><a href="${escapeHtml(b.url)}" style="${FONT}display:inline-block;background:#C80023;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;padding:12px 20px;border-radius:6px">${escapeHtml(label)}</a></p>`);
        text.push(`${label}: ${b.url}`);
        break;
      }
      case 'image':
        html.push(opts.imagePlaceholders
          ? `<div role="img" aria-label="${escapeHtml(b.alt)}" style="${FONT}border:2px dashed #64748b;border-radius:6px;padding:24px;margin:0 0 16px;color:#334155;font-size:14px;text-align:center">Picture: ${escapeHtml(b.alt)}</div>`
          : `<img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.alt)}" width="560" style="display:block;max-width:100%;height:auto;border:0;margin:0 0 16px">`);
        text.push(`[${b.alt}]`);
        break;
      case 'divider':
        html.push('<hr style="border:0;border-top:1px solid #cbd5e1;margin:24px 0">');
        text.push('---');
        break;
    }
  }
  const subject = merge(design.subject, values).replace(/[\r\n]+/g, ' ').trim();
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:#f1f5f9"><div style="max-width:600px;margin:0 auto;padding:24px 16px;background:#ffffff">${html.join('')}</div></body></html>`;
  return { subject, html: body, text: text.join('\n\n') + '\n' };
}

/** "Thursday, October 1": how {{today}} reads, in Montreal time. */
export function mergeDate(now: Date): string {
  return now.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Toronto' });
}

/** Values used for a test send or preview: the signed-in person's own. */
export function sampleMergeValues(person: { fullName: string }, organizationName: string, today: string): MergeValues {
  return { firstName: person.fullName.split(/\s+/)[0] ?? person.fullName, fullName: person.fullName, organizationName, today };
}

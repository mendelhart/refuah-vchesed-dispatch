import { and, asc, eq } from 'drizzle-orm';
import type { TemplateChannel, TemplateKey, TemplateLocale } from '@rvc/shared';
import { TEMPLATE_KEYS } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { messageTemplates, messageTemplateVersions } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { DEFAULT_TEMPLATES } from './template-defaults.js';

/**
 * Every word the system says to a human being.
 *
 * In the legacy application message text was inlined at eleven call sites, so
 * changing "Reply YES to accept" meant a developer, a deploy, and finding all
 * eleven. Here a template is a row: administrators edit it, the database keeps
 * the version history (trigger in migration 0004), and the code refers to it by
 * a key that must exist in TEMPLATE_KEYS.
 *
 * Rendering is deliberately not a template language. `{{variable}}` substitution
 * and nothing else — no conditionals, no loops, no expression evaluation. An
 * administrator editing an SMS should not be able to write something that
 * throws inside a background job at 2am, and a template language is a code
 * execution surface pointed at the notification path.
 */

export interface RenderedMessage {
  subject: string | null;
  body: string;
  /** False when the built-in default was used because no row exists. */
  fromDatabase: boolean;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Substitutes `{{name}}`, and drops lines that a missing value emptied out.
 *
 * The second half matters more than it sounds. A template line reading
 * `Needs: {{needs}}` on a trip with no mobility requirements would otherwise go
 * out as a bare "Needs:" — on every routine offer, to every volunteer, forever.
 * So a line whose placeholders all resolved to nothing, and whose remaining
 * literal text is only a label, is removed entirely. A line with real content
 * beside the empty placeholder is kept, because dropping it would lose text the
 * author wrote.
 */
export function interpolate(template: string, vars: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const line of template.split('\n')) {
    let placeholders = 0;
    let filled = 0;

    const rendered = line.replace(PLACEHOLDER, (_m, name: string) => {
      placeholders++;
      const value = vars[name];
      if (value === undefined || value === null || String(value) === '') return '';
      filled++;
      return String(value);
    });

    // Every placeholder on this line came back empty...
    if (placeholders > 0 && filled === 0) {
      // ...and what is left is a label, a bullet, or nothing at all.
      const residue = rendered.replace(/[\s:•\-–—*|,]/g, '');
      if (residue === '' || /^[A-Za-z ]{0,24}$/.test(rendered.replace(/[:•\-–—*|]/g, '').trim())) {
        continue;
      }
    }
    lines.push(rendered.replace(/[ \t]+$/, ''));
  }

  // Collapse runs of blank lines left behind, but keep single paragraph breaks.
  return lines
    .filter((line, i) => line.trim() !== '' || (lines[i - 1]?.trim() ?? '') !== '')
    .join('\n')
    .trim();
}

export async function renderTemplate(
  key: TemplateKey,
  channel: TemplateChannel,
  vars: Record<string, unknown>,
  exec: Executor = db,
  locale: TemplateLocale = 'en',
): Promise<RenderedMessage> {
  const [row] = await exec
    .select({ subject: messageTemplates.subject, body: messageTemplates.body })
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.key, key),
        eq(messageTemplates.channel, channel),
        eq(messageTemplates.locale, locale),
        eq(messageTemplates.active, true),
      ),
    )
    .limit(1);

  if (row) {
    return {
      subject: row.subject ? interpolate(row.subject, vars) : null,
      body: interpolate(row.body, vars),
      fromDatabase: true,
    };
  }

  // Falling back to the compiled-in default is correct behaviour, not an
  // error: a message must still go out if somebody deactivated its row. It is
  // logged so the gap is visible.
  const fallback = DEFAULT_TEMPLATES.find(
    (t) => t.key === key && t.channel === channel && t.locale === locale,
  );
  if (!fallback) {
    // English is the source locale; a missing translation falls back to it
    // rather than sending nothing.
    const english = DEFAULT_TEMPLATES.find((t) => t.key === key && t.channel === channel);
    if (!english) {
      throw new Error(`No template defined for ${key}/${channel}`);
    }
    logger.warn({ key, channel, locale }, 'template missing for locale; using English default');
    return {
      subject: english.subject ? interpolate(english.subject, vars) : null,
      body: interpolate(english.body, vars),
      fromDatabase: false,
    };
  }

  logger.warn({ key, channel, locale }, 'template row absent; using built-in default');
  return {
    subject: fallback.subject ? interpolate(fallback.subject, vars) : null,
    body: interpolate(fallback.body, vars),
    fromDatabase: false,
  };
}

export async function listTemplates(exec: Executor = db) {
  return exec
    .select()
    .from(messageTemplates)
    .orderBy(asc(messageTemplates.key), asc(messageTemplates.channel), asc(messageTemplates.locale));
}

export async function getTemplate(id: string, exec: Executor = db) {
  const [row] = await exec.select().from(messageTemplates).where(eq(messageTemplates.id, id)).limit(1);
  if (!row) throw Errors.notFound('That template no longer exists.');
  const versions = await exec
    .select()
    .from(messageTemplateVersions)
    .where(eq(messageTemplateVersions.templateId, id))
    .orderBy(asc(messageTemplateVersions.version));
  return { ...row, versions };
}

/**
 * Edits a template.
 *
 * The version bump and history row are written by a database trigger, so an
 * edit made through any route — or through psql — is recorded. What the service
 * adds is validation: a variable the template references but the call site
 * never supplies renders as an empty string forever, so unknown variables are
 * refused at edit time rather than discovered in a message that went out wrong.
 */
export async function updateTemplate(
  actor: AuditActor,
  id: string,
  patch: { subject?: string | null; body?: string; active?: boolean },
) {
  const [before] = await db.select().from(messageTemplates).where(eq(messageTemplates.id, id)).limit(1);
  if (!before) throw Errors.notFound('That template no longer exists.');

  if (patch.body !== undefined) {
    if (!patch.body.trim()) throw Errors.validation('A template needs a body.');
    const used = [...patch.body.matchAll(PLACEHOLDER)].map((m) => m[1]!);
    const unknown = [...new Set(used)].filter((v) => !before.variables.includes(v));
    if (unknown.length) {
      throw Errors.validation(
        `This template has no value for: ${unknown.join(', ')}. Available: ${before.variables.join(', ')}`,
        { unknown, available: before.variables },
      );
    }
    if (before.channel === 'sms' && patch.body.length > 1200) {
      throw Errors.validation(
        'That is longer than eight SMS segments. Shorten it, or the message will cost more than the ride.',
      );
    }
  }

  const [after] = await db
    .update(messageTemplates)
    .set({
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedById: actor.userId,
    })
    .where(eq(messageTemplates.id, id))
    .returning();

  await recordAudit({
    actor,
    action: 'template.updated',
    entityType: 'message_template',
    entityId: id,
    previous: { subject: before.subject, body: before.body, active: before.active, version: before.version },
    next: { subject: after!.subject, body: after!.body, active: after!.active, version: after!.version },
    metadata: { key: before.key, channel: before.channel, locale: before.locale },
  });

  return after!;
}

/** Restores a previous version by writing it forward — history is never edited. */
export async function revertTemplate(actor: AuditActor, id: string, version: number) {
  const [old] = await db
    .select()
    .from(messageTemplateVersions)
    .where(
      and(eq(messageTemplateVersions.templateId, id), eq(messageTemplateVersions.version, version)),
    )
    .limit(1);
  if (!old) throw Errors.notFound(`Version ${version} is not on file for this template.`);
  return updateTemplate(actor, id, { subject: old.subject, body: old.body });
}

/**
 * Installs the built-in templates. Idempotent and non-destructive: a row an
 * administrator has edited is left exactly as they left it.
 */
export async function seedTemplates(exec: Executor = db): Promise<number> {
  let created = 0;
  for (const t of DEFAULT_TEMPLATES) {
    const [existing] = await exec
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.key, t.key),
          eq(messageTemplates.channel, t.channel),
          eq(messageTemplates.locale, t.locale),
        ),
      )
      .limit(1);
    if (existing) continue;
    await exec.insert(messageTemplates).values({
      key: t.key,
      channel: t.channel,
      locale: t.locale,
      subject: t.subject ?? null,
      body: t.body,
      description: t.description,
      variables: t.variables,
    });
    created++;
  }
  return created;
}

/** Guards against a key being referenced in code but never defined. */
export function assertTemplateCatalogueComplete(): void {
  const missing = TEMPLATE_KEYS.filter((k) => !DEFAULT_TEMPLATES.some((t) => t.key === k));
  if (missing.length) {
    throw new Error(`TEMPLATE_KEYS without a default template: ${missing.join(', ')}`);
  }
}

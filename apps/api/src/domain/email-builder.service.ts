import { sql as raw } from 'drizzle-orm';
import { mergeDate, renderEmail, sampleMergeValues, type EmailBlock, type EmailDesignInput } from '@rvc/shared';
import { db } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { memoryEmailProvider } from '../services/providers/inmemory.js';

/**
 * Email builder (item 9). Designs and their saved versions. Nothing here
 * sends to anyone but the person signed in, and that test send always goes
 * through the fake (in-memory) email provider, whatever SMTP is configured:
 * real sending is a later, separate decision.
 */

type DesignRow = {
  id: string; name: string; subject: string; blocks: EmailBlock[]; version: number;
  updated_at: string; updated_by: string | null; archived_at: string | null;
};

const toDesign = (r: DesignRow) => ({
  id: r.id, name: r.name, subject: r.subject, blocks: r.blocks, version: Number(r.version),
  updatedAt: r.updated_at, updatedBy: r.updated_by, archived: r.archived_at !== null,
});

export async function listDesigns(includeArchived: boolean) {
  const rows = await db.execute<DesignRow>(raw`
    select d.id, d.name, d.subject, d.blocks, d.version, d.updated_at, u.full_name as updated_by, d.archived_at
      from email_designs d left join users u on u.id = d.updated_by_id
     where ${includeArchived} or d.archived_at is null
     order by d.archived_at nulls first, d.updated_at desc`);
  return rows.map(toDesign);
}

export async function getDesign(id: string) {
  const [row] = await db.execute<DesignRow>(raw`
    select d.id, d.name, d.subject, d.blocks, d.version, d.updated_at, u.full_name as updated_by, d.archived_at
      from email_designs d left join users u on u.id = d.updated_by_id where d.id = ${id}`);
  if (!row) throw Errors.notFound('Email design');
  const versions = await db.execute<{ version: number; name: string; subject: string; blocks: EmailBlock[]; saved_at: string; saved_by: string | null }>(raw`
    select v.version, v.name, v.subject, v.blocks, v.saved_at, u.full_name as saved_by
      from email_design_versions v left join users u on u.id = v.saved_by_id
     where v.design_id = ${id} order by v.version desc limit 50`);
  return {
    design: toDesign(row),
    versions: versions.map((v) => ({ version: Number(v.version), name: v.name, subject: v.subject, blocks: v.blocks, savedAt: v.saved_at, savedBy: v.saved_by })),
  };
}

export async function createDesign(input: EmailDesignInput, userId: string) {
  return db.transaction(async (tx) => {
    const [d] = await tx.execute<{ id: string }>(raw`
      insert into email_designs (name, subject, blocks, version, created_by_id, updated_by_id)
      values (${input.name}, ${input.subject}, ${JSON.stringify(input.blocks)}::jsonb, 1, ${userId}, ${userId}) returning id`);
    await tx.execute(raw`
      insert into email_design_versions (design_id, version, name, subject, blocks, saved_by_id)
      values (${d!.id}, 1, ${input.name}, ${input.subject}, ${JSON.stringify(input.blocks)}::jsonb, ${userId})`);
    return d!.id;
  });
}

/** Saves a new version. Refused (409) when someone else saved since the
 *  editor opened, so nobody overwrites another person's work unseen. */
export async function saveDesign(id: string, input: EmailDesignInput & { baseVersion: number }, userId: string) {
  return db.transaction(async (tx) => {
    const [cur] = await tx.execute<{ version: number; archived_at: string | null }>(raw`
      select version, archived_at from email_designs where id = ${id} for update`);
    if (!cur) throw Errors.notFound('Email design');
    if (cur.archived_at) throw Errors.conflict('This design is archived. Bring it back before changing it.');
    if (Number(cur.version) !== input.baseVersion) {
      throw Errors.conflict('Someone saved this design after you opened it. Reload to see their changes.');
    }
    const next = Number(cur.version) + 1;
    await tx.execute(raw`
      update email_designs set name = ${input.name}, subject = ${input.subject}, blocks = ${JSON.stringify(input.blocks)}::jsonb,
             version = ${next}, updated_by_id = ${userId}, updated_at = now() where id = ${id}`);
    await tx.execute(raw`
      insert into email_design_versions (design_id, version, name, subject, blocks, saved_by_id)
      values (${id}, ${next}, ${input.name}, ${input.subject}, ${JSON.stringify(input.blocks)}::jsonb, ${userId})`);
    return next;
  });
}

/** Brings back an earlier version by saving it again as the newest. */
export async function restoreVersion(id: string, version: number, userId: string) {
  const [old] = await db.execute<{ name: string; subject: string; blocks: EmailBlock[] }>(raw`
    select name, subject, blocks from email_design_versions where design_id = ${id} and version = ${version}`);
  if (!old) throw Errors.notFound('That version');
  const [cur] = await db.execute<{ version: number }>(raw`select version from email_designs where id = ${id}`);
  if (!cur) throw Errors.notFound('Email design');
  return saveDesign(id, { name: old.name, subject: old.subject, blocks: old.blocks, baseVersion: Number(cur.version) }, userId);
}

export async function setArchived(id: string, archived: boolean) {
  const res = await db.execute<{ id: string }>(raw`
    update email_designs set archived_at = ${archived ? raw`now()` : raw`null`}, updated_at = now() where id = ${id} returning id`);
  if (!res.length) throw Errors.notFound('Email design');
}

async function organizationName(): Promise<string> {
  const [row] = await db.execute<{ name: string }>(raw`select name from organization_info order by updated_at desc limit 1`);
  return row?.name ?? "Refuah V'Chesed";
}

/** Renders the saved design for the signed-in person and "sends" it to
 *  their own address through the fake provider. */
export async function testSend(id: string, me: { id: string }) {
  const [person] = await db.execute<{ email: string | null; full_name: string }>(raw`
    select email, full_name from users where id = ${me.id}`);
  if (!person?.email) throw Errors.validation('Your account has no email address, so there is nowhere to send a test.');
  const { design } = await getDesign(id);
  const values = sampleMergeValues({ fullName: person.full_name }, await organizationName(), mergeDate(new Date()));
  const rendered = renderEmail(design, values);
  const sent = await memoryEmailProvider.send({ to: person.email, subject: `[TEST] ${rendered.subject}`, text: rendered.text, html: rendered.html });
  return { sentTo: person.email, provider: sent.provider, fake: true as const, subject: rendered.subject };
}

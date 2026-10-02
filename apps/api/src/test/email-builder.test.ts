import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { emailDesignInputSchema, renderEmail, unknownMergeFields, type EmailBlock } from '@rvc/shared';
import { api, createTestUser, getApp, resetDb, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { capturedExtra } from '../services/providers/inmemory.js';

/** Item 9: email builder. */
const call = (method: 'GET' | 'POST' | 'PUT', path: string, who: TestUser, payload?: unknown) =>
  api(method, path, { cookie: who.cookie, ...(payload !== undefined ? { payload } : {}) });

const blocks: EmailBlock[] = [
  { type: 'heading', text: 'Hello {{firstName}}' },
  { type: 'text', text: 'Thank you for driving.\n\nSee you soon <3' },
  { type: 'button', label: 'Open the app', url: 'https://example.org/app?a=1&b=2' },
  { type: 'image', url: 'https://example.org/pic.png', alt: 'Volunteers at the kitchen' },
  { type: 'divider' },
];

describe('email builder: rendering', () => {
  it('fills merge fields and escapes every piece of text', () => {
    const r = renderEmail({ subject: 'For {{fullName}}', blocks }, { firstName: '<b>Sara</b>', fullName: 'Sara Klein' });
    expect(r.subject).toBe('For Sara Klein');
    expect(r.html).toContain('Hello &lt;b&gt;Sara&lt;/b&gt;');
    expect(r.html).not.toContain('<b>Sara');
    expect(r.html).toContain('See you soon &lt;3');
    expect(r.html).toContain('href="https://example.org/app?a=1&amp;b=2"');
    expect(r.html).toContain('alt="Volunteers at the kitchen"');
    expect(r.text).toContain('Open the app: https://example.org/app?a=1&b=2');
  });

  it('shows pictures as a labelled box in the preview', () => {
    const r = renderEmail({ subject: 's', blocks }, {}, { imagePlaceholders: true });
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('Picture: Volunteers at the kitchen');
  });

  it('refuses unknown merge fields, unsafe links and pictures without a description', () => {
    expect(unknownMergeFields('Hi {{firstName}} {{password}}')).toEqual(['password']);
    const bad = (b: unknown) => emailDesignInputSchema.safeParse({ name: 'x', subject: 's', blocks: [b] }).success;
    expect(bad({ type: 'text', text: 'Hi {{password}}' })).toBe(false);
    expect(bad({ type: 'button', label: 'Go', url: 'javascript:alert(1)' })).toBe(false);
    expect(bad({ type: 'button', label: 'Go', url: 'http://example.org' })).toBe(false);
    expect(bad({ type: 'button', label: 'Call', url: 'tel:+15145550100' })).toBe(true);
    expect(bad({ type: 'image', url: 'https://example.org/a.png', alt: '' })).toBe(false);
    expect(bad({ type: 'image', url: 'https://example.org/a.png" onerror="x', alt: 'a' })).toBe(false);
  });
});

describe('email builder: API', () => {
  let coord: TestUser;
  let other: TestUser;
  let vol: TestUser;
  const original = env.EMAIL_BUILDER_ENABLED;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    capturedExtra.reset();
    env.EMAIL_BUILDER_ENABLED = true;
    coord = await createTestUser({ role: 'dispatcher', groups: [] });
    other = await createTestUser({ role: 'admin', groups: [] });
    vol = await createTestUser({ role: 'volunteer' });
  });
  afterEach(() => { env.EMAIL_BUILDER_ENABLED = original; });

  const create = async () => {
    const res = await call('POST', '/api/email-designs', coord, { name: 'Thank you', subject: 'Thanks {{firstName}}', blocks });
    expect(res.status).toBe(201);
    return (res.body.design as { id: string }).id;
  };

  it('is off by default and 404 while off; volunteers are refused', async () => {
    expect(original).toBe(false);
    expect((await call('GET', '/api/email-designs', vol)).status).toBe(403);
    env.EMAIL_BUILDER_ENABLED = false;
    expect((await call('GET', '/api/email-designs', coord)).status).toBe(404);
  });

  it('every save is a version; a stale save is refused; an old version can be brought back', async () => {
    const id = await create();
    const v2 = await call('PUT', `/api/email-designs/${id}`, coord, { name: 'Thank you', subject: 'Thank you, {{firstName}}', blocks: blocks.slice(0, 2), baseVersion: 1 });
    expect(v2.status).toBe(200);
    expect((v2.body.design as { version: number }).version).toBe(2);
    // Someone else still has version 1 open.
    const stale = await call('PUT', `/api/email-designs/${id}`, other, { name: 'Mine', subject: 'x', blocks: [], baseVersion: 1 });
    expect(stale.status).toBe(409);
    const restored = await call('POST', `/api/email-designs/${id}/restore`, other, { version: 1 });
    expect(restored.body.design).toMatchObject({ version: 3, subject: 'Thanks {{firstName}}' });
    expect((restored.body.design as { blocks: unknown[] }).blocks.length).toBe(5);
    expect((restored.body.versions as unknown[]).length).toBe(3);
    const audit = await db.execute(raw`select action from audit_events where entity_id = ${id} order by occurred_at`);
    expect(audit.map((a) => a.action)).toEqual(['email_design.created', 'email_design.saved', 'email_design.restored']);
  });

  it('a test goes only to the signed-in person, through the fake provider, marked TEST', async () => {
    const id = await create();
    const res = await call('POST', `/api/email-designs/${id}/test-send`, coord, { to: 'someone-else@example.org' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sentTo: coord.email, provider: 'memory', fake: true });
    expect(capturedExtra.email.length).toBe(1);
    expect(capturedExtra.email[0]).toMatchObject({ to: coord.email });
    expect(capturedExtra.email[0]!.subject).toMatch(/^\[TEST\] Thanks /);
    expect(capturedExtra.email.some((e) => e.to === 'someone-else@example.org')).toBe(false);
  });

  it('no email address means no test send', async () => {
    const id = await create();
    await db.execute(raw`update users set email = null where id = ${coord.id}`);
    expect((await call('POST', `/api/email-designs/${id}/test-send`, coord)).status).toBe(422);
    expect(capturedExtra.email.length).toBe(0);
  });

  it('archived designs leave the list and cannot be changed until brought back', async () => {
    const id = await create();
    await call('POST', `/api/email-designs/${id}/archive`, coord, { archived: true });
    expect(((await call('GET', '/api/email-designs', coord)).body.designs as unknown[]).length).toBe(0);
    expect(((await call('GET', '/api/email-designs?archived=true', coord)).body.designs as unknown[]).length).toBe(1);
    expect((await call('PUT', `/api/email-designs/${id}`, coord, { name: 'x', subject: 'y', blocks: [], baseVersion: 1 })).status).toBe(409);
    await call('POST', `/api/email-designs/${id}/archive`, coord, { archived: false });
    expect((await call('PUT', `/api/email-designs/${id}`, coord, { name: 'x', subject: 'y', blocks: [], baseVersion: 1 })).status).toBe(200);
  });

  it('bad blocks are refused with a plain message', async () => {
    const res = await call('POST', '/api/email-designs', coord, { name: 'x', subject: 'Hi {{secret}}', blocks: [] });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/Unknown merge field: secret/);
  });
});

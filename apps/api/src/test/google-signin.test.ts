import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, PASSWORD, resetDb, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { setGoogleKeySource, verifyGoogleIdToken } from '../auth/google.js';

/**
 * Item 9: Google sign-in. Google is never called: tokens are signed here with
 * a key made for the test, and the verifier is pointed at that key.
 */
const CLIENT_ID = '1234567890-test.apps.googleusercontent.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function idToken(claims: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid: opts.kid ?? 'test-key', typ: 'JWT' });
  const body = enc({ iss: 'https://accounts.google.com', aud: CLIENT_ID, iat: now, exp: now + 600, sub: '1100', email_verified: true, ...claims });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}

describe('Google ID token checks', () => {
  beforeAll(() => setGoogleKeySource(async () => [jwk]));
  afterAll(() => setGoogleKeySource(null));
  const check = (t: string) => verifyGoogleIdToken(t, { clientId: CLIENT_ID, nonce: 'n1' });

  it('accepts a good token and lower-cases the address', async () => {
    await expect(check(idToken({ email: 'Sara@Example.org', nonce: 'n1' }))).resolves.toMatchObject({ email: 'sara@example.org', sub: '1100' });
  });

  it.each([
    ['another app', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['wrong one-time value', { nonce: 'other' }],
    ['address not verified by Google', { email_verified: false }],
  ])('refuses a token for %s', async (_why, claims) => {
    await expect(check(idToken({ email: 'a@example.org', nonce: 'n1', ...claims }))).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refuses a token not signed by Google, or tampered with', async () => {
    await expect(check(idToken({ email: 'a@example.org', nonce: 'n1' }, { key: other.privateKey }))).rejects.toMatchObject({ statusCode: 401 });
    await expect(check(idToken({ email: 'a@example.org', nonce: 'n1' }, { kid: 'unknown' }))).rejects.toMatchObject({ statusCode: 401 });
    const [h, , s] = idToken({ email: 'a@example.org', nonce: 'n1' }).split('.');
    const forged = Buffer.from(JSON.stringify({ iss: 'accounts.google.com', aud: CLIENT_ID, exp: 9e9, sub: '1', email: 'admin@x', email_verified: true, nonce: 'n1' })).toString('base64url');
    await expect(check(`${h}.${forged}.${s}`)).rejects.toMatchObject({ statusCode: 401 });
    await expect(check('not-a-token')).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('Google sign-in', () => {
  let admin: TestUser;
  let coord: TestUser;
  const saved = { on: env.GOOGLE_SIGNIN_ENABLED, id: env.GOOGLE_CLIENT_ID };

  beforeAll(async () => { await getApp(); setGoogleKeySource(async () => [jwk]); });
  afterAll(async () => { setGoogleKeySource(null); await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    env.GOOGLE_SIGNIN_ENABLED = true;
    env.GOOGLE_CLIENT_ID = CLIENT_ID;
    admin = await createTestUser({ role: 'admin', groups: [] });
    coord = await createTestUser({ role: 'dispatcher', groups: [] });
  });
  afterEach(() => { env.GOOGLE_SIGNIN_ENABLED = saved.on; env.GOOGLE_CLIENT_ID = saved.id; });

  /** start -> Google -> back: returns the response of the final step. */
  async function signIn(email: string, tweak: (nonce: string) => Record<string, unknown> = (n) => ({ nonce: n })) {
    const start = await api('POST', '/api/auth/google/start', { payload: {} });
    expect(start.status).toBe(200);
    const nonce = start.body.nonce as string;
    const setCookie = String(start.raw.headers['set-cookie']);
    const cookie = /rvc_google_nonce=([^;]+)/.exec(setCookie)![0];
    return api('POST', '/api/auth/google', { cookie, payload: { credential: idToken({ email, ...tweak(nonce) }) } });
  }

  it('is off by default, off without a client ID, and the sign-in page is told so', async () => {
    expect(saved.on).toBe(false);
    env.GOOGLE_CLIENT_ID = undefined;
    expect((await api('GET', '/api/public/google-signin')).body).toEqual({ enabled: false });
    expect((await api('POST', '/api/auth/google/start', { payload: {} })).status).toBe(404);
    env.GOOGLE_CLIENT_ID = CLIENT_ID;
    expect((await api('GET', '/api/public/google-signin')).body).toEqual({ enabled: true, clientId: CLIENT_ID });
  });

  it('nobody can sign in with Google until an administrator approves them', async () => {
    const res = await signIn(coord.email);
    expect(res.status).toBe(401);
    expect(res.raw.headers['set-cookie'] ?? '').not.toMatch(new RegExp(`${env.SESSION_COOKIE_NAME}=`));
  });

  it('an approved person signs in to their own account; password sign-in still works', async () => {
    expect((await api('POST', '/api/admin/google-signin', { cookie: admin.cookie, payload: { userId: coord.id } })).status).toBe(201);
    const res = await signIn(coord.email.toUpperCase());
    expect(res.status).toBe(200);
    expect((res.body.user as { id: string }).id).toBe(coord.id);
    const session = new RegExp(`${env.SESSION_COOKIE_NAME}=([^;]+)`).exec(String(res.raw.headers['set-cookie']))![0];
    const me = await api('GET', '/api/auth/me', { cookie: session });
    expect((me.body.user as { id: string }).id).toBe(coord.id);
    const pw = await api('POST', '/api/auth/login', { payload: { email: coord.email, password: PASSWORD } });
    expect(pw.status).toBe(200);
    const audit = await db.execute<{ metadata: { method?: string } }>(raw`select metadata from audit_events where action = 'auth.login' and entity_id = ${coord.id}`);
    expect(audit.some((a) => a.metadata?.method === 'google')).toBe(true);
  });

  it('each one-time value works once, and only with its own cookie', async () => {
    await api('POST', '/api/admin/google-signin', { cookie: admin.cookie, payload: { userId: coord.id } });
    const start = await api('POST', '/api/auth/google/start', { payload: {} });
    const nonce = start.body.nonce as string;
    const cookie = /rvc_google_nonce=([^;]+)/.exec(String(start.raw.headers['set-cookie']))![0];
    const token = idToken({ email: coord.email, nonce });
    expect((await api('POST', '/api/auth/google', { payload: { credential: token } })).status).toBe(401); // no cookie
    expect((await api('POST', '/api/auth/google', { cookie, payload: { credential: token } })).status).toBe(200);
    expect((await api('POST', '/api/auth/google', { cookie, payload: { credential: token } })).status).toBe(401); // replay
  });

  it('a revoked approval, a changed account address or a paused account stops it', async () => {
    const add = await api('POST', '/api/admin/google-signin', { cookie: admin.cookie, payload: { userId: coord.id } });
    await db.execute(raw`update users set email = 'new-address@test.local' where id = ${coord.id}`);
    expect((await signIn(coord.email)).status).toBe(401);
    await db.execute(raw`update users set email = ${coord.email} where id = ${coord.id}`);
    await db.execute(raw`update users set status = 'inactive' where id = ${coord.id}`);
    expect((await signIn(coord.email)).status).toBe(403);
    await db.execute(raw`update users set status = 'active' where id = ${coord.id}`);
    expect((await signIn(coord.email)).status).toBe(200);
    await api('POST', `/api/admin/google-signin/${add.body.id as string}/revoke`, { cookie: admin.cookie, payload: {} });
    expect((await signIn(coord.email)).status).toBe(401);
  });

  it('admins still go through the app’s own two-step check when it is required', async () => {
    await api('POST', '/api/admin/google-signin', { cookie: admin.cookie, payload: { userId: admin.id } });
    const res = await signIn(admin.email);
    expect(res.status).toBe(200);
    const mfaOn = (res.body.user as { mfa?: string }).mfa;
    const [s] = await db.execute<{ mfa_pending: boolean }>(raw`select mfa_pending from sessions where user_id = ${admin.id} order by created_at desc limit 1`);
    expect(Boolean(mfaOn)).toBe(s!.mfa_pending);
  });

  it('only administrators approve; the same person or address cannot be approved twice', async () => {
    expect((await api('POST', '/api/admin/google-signin', { cookie: coord.cookie, payload: { userId: coord.id } })).status).toBe(403);
    expect((await api('POST', '/api/admin/google-signin', { cookie: admin.cookie, payload: { userId: coord.id } })).status).toBe(201);
    expect((await api('POST', '/api/admin/google-signin', { cookie: admin.cookie, payload: { userId: coord.id } })).status).toBe(409);
    const list = await api('GET', '/api/admin/google-signin', { cookie: admin.cookie });
    expect(list.body.approvals).toEqual([expect.objectContaining({ userId: coord.id, email: coord.email, stillMatches: true })]);
    expect((list.body.people as Array<{ id: string }>).some((p) => p.id === coord.id)).toBe(false);
  });
});

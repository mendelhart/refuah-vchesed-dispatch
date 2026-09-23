import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { api, createTestUser, getApp, PASSWORD, resetDb, shutdown, type TestUser } from './harness.js';
import { hashPassword, verifyPassword, generateToken, hashToken } from '../lib/crypto.js';
import { normalizeOfferCode, generateOfferCode } from '../lib/offer-code.js';
import { normalizePhone } from '../lib/phone.js';

describe('authentication', () => {
  let user: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    user = await createTestUser({ role: 'volunteer', login: false });
  });

  it('signs in with the right password and sets an httpOnly cookie', async () => {
    const res = await api('POST', '/api/auth/login', { payload: { email: user.email, password: PASSWORD } });
    expect(res.status).toBe(200);
    const cookie = String(res.raw.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // The raw token is never stored; only its hash.
    const stored = await db.select().from(sessions);
    expect(stored).toHaveLength(1);
    expect(cookie).not.toContain(stored[0]!.tokenHash);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    const wrong = await api('POST', '/api/auth/login', { payload: { email: user.email, password: 'nope-nope-nope' } });
    const missing = await api('POST', '/api/auth/login', { payload: { email: 'nobody@nowhere.test', password: 'nope-nope-nope' } });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    // Account enumeration matters for a volunteer roster.
    expect(JSON.stringify(wrong.body)).toBe(JSON.stringify(missing.body).replace(/"requestId":"[^"]+"/, JSON.stringify(wrong.body).match(/"requestId":"[^"]+"/)?.[0]?.replace(/^"requestId":/, '"requestId":') ?? ''));
  });

  it('locks an account after repeated failures, even from rotating addresses', async () => {
    // Each attempt comes from a different IP, so this proves the *account*
    // lockout works independently of the per-IP rate limit.
    for (let i = 0; i < 9; i += 1) {
      await api('POST', '/api/auth/login', {
        payload: { email: user.email, password: `wrong-${i}-aaaa` },
        headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
      });
    }
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.failedLoginCount).toBeGreaterThanOrEqual(8);
    expect(row!.lockedUntil).not.toBeNull();
  });

  it('rate-limits the login endpoint', async () => {
    const results = [];
    for (let i = 0; i < 14; i += 1) {
      results.push(await api('POST', '/api/auth/login', {
        payload: { email: `x${i}@y.test`, password: 'whatever-123' },
        headers: { 'x-forwarded-for': '198.51.100.7' },
      }));
    }
    expect(results.some((r) => r.status === 429)).toBe(true);
    // A throttled caller must get 429 with a usable message, not a 500.
    const throttled = results.find((r) => r.status === 429)!;
    expect((throttled.body.error as { code: string }).code).toBe('rate_limited');
  });

  it('refuses a paused account, and says so only to the right password', async () => {
    await db.update(users).set({ status: 'inactive' }).where(eq(users.id, user.id));
    const res = await api('POST', '/api/auth/login', {
      payload: { email: user.email, password: PASSWORD },
      headers: { 'x-forwarded-for': '198.51.100.21' },
    });
    // Right password on a paused account: refused, with a plain explanation.
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('paused');
    // Wrong password on a paused account still looks like any wrong password.
    const wrong = await api('POST', '/api/auth/login', {
      payload: { email: user.email, password: 'not-the-password-1' },
      headers: { 'x-forwarded-for': '198.51.100.22' },
    });
    expect(wrong.status).toBe(401);
  });

  it('refuses an expired session', async () => {
    const cookie = (await createTestUser({ role: 'volunteer' })).cookie;
    expect((await api('GET', '/api/auth/me', { cookie })).status).toBe(200);
    await db.execute(sql`update sessions set expires_at = now() - interval '1 hour'`);
    expect((await api('GET', '/api/auth/me', { cookie })).status).toBe(401);
  });

  it('revokes every other session when the password changes', async () => {
    const a = await createTestUser({ role: 'volunteer' });
    const second = await api('POST', '/api/auth/login', { payload: { email: a.email, password: PASSWORD } });
    const secondCookie = String(second.raw.headers['set-cookie']).split(';')[0]!;

    const changed = await api('POST', '/api/auth/change-password', {
      cookie: a.cookie, payload: { currentPassword: PASSWORD, newPassword: 'BrandNewPassword123!' },
    });
    expect(changed.status).toBe(200);
    expect((await api('GET', '/api/auth/me', { cookie: secondCookie })).status).toBe(401);
  });

  it('logs out by revoking the session, not just clearing the cookie', async () => {
    const a = await createTestUser({ role: 'volunteer' });
    await api('POST', '/api/auth/logout', { cookie: a.cookie });
    expect((await api('GET', '/api/auth/me', { cookie: a.cookie })).status).toBe(401);
  });

  it('never reveals whether an address exists during password reset', async () => {
    const known = await api('POST', '/api/auth/request-password-reset', { payload: { email: user.email } });
    const unknown = await api('POST', '/api/auth/request-password-reset', { payload: { email: 'nobody@nowhere.test' } });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });
});

describe('cryptographic primitives', () => {
  it('hashes passwords with a salt, so identical passwords differ', async () => {
    const a = await hashPassword('the same password');
    const b = await hashPassword('the same password');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('the same password', a)).toBe(true);
    expect(await verifyPassword('the same password', b)).toBe(true);
    expect(await verifyPassword('a different password', a)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
  });

  it('stores only hashes of opaque tokens', () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toContain(token);
  });

  it('generates offer codes with real entropy and no ambiguous characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(generateOfferCode());
    // The legacy 4-digit call_id collided ~50% of the time after ~112 values.
    expect(seen.size).toBe(20_000);
    for (const code of seen) expect(code).not.toMatch(/[ILOU]/);
  });

  it('accepts an offer code the way a human types it', () => {
    const code = generateOfferCode();
    expect(normalizeOfferCode(code.toLowerCase())).toBe(code);
    expect(normalizeOfferCode(`${code.slice(0, 5)}-${code.slice(5)}`)).toBe(code);
    expect(normalizeOfferCode(' ' + code + ' ')).toBe(code);
    expect(normalizeOfferCode('TOO-SHORT')).toBeNull();
  });

  it('normalises phone numbers to E.164, or refuses them', () => {
    expect(normalizePhone('514-555-1234')).toBe('+15145551234');
    expect(normalizePhone('(514) 555 1234')).toBe('+15145551234');
    expect(normalizePhone('15145551234')).toBe('+15145551234');
    expect(normalizePhone('+15145551234')).toBe('+15145551234');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    // The legacy "last ten digits" match treated these as the same person.
    expect(normalizePhone('+445145551234')).not.toBe(normalizePhone('+15145551234'));
  });
});

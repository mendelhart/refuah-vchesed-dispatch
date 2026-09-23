import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../env.js';
import { api, createTestUser, getApp, login, resetDb, shutdown } from './harness.js';
import { currentStep, totpAt, verifyTotp, base32Encode, base32Decode } from '../lib/totp.js';

describe('two-step sign-in', () => {
  const mutableEnv = env as { MFA_REQUIRED?: string };
  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    mutableEnv.MFA_REQUIRED = 'true';
  });
  afterEach(() => { delete mutableEnv.MFA_REQUIRED; });

  it('matches the RFC 6238 test vector', () => {
    // RFC 6238 appendix B, SHA-1 secret "12345678901234567890", T = 59s -> 94287082 (last 6: 287082).
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpAt(secret, 1)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59_000)).toBe(1);
  });

  it('makes a coordinator set up an authenticator, then enter codes', async () => {
    const coordinator = await createTestUser({ role: 'dispatcher', login: false });
    const cookie = await login(coordinator.email);

    const blocked = await api('GET', '/api/volunteers/overview', { cookie });
    expect(blocked.status).toBe(403);
    expect((blocked.body.error as { code: string }).code).toBe('mfa_required');
    const me = await api('GET', '/api/auth/me', { cookie });
    expect((me.body.user as { mfa?: string }).mfa).toBe('setup');

    const setup = await api('POST', '/api/auth/mfa/setup', { cookie });
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    expect(setup.body.otpauthUrl as string).toMatch(/^otpauth:\/\/totp\//);

    const wrong = await api('POST', '/api/auth/mfa/enable', { cookie, payload: { code: '000000' } });
    expect(wrong.status).toBe(422);
    const enabled = await api('POST', '/api/auth/mfa/enable', { cookie, payload: { code: totpAt(secret, currentStep()) } });
    expect(enabled.status).toBe(200);
    const recovery = enabled.body.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);
    expect((await api('GET', '/api/volunteers/overview', { cookie })).status).toBe(200);

    // Next sign-in asks for a code. The code already used is refused (replay).
    const second = await login(coordinator.email);
    expect(((await api('GET', '/api/auth/me', { cookie: second })).body.user as { mfa?: string }).mfa).toBe('verify');
    const replay = await api('POST', '/api/auth/mfa/verify', { cookie: second, payload: { code: totpAt(secret, currentStep()) } });
    expect(replay.status).toBe(422);
    // A recovery code works once, typed without the dash.
    const viaRecovery = await api('POST', '/api/auth/mfa/verify', { cookie: second, payload: { code: recovery[0]!.replace('-', '') } });
    expect(viaRecovery.status).toBe(200);
    expect((await api('GET', '/api/volunteers/overview', { cookie: second })).status).toBe(200);

    const third = await login(coordinator.email);
    const reused = await api('POST', '/api/auth/mfa/verify', { cookie: third, payload: { code: recovery[0]! } });
    expect(reused.status).toBe(422);
  });

  it('leaves volunteers and existing sessions alone', async () => {
    const volunteer = await createTestUser({ role: 'volunteer', login: false });
    const cookie = await login(volunteer.email);
    expect(((await api('GET', '/api/auth/me', { cookie })).body.user as { mfa?: string }).mfa).toBeUndefined();
    // Sessions that existed before (minted directly, mfa_pending false) keep working.
    const admin = await createTestUser({ role: 'admin' });
    expect((await api('GET', '/api/volunteers/overview', { cookie: admin.cookie })).status).toBe(200);
  });

  it('lets an admin reset a lost authenticator', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const coordinator = await createTestUser({ role: 'dispatcher', login: false });
    const cookie = await login(coordinator.email);
    const setup = await api('POST', '/api/auth/mfa/setup', { cookie });
    await api('POST', '/api/auth/mfa/enable', { cookie, payload: { code: totpAt(setup.body.secret as string, currentStep()) } });
    const reset = await api('POST', `/api/users/${coordinator.id}/mfa/reset`, { cookie: admin.cookie });
    expect(reset.status).toBe(200);
    const again = await login(coordinator.email);
    expect(((await api('GET', '/api/auth/me', { cookie: again })).body.user as { mfa?: string }).mfa).toBe('setup');
  });
});

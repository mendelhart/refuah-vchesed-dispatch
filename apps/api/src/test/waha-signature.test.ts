import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { env } from '../env.js';
import { verifyWahaSignature } from '../routes/webhooks.routes.js';

/** Spec §25: WhatsApp (WAHA) webhook signatures. Pure function, no database. */
describe('WAHA webhook signature', () => {
  const mutable = env as unknown as { WAHA_WEBHOOK_SECRET?: string; NODE_ENV: string };
  const original = { secret: mutable.WAHA_WEBHOOK_SECRET, nodeEnv: mutable.NODE_ENV };
  afterEach(() => {
    mutable.WAHA_WEBHOOK_SECRET = original.secret;
    mutable.NODE_ENV = original.nodeEnv;
  });

  const body = JSON.stringify({ event: 'message', payload: { from: '15145550111@c.us', body: 'YES 123456' } });
  const sign = (secret: string, raw: string) => createHmac('sha512', secret).update(raw).digest('hex');

  it('accepts a correct signature, case-insensitively', () => {
    mutable.WAHA_WEBHOOK_SECRET = 'test-secret-value-1234';
    expect(verifyWahaSignature(body, sign('test-secret-value-1234', body))).toBe(true);
    expect(verifyWahaSignature(body, sign('test-secret-value-1234', body).toUpperCase())).toBe(true);
  });

  it('rejects a missing, wrong-key, truncated or tampered signature', () => {
    mutable.WAHA_WEBHOOK_SECRET = 'test-secret-value-1234';
    const good = sign('test-secret-value-1234', body);
    expect(verifyWahaSignature(body, undefined)).toBe(false);
    expect(verifyWahaSignature(body, sign('other-secret-000000', body))).toBe(false);
    expect(verifyWahaSignature(body, good.slice(0, 64))).toBe(false);
    expect(verifyWahaSignature(body.replace('123456', '654321'), good)).toBe(false);
  });

  it('refuses unsigned requests in production when no secret is configured', () => {
    mutable.WAHA_WEBHOOK_SECRET = undefined;
    mutable.NODE_ENV = 'production';
    expect(verifyWahaSignature(body, undefined)).toBe(false);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptedFullBackup } from '../domain/backup.service.js';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { cleanupPersonalRetention } from '../domain/personal-retention.service.js';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown } from './harness.js';
import { DatabaseRateLimitStore } from '../lib/rate-limit-store.js';

beforeAll(async () => { await getApp(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

const increment = (store: DatabaseRateLimitStore, key: string, window = 60_000) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) => {
    store.incr(key, (err, result) => err ? reject(err) : resolve(result!), window);
  });

describe('approved free fixes', () => {
  it('personal retention remains disabled without approved periods', async () => {
    expect(await cleanupPersonalRetention()).toEqual({ disabled: true });
  });

  it('full backups encrypt a valid pg_dump, reject wrong passphrases and require admin access', async () => {
    const data = await encryptedFullBackup('test-only-passphrase-1234');
    expect(data.subarray(0, 8).toString()).toBe('RVCBKP01');
    const key = scryptSync('test-only-passphrase-1234', data.subarray(8, 24), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(24, 36));
    decipher.setAuthTag(data.subarray(36, 52));
    const plain = Buffer.concat([decipher.update(data.subarray(52)), decipher.final()]);
    expect(plain.subarray(0, 5).toString()).toBe('PGDMP');
    const wrong = createDecipheriv('aes-256-gcm', scryptSync('wrong', data.subarray(8, 24), 32), data.subarray(24, 36));
    wrong.setAuthTag(data.subarray(36, 52));
    expect(() => { wrong.update(data.subarray(52)); wrong.final(); }).toThrow();
    const volunteer = await createTestUser({ role: 'volunteer' });
    expect((await api('POST', '/api/admin/backup/download', { cookie: volunteer.cookie, payload: { passphrase: 'test-only-passphrase-1234' } })).status).toBe(403);
  });

  it('test rides persist their flag and are excluded from Board stats and health warnings', async () => {
    const admin = await createTestUser({ role: 'admin', groups: [] });
    const result = await api('POST', '/api/trips', { cookie: admin.cookie, payload: sampleTrip({ isTest: true, pickupAt: new Date(Date.now() + 5 * 60_000).toISOString() }) });
    expect(result.status).toBe(201);
    expect((result.body.trip as { isTest: boolean }).isTest).toBe(true);
    const health = await api('GET', '/api/admin/health', { cookie: admin.cookie });
    const check = (health.body.checks as Array<{ name: string; value: number }>).find((c) => c.name === 'trips_unassigned_near_pickup');
    expect(check?.value).toBe(0);
  });

  it('password reset links are admin-only and contain no plaintext password', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const admin = await createTestUser({ role: 'admin', groups: [] });
    expect((await api('POST', `/api/users/${volunteer.id}/password-reset`, { cookie: volunteer.cookie })).status).toBe(403);
    const result = await api('POST', `/api/users/${volunteer.id}/password-reset`, { cookie: admin.cookie });
    expect(result.status).toBe(200);
    expect(result.body.resetUrl).toContain('/reset-password?token=');
  });
  it('rate-limit counters persist across store instances and increments are atomic', async () => {
    const key = crypto.randomUUID();
    const first = await increment(new DatabaseRateLimitStore(), key);
    expect(first.current).toBe(1);
    const results = await Promise.all(Array.from({ length: 10 }, () => increment(new DatabaseRateLimitStore(), key)));
    expect(results.map((r) => r.current).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(results.every((r) => r.ttl > 0 && r.ttl <= 60_000)).toBe(true);
  });

  it('announcement pictures require authentication before looking up an image', async () => {
    const id = crypto.randomUUID();
    expect((await api('GET', `/api/announcements/${id}/image`)).status).toBe(401);
    const admin = await createTestUser({ role: 'admin', groups: [] });
    expect((await api('GET', `/api/announcements/${id}/image`, { cookie: admin.cookie })).status).toBe(404);
  });

  it('only admins can read operational health', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const admin = await createTestUser({ role: 'admin', groups: [] });
    expect((await api('GET', '/api/admin/health', { cookie: volunteer.cookie })).status).toBe(403);
    expect((await api('GET', '/api/admin/health', { cookie: admin.cookie })).status).toBe(200);
  });
});

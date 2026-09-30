import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptedFullBackup } from '../domain/backup.service.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { sql as raw } from 'drizzle-orm';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { calendarMonthCutoff, cleanupPersonalRetention } from '../domain/personal-retention.service.js';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown } from './harness.js';
import { env } from '../env.js';
import { purgeExpiredFiles } from '../services/files.service.js';
import { objectStore } from '../services/providers/index.js';
import { vi } from 'vitest';
import { DatabaseRateLimitStore } from '../lib/rate-limit-store.js';

beforeAll(async () => { await getApp(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

const increment = (store: DatabaseRateLimitStore, key: string, window = 60_000) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) => {
    store.incr(key, (err, result) => err ? reject(err) : resolve(result!), window);
  });

describe('approved free fixes', () => {
  it('uses calendar months, including leap-year and month-end clamping', () => {
    expect(calendarMonthCutoff(new Date('2024-02-29T12:30:00Z'), 12).toISOString()).toBe('2023-02-28T12:30:00.000Z');
    expect(calendarMonthCutoff(new Date('2026-03-31T12:30:00Z'), 1).toISOString()).toBe('2026-02-28T12:30:00.000Z');
    expect(calendarMonthCutoff(new Date('2026-09-30T12:30:00Z'), 12).toISOString()).toBe('2025-09-30T12:30:00.000Z');
  });

  it('enabled scheduled entry requires all three periods and applies the configured mapping', async () => {
    const previous = { enabled: env.PERSONAL_RETENTION_ENABLED, licence: env.REMOVED_LICENCE_RETENTION_MONTHS, application: env.REJECTED_APPLICATION_RETENTION_MONTHS, trip: env.OLD_TRIP_PERSONAL_RETENTION_MONTHS };
    try {
      env.PERSONAL_RETENTION_ENABLED = true;
      env.REMOVED_LICENCE_RETENTION_MONTHS = undefined;
      await expect(cleanupPersonalRetention()).rejects.toThrow('All approved');
      env.REMOVED_LICENCE_RETENTION_MONTHS = 12;
      env.REJECTED_APPLICATION_RETENTION_MONTHS = 12;
      env.OLD_TRIP_PERSONAL_RETENTION_MONTHS = 12;
      expect(await cleanupPersonalRetention()).toEqual({ disabled: false });
    } finally {
      env.PERSONAL_RETENTION_ENABLED = previous.enabled;
      env.REMOVED_LICENCE_RETENTION_MONTHS = previous.licence;
      env.REJECTED_APPLICATION_RETENTION_MONTHS = previous.application;
      env.OLD_TRIP_PERSONAL_RETENTION_MONTHS = previous.trip;
    }
  });

  it('failed file purge stays retryable and successful purge is audited', async () => {
    const id = crypto.randomUUID();
    await db.execute(raw`insert into stored_files (id,storage_key,content_type,byte_size,sha256,purge_after) values (${id}, ${id}, 'image/png', 5, 'test', now() - interval '1 day')`);
    const remove = vi.spyOn(objectStore, 'delete').mockRejectedValueOnce(new Error('temporary storage error'));
    try { await expect(purgeExpiredFiles()).rejects.toThrow('temporary storage error'); } finally { remove.mockRestore(); }
    const retry = await db.execute(raw`select deleted_at from stored_files where id = ${id}`);
    expect(retry[0]!.deleted_at).toBeNull();
    expect(await purgeExpiredFiles()).toBe(1);
    const audit = await db.execute(raw`select count(*)::int as n from audit_events where action = 'file.retention_purged' and entity_id = ${id}`);
    expect(audit[0]!.n).toBe(1);
  });

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

  it('restores an encrypted full download into a fresh temporary database including file bytes and audit', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const marker = crypto.randomUUID();
    await db.execute(raw`insert into stored_file_blobs (storage_key, content_type, body) values (${marker}, 'application/octet-stream', decode('0102030405', 'hex'))`);
    await api('POST', '/api/trips', { cookie: admin.cookie, payload: sampleTrip({ isTest: true }) });
    const encrypted = await encryptedFullBackup('restore-test-passphrase-1234');
    const key = scryptSync('restore-test-passphrase-1234', encrypted.subarray(8, 24), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(24, 36));
    decipher.setAuthTag(encrypted.subarray(36, 52));
    const plain = Buffer.concat([decipher.update(encrypted.subarray(52)), decipher.final()]);
    const dir = mkdtempSync(join(tmpdir(), 'rvc-restore-'));
    const dump = join(dir, 'test.dump');
    const database = `rvc_restore_${crypto.randomUUID().replaceAll('-', '')}`;
    const source = new URL(process.env.DATABASE_URL!);
    const target = new URL(source);
    target.pathname = `/${database}`;
    const pgEnv = { ...process.env, PGPASSWORD: decodeURIComponent(source.password) };
    const maintenance = new URL(source); maintenance.pathname = '/postgres';
    let created = false;
    try {
      writeFileSync(dump, plain, { mode: 0o600 });
      execFileSync('psql', [maintenance.toString(), '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${database}`], { env: pgEnv });
      created = true;
      execFileSync('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '-d', target.toString(), dump], { env: pgEnv });
      const query = `select (select count(*) from trips where is_test)::text || ':' || (select encode(body, 'hex') from stored_file_blobs where storage_key = '${marker}') || ':' || (select count(*) > 0 from audit_events)::text`;
      expect(execFileSync('psql', [target.toString(), '-At', '-c', query], { env: pgEnv, encoding: 'utf8' }).trim()).toBe('1:0102030405:true');
    } finally {
      key.fill(0); plain.fill(0); rmSync(dir, { recursive: true, force: true });
      if (created) execFileSync('psql', [maintenance.toString(), '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE ${database}`], { env: pgEnv });
    }
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

describe('disabled personal retention engine rehearsal', () => {
  it('scrubs rejected applications and schedules only unshared removed-user licence images', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const active = await createTestUser({ role: 'volunteer' });
    const reviewer = await createTestUser({ role: 'admin' });
    const application = crypto.randomUUID();
    const file = crypto.randomUUID();
    const unshared = crypto.randomUUID();
    await db.execute(raw`insert into volunteer_applications (id,reference,status,full_name,email,phone,reviewed_by_id,reviewed_at,review_notes,notes,consent_contact,consent_background_check) values (${application}, 'TEST-RETENTION', 'rejected', 'Old applicant', 'old@example.test', '+15145550002', ${reviewer.id}, now() - interval '100 days', 'test reason', 'private note', true, true)`);
    await db.execute(raw`insert into stored_files (id,storage_key,content_type,byte_size,sha256) values (${file}, ${file}, 'image/png', 5, 'test'), (${unshared}, ${unshared}, 'image/png', 5, 'test')`);
    await db.execute(raw`update users set deleted_at = now() - interval '100 days' where id = ${volunteer.id}`);
    await db.execute(raw`insert into driver_licences (user_id,front_file_id,back_file_id) values (${volunteer.id}, ${file}, ${unshared}), (${active.id}, ${file}, null)`);
    const { applyPersonalRetention } = await import('../domain/personal-retention.service.js');
    await applyPersonalRetention({ removedLicenceMonths: 1, rejectedApplicationMonths: 1, oldTripMonths: 1 });
    const old = await db.execute(raw`select full_name,notes from volunteer_applications where id = ${application}`);
    expect(old[0]).toMatchObject({ full_name: '[removed]', notes: null });
    const shared = await db.execute(raw`select purge_after from stored_files where id = ${file}`);
    expect(shared[0]!.purge_after).toBeNull();
    const scheduled = await db.execute(raw`select purge_after from stored_files where id = ${unshared}`);
    expect(scheduled[0]!.purge_after).not.toBeNull();
    const removed = await db.execute(raw`select front_file_id from driver_licences where user_id = ${volunteer.id}`);
    expect(removed[0]!.front_file_id).toBeNull();
    const kept = await db.execute(raw`select front_file_id from driver_licences where user_id = ${active.id}`);
    expect(kept[0]!.front_file_id).toBe(file);
  });

  it('scrubs old trip detail without changing a shared address or its audit history', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const created = await api('POST', '/api/trips', { cookie: admin.cookie, payload: sampleTrip() });
    const id = (created.body.trip as { id: string }).id;
    const initial = await db.execute(raw`select pickup_address_id from trips where id = ${id}`);
    const original = initial[0]!.pickup_address_id;
    await db.execute(raw`insert into contacts (name, phone, address_id) values ('Shared clinic', '+15145550001', ${original})`);
    await db.execute(raw`update trips set status = 'completed', completed_at = now() - interval '100 days' where id = ${id}`);
    const { applyPersonalRetention } = await import('../domain/personal-retention.service.js');
    await applyPersonalRetention({ removedLicenceMonths: 1, rejectedApplicationMonths: 1, oldTripMonths: 1 });
    const result = await db.execute(raw`select caller_name, pickup_address_id from trips where id = ${id}`);
    expect(result[0]!.caller_name).toBeNull();
    expect(result[0]!.pickup_address_id).not.toBe(original);
    const shared = await db.execute(raw`select line1 from addresses where id = ${original}`);
    expect(shared[0]!.line1).not.toBe('[retained trip address removed]');
    const audit = await db.execute(raw`select count(*)::int as n from audit_events where entity_id = ${id}`);
    expect(audit[0]!.n).toBeGreaterThan(1);
    await applyPersonalRetention({ removedLicenceMonths: 1, rejectedApplicationMonths: 1, oldTripMonths: 1 });
    const retained = await db.execute(raw`select count(*)::int as n from audit_events where entity_id = ${id} and action = 'retention.trip_personal_scrubbed'`);
    expect(retained[0]!.n).toBe(1);
  });
});

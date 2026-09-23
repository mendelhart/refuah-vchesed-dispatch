import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { api, createTestUser, drainJobs, getApp, rejectsWith, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import {
  driverLicences,
  messageTemplateVersions,
  messageTemplates,
  notificationDeliveries,
  notifications,
  users,
} from '../db/schema.js';
import { captured, capturedExtra, extraFaults } from '../services/providers/inmemory.js';
import { interpolate, renderTemplate } from '../services/templates.service.js';
import { recordLicence, reviewLicence, verifyLicence } from '../domain/licences.service.js';
import { SYSTEM_ACTOR } from '../lib/audit.js';

describe('communications and templates', () => {
  let admin: TestUser;
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin' });
    dispatcher = await createTestUser({ role: 'dispatcher' });
  });

  // --- template rendering --------------------------------------------------

  it('drops a line whose only variable came back empty', () => {
    const out = interpolate('Trip {{ref}}\nNeeds: {{needs}}\n\nAccept: {{url}}', {
      ref: 'RVC-1', needs: '', url: 'https://x',
    });
    expect(out).not.toMatch(/Needs:/);
    expect(out).toMatch(/Trip RVC-1/);
    expect(out).toMatch(/Accept: https:\/\/x/);
  });

  it('keeps a line that has real text beside an empty variable', () => {
    const out = interpolate('Call the ward desk on {{phone}} before you set off', { phone: '' });
    expect(out).toMatch(/Call the ward desk/);
  });

  it('substitutes nothing an administrator did not ask for', () => {
    const out = interpolate('Hello {{name}}, {{unknown}}', { name: 'Rivka' });
    expect(out).toBe('Hello Rivka,');
  });

  it('uses the database row in preference to the built-in default', async () => {
    const [row] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.key, 'sms.help'), eq(messageTemplates.channel, 'sms')));

    await api('PATCH', `/api/templates/${row!.id}`, {
      cookie: admin.cookie,
      payload: { body: 'Custom help text for the organisation.' },
    });

    const rendered = await renderTemplate('sms.help', 'sms', { orgPhone: '' });
    expect(rendered.body).toBe('Custom help text for the organisation.');
    expect(rendered.fromDatabase).toBe(true);
  });

  it('refuses a template that references a variable nothing supplies', async () => {
    const [row] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.key, 'sms.help'), eq(messageTemplates.channel, 'sms')));

    const res = await api('PATCH', `/api/templates/${row!.id}`, {
      cookie: admin.cookie,
      payload: { body: 'Hello {{volunteerBirthday}}' },
    });
    expect(res.status).toBe(422);
    expect((res.body.error as { message: string }).message).toMatch(/volunteerBirthday/);
  });

  it('refuses an SMS template long enough to cost more than the ride', async () => {
    const [row] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.key, 'sms.help'), eq(messageTemplates.channel, 'sms')));
    const res = await api('PATCH', `/api/templates/${row!.id}`, {
      cookie: admin.cookie,
      payload: { body: 'x'.repeat(1300) },
    });
    expect(res.status).toBe(422);
  });

  it('versions every edit and can put a previous version back', async () => {
    const [row] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.key, 'sms.help'), eq(messageTemplates.channel, 'sms')));
    const original = row!.body;

    await api('PATCH', `/api/templates/${row!.id}`, { cookie: admin.cookie, payload: { body: 'First edit.' } });
    await api('PATCH', `/api/templates/${row!.id}`, { cookie: admin.cookie, payload: { body: 'Second edit.' } });

    const detail = await api('GET', `/api/templates/${row!.id}`, { cookie: admin.cookie });
    const template = detail.body.template as { version: number; body: string; versions: Array<{ version: number; body: string }> };
    expect(template.version).toBe(3);
    expect(template.body).toBe('Second edit.');
    expect(template.versions.map((v) => v.body)).toEqual([original, 'First edit.']);

    const reverted = await api('POST', `/api/templates/${row!.id}/revert`, {
      cookie: admin.cookie,
      payload: { version: 1 },
    });
    expect((reverted.body.template as { body: string }).body).toBe(original);
  });

  it('keeps template history append-only', async () => {
    const [row] = await db
      .select()
      .from(messageTemplates)
      .where(and(eq(messageTemplates.key, 'sms.help'), eq(messageTemplates.channel, 'sms')));
    await api('PATCH', `/api/templates/${row!.id}`, { cookie: admin.cookie, payload: { body: 'Edited.' } });

    await rejectsWith(
      db.update(messageTemplateVersions).set({ body: 'rewritten history' }),
      /append-only/i
    );
  });

  it('refuses a dispatcher the template editor', async () => {
    const res = await api('GET', '/api/templates', { cookie: dispatcher.cookie });
    expect(res.status).toBe(403);
  });

  // --- channels ------------------------------------------------------------

  it('records a delivery row per channel the volunteer asked for', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    await db.update(users).set({ notificationPreference: 'all' }).where(eq(users.id, volunteer.id));

    const { notify } = await import('../services/notification.service.js');
    await notify({
      userId: volunteer.id,
      event: 'trip.completed',
      title: 'Thank you',
      body: 'Thank you for driving today.',
      subject: 'Thank you',
    });
    await drainJobs();

    const rows = await db
      .select({
        channel: notificationDeliveries.channel,
        status: notificationDeliveries.status,
        lastError: notificationDeliveries.lastError,
      })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .where(eq(notifications.userId, volunteer.id));

    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'inapp', 'push', 'sms', 'whatsapp']);

    // Push has nowhere to go without a subscription, and says so rather than
    // being silently dropped.
    const push = rows.find((r) => r.channel === 'push')!;
    expect(push.status).toBe('skipped');
    expect(push.lastError).toMatch(/subscription/i);

    expect(rows.find((r) => r.channel === 'email')!.status).toBe('sent');
    expect(rows.find((r) => r.channel === 'whatsapp')!.status).toBe('sent');
    expect(capturedExtra.email.some((m) => m.to === volunteer.email)).toBe(true);
    expect(capturedExtra.whatsapp.some((m) => m.to === volunteer.phone)).toBe(true);
  });

  it('pairs WhatsApp with another channel rather than trusting it alone', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    await db.update(users).set({ notificationPreference: 'whatsapp' }).where(eq(users.id, volunteer.id));

    const { notify } = await import('../services/notification.service.js');
    await notify({
      userId: volunteer.id,
      event: 'trip.completed',
      title: 'Thank you',
      body: 'Thank you for driving today.',
    });

    const rows = await db
      .select({ channel: notificationDeliveries.channel })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .where(eq(notifications.userId, volunteer.id));

    // A paired WhatsApp session can drop without warning, so it is never the
    // only way a message is attempted.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.channel)).toContain('whatsapp');
  });

  it("sends an offer on the volunteer's chosen channel (WhatsApp)", async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    await db.update(users).set({ notificationPreference: 'whatsapp' }).where(eq(users.id, volunteer.id));

    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await drainJobs();

    // Each volunteer picks their channel. A dropped WhatsApp session is caught
    // by the health check / failed send and the offer falls back to SMS
    // (whatsapp-failover.test.ts), so the offer is not trusted to WhatsApp blindly.
    expect(capturedExtra.whatsapp.some((m) => m.to === volunteer.phone)).toBe(true);
    expect(captured.sms.some((m) => m.to === volunteer.phone)).toBe(false);
  });

  it('still tells a snoozed volunteer that their trip was cancelled', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/assign`, {
      cookie: dispatcher.cookie,
      payload: { volunteerId: volunteer.id },
    });

    // Now they snooze, and turn everything off.
    await db
      .update(users)
      .set({ mutedUntil: new Date(Date.now() + 86_400_000), notificationPreference: 'none' })
      .where(eq(users.id, volunteer.id));
    captured.reset();

    await api('POST', `/api/trips/${tripId}/cancel`, {
      cookie: dispatcher.cookie,
      payload: { reason: 'Appointment moved' },
    });
    await drainJobs();

    // Muting silences offers. It does not silence the consequences of a
    // commitment they already made — they would otherwise drive to a hospital
    // for a passenger who is not there.
    expect(captured.sms.some((m) => m.to === volunteer.phone)).toBe(true);
  });

  it('records a failed send rather than losing it', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    await db.update(users).set({ notificationPreference: 'email' }).where(eq(users.id, volunteer.id));
    // More failures than the retry budget, so the delivery ends up 'failed'
    // rather than eventually succeeding.
    extraFaults.emailFailures = 20;

    const { notify } = await import('../services/notification.service.js');
    await notify({
      userId: volunteer.id,
      event: 'trip.completed',
      title: 'Thank you',
      body: 'Thank you for driving today.',
      subject: 'Thank you',
    });
    await drainJobs();

    const [row] = await db
      .select({
        attempts: notificationDeliveries.attempts,
        status: notificationDeliveries.status,
        lastError: notificationDeliveries.lastError,
      })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .where(and(eq(notifications.userId, volunteer.id), eq(notificationDeliveries.channel, 'email')));

    expect(row).toBeDefined();
    expect(row!.attempts).toBeGreaterThan(0);
    expect(row!.lastError).toMatch(/simulated email failure/);
    // Visible to an administrator, not retried silently forever.
    expect(['queued', 'failed']).toContain(row!.status);

    const health = await api('GET', '/api/ops/health', { cookie: admin.cookie });
    expect(health.status).toBe(200);
    extraFaults.emailFailures = 0;
  });

  // --- driver licences -----------------------------------------------------

  it('will not mark a licence verified without a verification provider', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const licence = await recordLicence(SYSTEM_ACTOR, {
      userId: volunteer.id,
      licenceNumber: 'B1234567890AB',
      expiresOn: '2031-01-01',
    });

    const result = await verifyLicence(SYSTEM_ACTOR, licence.id);
    expect(result.verified).toBe(false);
    expect(result.status).toBe('unsupported');
    expect(result.detail).toMatch(/nothing has been verified/i);

    const [after] = await db.select().from(driverLicences).where(eq(driverLicences.id, licence.id));
    expect(after!.status).toBe('pending_review');
    expect(after!.verifiedAt).toBeNull();
  });

  it('lets an administrator record that they looked, but not that it is valid', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const licence = await recordLicence(SYSTEM_ACTOR, { userId: volunteer.id, licenceNumber: 'B1234567890AB' });

    const reviewed = await reviewLicence(SYSTEM_ACTOR, licence.id, 'on_file', 'Photo matches the name');
    expect(reviewed.status).toBe('on_file');

    // 'verified' is not a decision a person can make.
    await rejectsWith(
      reviewLicence(SYSTEM_ACTOR, licence.id, 'verified' as never),
      /verification service/i
    );

    const res = await api('POST', `/api/licences/${licence.id}/review`, {
      cookie: admin.cookie,
      payload: { decision: 'verified' },
    });
    expect(res.status).toBe(422);
  });

  it('refuses a verified licence at the database level, whatever the code does', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const licence = await recordLicence(SYSTEM_ACTOR, { userId: volunteer.id, licenceNumber: 'B1234567890AB' });

    // The second lock: even a direct UPDATE cannot claim verification without
    // naming the provider and its reference.
    await expect(
      db.update(driverLicences).set({ status: 'verified' }).where(eq(driverLicences.id, licence.id)),
    ).rejects.toThrow();

    await expect(
      db
        .update(driverLicences)
        .set({
          status: 'verified',
          verificationProvider: 'some-vendor',
          verificationReference: 'ref-123',
          verifiedAt: new Date(),
        })
        .where(eq(driverLicences.id, licence.id)),
    ).resolves.toBeDefined();
  });

  it('puts a licence back into review when the document changes', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const licence = await recordLicence(SYSTEM_ACTOR, { userId: volunteer.id, licenceNumber: 'B1234567890AB' });
    await reviewLicence(SYSTEM_ACTOR, licence.id, 'on_file');

    await recordLicence(SYSTEM_ACTOR, { userId: volunteer.id, licenceNumber: 'C9876543210ZZ' });

    const [after] = await db.select().from(driverLicences).where(eq(driverLicences.userId, volunteer.id));
    expect(after!.status).toBe('pending_review');
    expect(after!.numberLast4).toBe('10ZZ');
  });

  it('keeps the licence number out of the row and out of the API', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    await recordLicence(SYSTEM_ACTOR, { userId: volunteer.id, licenceNumber: 'B1234567890AB' });

    const [row] = await db.select().from(driverLicences).where(eq(driverLicences.userId, volunteer.id));
    expect(row!.numberCiphertext).not.toMatch(/B123456/);
    expect(row!.numberCiphertext).toMatch(/^v1\./);

    const res = await api('GET', '/api/me/licence', { cookie: volunteer.cookie });
    expect(JSON.stringify(res.body)).not.toMatch(/B123456/);
    expect((res.body.licence as { numberLast4: string }).numberLast4).toBe('90AB');
  });

  it('refuses a volunteer access to somebody else’s licence image', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const saved = await api('PUT', '/api/me/licence', {
      cookie: volunteer.cookie,
      payload: { licenceNumber: 'B1234567890AB', frontImage: png },
    });
    expect(saved.status).toBe(200);
    expect(String(saved.body.note)).toMatch(/nothing has been verified/i);

    const [row] = await db.select().from(driverLicences).where(eq(driverLicences.userId, volunteer.id));
    const other = await createTestUser({ role: 'volunteer' });
    const res = await api('GET', `/api/files/${row!.frontFileId}`, { cookie: other.cookie });
    expect(res.status).toBe(403);

    const asAdmin = await api('GET', `/api/files/${row!.frontFileId}?reason=review`, { cookie: admin.cookie });
    expect(asAdmin.status).toBe(200);
  });
});

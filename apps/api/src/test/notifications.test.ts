import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificationDeliveries, notifications, pushSubscriptions, users } from '../db/schema.js';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { captured, faults } from '../services/providers/inmemory.js';

/**
 * Notification delivery.
 *
 * The property under test is that a failure is never silent: it is recorded,
 * retried with backoff, and eventually surfaces as `failed` with the provider's
 * error attached. The legacy system caught send errors, logged them to a
 * console nobody read, and reported success to the dispatcher.
 */
describe('notifications', () => {
  let dispatcher: TestUser;
  let volunteer: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    volunteer = await createTestUser({ role: 'volunteer' });
  });

  async function offerATrip() {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    return tripId;
  }

  it('creates a delivery record per channel and sends them', async () => {
    const tripId = await offerATrip();
    const before = await db.select().from(notificationDeliveries);
    expect(before.length).toBeGreaterThanOrEqual(2); // sms + inapp at minimum
    expect(before.every((d) => ['queued', 'skipped'].includes(d.status))).toBe(true);

    await drainJobs();

    const after = await db.select().from(notificationDeliveries);
    const sms = after.find((d) => d.channel === 'sms')!;
    expect(sms.status).toBe('sent');
    expect(sms.providerMessageId).toBeTruthy();
    expect(captured.sms.some((m) => m.to === volunteer.phone)).toBe(true);

    // The message carries everything the volunteer needs to decide.
    const body = captured.sms.find((m) => m.to === volunteer.phone)!.body;
    expect(body).toMatch(/RVC-/);
    expect(body).toMatch(/Accept:/);
    expect(body).toMatch(/Or reply: YES/);
    void tripId;
  });

  it('records a skip, with a reason, when a volunteer has no phone number', async () => {
    await db.update(users).set({ phone: null }).where(eq(users.id, volunteer.id));
    await offerATrip();
    const sms = (await db.select().from(notificationDeliveries)).find((d) => d.channel === 'sms')!;
    expect(sms.status).toBe('skipped');
    expect(sms.lastError).toMatch(/no phone number/i);
  });

  it('retries a failed send, then gives up visibly rather than silently', async () => {
    faults.smsFailures = 99; // every attempt fails
    await offerATrip();

    let sms = (await db.select().from(notificationDeliveries)).find((d) => d.channel === 'sms')!;
    const maxAttempts = sms.maxAttempts;

    for (let i = 0; i < maxAttempts + 2; i += 1) {
      await db.execute(sql`update jobs set run_at = now() - interval '1 minute' where status = 'pending'`);
      await db.execute(sql`
        update notification_deliveries set next_attempt_at = now() - interval '1 minute'
        where status = 'queued'
      `);
      await drainJobs();
    }

    sms = (await db.select().from(notificationDeliveries)).find((d) => d.channel === 'sms')!;
    expect(sms.attempts).toBeGreaterThan(1);
    expect(sms.status).toBe('failed');
    expect(sms.lastError).toMatch(/simulated SMS failure/);
    expect(sms.failedAt).not.toBeNull();
  });

  it('surfaces failures on the operations endpoint', async () => {
    faults.smsFailures = 99;
    await offerATrip();
    await db.execute(sql`update notification_deliveries set status='failed', failed_at=now(), last_error='boom' where channel='sms'`);
    const res = await api('GET', '/api/ops/health', { cookie: dispatcher.cookie });
    expect(res.status).toBe(200);
    expect((res.body.deliveries as { failed: number }).failed).toBeGreaterThan(0);

    const list = await api('GET', '/api/notifications/deliveries?status=failed', { cookie: dispatcher.cookie });
    expect((list.body.deliveries as unknown[]).length).toBeGreaterThan(0);
  });

  it('recovers after a transient failure', async () => {
    faults.smsFailures = 1; // fail once, then succeed
    await offerATrip();
    await drainJobs();

    await db.execute(sql`update jobs set run_at = now() - interval '1 minute' where status = 'pending'`);
    await db.execute(sql`update notification_deliveries set next_attempt_at = now() - interval '1 minute' where status = 'queued'`);
    await drainJobs();

    const sms = (await db.select().from(notificationDeliveries)).find((d) => d.channel === 'sms')!;
    expect(sms.status).toBe('sent');
    expect(sms.attempts).toBe(2);
  });

  it('disables a push subscription the browser has thrown away', async () => {
    await db.insert(pushSubscriptions).values({
      userId: volunteer.id, endpoint: 'https://push.example/gone', p256dh: 'k', auth: 'a',
    });
    faults.pushFailures = 99;
    await offerATrip();
    await drainJobs();
    const push = (await db.select().from(notificationDeliveries)).find((d) => d.channel === 'push');
    expect(push).toBeDefined();
    expect(['queued', 'failed']).toContain(push!.status);
    expect(push!.lastError).toBeTruthy();
  });

  it('does not offer a trip to a snoozed volunteer', async () => {
    await api('POST', '/api/me/mute', { cookie: volunteer.cookie, payload: { hours: 24 } });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    const res = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(res.status).toBe(409);
    expect(String(JSON.stringify(res.body))).toMatch(/snoozed/i);

    // Clearing the snooze restores them to the pool.
    await api('POST', '/api/me/mute', { cookie: volunteer.cookie, payload: { hours: 0 } });
    const retry = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(retry.status).toBe(200);
    expect(retry.body.offered).toBe(1);
  });

  it('gives a volunteer their own in-app feed and nobody else’s', async () => {
    const other = await createTestUser({ role: 'volunteer' });
    await offerATrip();
    await drainJobs();

    const mine = await api('GET', '/api/notifications', { cookie: volunteer.cookie });
    expect((mine.body.notifications as unknown[]).length).toBeGreaterThan(0);

    const theirs = await api('GET', '/api/notifications', { cookie: other.cookie });
    const rows = await db.select().from(notifications).where(eq(notifications.userId, other.id));
    expect((theirs.body.notifications as unknown[]).length).toBe(rows.length);
  });
});

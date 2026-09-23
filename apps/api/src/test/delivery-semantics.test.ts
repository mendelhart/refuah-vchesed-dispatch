import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificationDeliveries, notifications } from '../db/schema.js';
import { deliverNotification, recordSmsStatusCallback, setSendTimeoutForTests } from '../services/notification.service.js';
import { smsProvider } from '../services/providers/index.js';
import { createTestUser, getApp, resetDb, shutdown } from './harness.js';

/** Spec §10: what each delivery status claims must be true. */
describe('notification delivery semantics', () => {
  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { vi.restoreAllMocks(); setSendTimeoutForTests(10_000); });

  async function smsDelivery(): Promise<string> {
    const u = await createTestUser({ role: 'volunteer' });
    const [n] = await db.insert(notifications).values({ userId: u.id, event: 'test', title: 't', body: 'Trip offer' }).returning();
    const [d] = await db.insert(notificationDeliveries)
      .values({ notificationId: n!.id, channel: 'sms', destination: u.phone }).returning();
    return d!.id;
  }
  const row = async (id: string) => (await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]!;

  it('provider accepted = sent (not delivered); the callback makes it delivered', async () => {
    const id = await smsDelivery();
    await deliverNotification(id);
    const sent = await row(id);
    expect(sent.status).toBe('sent');
    expect(sent.providerMessageId).toBeTruthy();
    expect(sent.deliveredAt).toBeNull();
    await recordSmsStatusCallback(sent.providerMessageId!, 'delivered');
    expect((await row(id)).status).toBe('delivered');
    // A late, out-of-order failure does not undo a confirmed delivery.
    await recordSmsStatusCallback(sent.providerMessageId!, 'undelivered', '30003');
    expect((await row(id)).status).toBe('delivered');
  });

  it('undelivered callback is a failure with the reason kept', async () => {
    const id = await smsDelivery();
    await deliverNotification(id);
    await recordSmsStatusCallback((await row(id)).providerMessageId!, 'undelivered', 'Unreachable handset');
    const r = await row(id);
    expect(r.status).toBe('failed');
    expect(r.lastError).toMatch(/Unreachable/);
  });

  it('a provider timeout is recorded as unknown and never retried into a duplicate', async () => {
    const id = await smsDelivery();
    setSendTimeoutForTests(50);
    const send = vi.spyOn(smsProvider, 'send').mockImplementation(() => new Promise(() => {}));
    await expect(deliverNotification(id)).resolves.toBeUndefined();
    const r = await row(id);
    expect(r.status).toBe('unknown');
    expect(r.lastError).toMatch(/may have been sent/);
    await deliverNotification(id); // a duplicate job
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a clear provider error retries, bounded by max attempts, then fails visibly', async () => {
    const id = await smsDelivery();
    await db.update(notificationDeliveries).set({ maxAttempts: 2 }).where(eq(notificationDeliveries.id, id));
    const send = vi.spyOn(smsProvider, 'send').mockRejectedValue(new Error('21211 invalid number'));
    await expect(deliverNotification(id)).rejects.toThrow(/21211/);
    expect((await row(id)).status).toBe('queued');
    await deliverNotification(id);
    const r = await row(id);
    expect(r.status).toBe('failed');
    expect(r.attempts).toBe(2);
    await deliverNotification(id);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

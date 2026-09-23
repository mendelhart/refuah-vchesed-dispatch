import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificationDeliveries, users } from '../db/schema.js';
import { notify } from '../services/notification.service.js';
import { captured, capturedExtra, extraFaults } from '../services/providers/inmemory.js';
import { createTestUser, drainJobs, getApp, resetDb, shutdown } from './harness.js';

/**
 * WhatsApp goes through WAHA first; when WAHA fails the same text goes by SMS
 * and the delivery row says so.
 */
describe('WhatsApp -> SMS fallback', () => {
  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await resetDb(); });

  async function whatsappVolunteer() {
    const v = await createTestUser({ role: 'volunteer' });
    await db.update(users).set({ notificationPreference: 'whatsapp' }).where(eq(users.id, v.id));
    return v;
  }

  it('records WhatsApp as the carrier when WAHA works', async () => {
    const v = await whatsappVolunteer();
    const id = await notify({ userId: v.id, event: 'announcement.broadcast', title: 't', body: 'hello wa' });
    await drainJobs();
    const [row] = await db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, id)).then((r) => r.filter((d) => d.channel === 'whatsapp'));
    expect(row?.status).toBe('sent');
    expect(row?.carriedBy).toBe('whatsapp');
    expect(row?.fallbackReason).toBeNull();
    expect(capturedExtra.whatsapp.some((m) => m.body === 'hello wa')).toBe(true);
    expect(captured.sms.length).toBe(0);
  });

  it('falls back to SMS when the WhatsApp send fails, and says why', async () => {
    const v = await whatsappVolunteer();
    extraFaults.whatsappFailures = 1;
    const id = await notify({ userId: v.id, event: 'announcement.broadcast', title: 't', body: 'hello fallback' });
    await drainJobs();
    const [row] = await db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, id)).then((r) => r.filter((d) => d.channel === 'whatsapp'));
    expect(row?.status).toBe('sent');
    expect(row?.carriedBy).toBe('sms');
    expect(row?.fallbackReason).toMatch(/WhatsApp send failed/);
    expect(captured.sms.filter((m) => m.body === 'hello fallback').length).toBe(1);
  });

  it('does not double-text when the notification already goes by SMS', async () => {
    const v = await createTestUser({ role: 'volunteer' });
    await db.update(users).set({ notificationPreference: 'all' }).where(eq(users.id, v.id));
    extraFaults.whatsappFailures = 10;
    await notify({ userId: v.id, event: 'announcement.broadcast', title: 't', body: 'once only' });
    await drainJobs();
    expect(captured.sms.filter((m) => m.body === 'once only').length).toBe(1);
  });
});

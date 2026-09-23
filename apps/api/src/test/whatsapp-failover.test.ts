import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificationDeliveries, users } from '../db/schema.js';
import { notify } from '../services/notification.service.js';
import { captured, capturedExtra, extraFaults } from '../services/providers/inmemory.js';
import { api, createTestUser, drainJobs, getApp, resetDb, shutdown } from './harness.js';

/**
 * WhatsApp goes through WAHA first; when WAHA fails the same text goes by SMS
 * and the delivery row says so.
 */
describe('WhatsApp -> SMS fallback', () => {
  beforeAll(async () => { await getApp(); });
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

describe('incoming WhatsApp (WAHA webhook)', () => {
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await resetDb(); });

  const msg = (from: string, body: string, extra: Record<string, unknown> = {}) => ({
    event: 'message',
    session: 'default',
    payload: { id: `false_${from}_${Math.random()}`, from: `${from.replace('+', '')}@c.us`, fromMe: false, body, ...extra },
  });

  it('handles STOP 2H from WhatsApp like SMS and replies on WhatsApp', async () => {
    const v = await createTestUser({ role: 'volunteer' });
    const res = await api('POST', '/webhooks/waha', { payload: msg(v.phone, 'stop 2h') });
    expect(res.status).toBe(200);
    const [row] = await db.select({ mutedUntil: users.mutedUntil }).from(users).where(eq(users.id, v.id));
    expect(row?.mutedUntil).not.toBeNull();
    expect(capturedExtra.whatsapp.some((m) => m.to === v.phone)).toBe(true);
  });

  it('ignores our own messages and group chats', async () => {
    const v = await createTestUser({ role: 'volunteer' });
    const own = await api('POST', '/webhooks/waha', { payload: msg(v.phone, 'stop 2h', { fromMe: true }) });
    expect(own.body.ignored).toBe(true);
    const group = await api('POST', '/webhooks/waha', {
      payload: { event: 'message', payload: { id: 'g1', from: '12345@g.us', fromMe: false, body: 'stop 2h' } },
    });
    expect(group.body.ignored).toBe(true);
    const [row] = await db.select({ mutedUntil: users.mutedUntil }).from(users).where(eq(users.id, v.id));
    expect(row?.mutedUntil).toBeNull();
  });
});

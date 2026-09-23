import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { SETTING_KEYS } from '@rvc/shared';
import { db } from '../db/client.js';
import { jobs, notificationDeliveries, notifications, tripOffers, trips, users } from '../db/schema.js';
import { setSetting } from '../lib/settings.js';
import { captured } from '../services/providers/inmemory.js';
import { parseChoice } from '../services/voice.service.js';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';

/**
 * Voice calls: a volunteer who chose "Voice call" gets offers as a call, can
 * accept with 1 / "yes", and an unanswered call is retried once and then
 * texted.
 */
describe('voice-call offers', () => {
  let dispatcher: TestUser;
  let volunteer: TestUser;
  let tripId: string;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });

  async function offerTo(v: TestUser, over: Record<string, unknown> = {}) {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip(over) });
    const id = (created.body.trip as { id: string }).id;
    const res = await api('POST', `/api/trips/${id}/offer`, { cookie: dispatcher.cookie, payload: { volunteerIds: [v.id] } });
    expect(res.status).toBeLessThan(300);
    return id;
  }

  async function voiceRow(id: string) {
    const rows = await db
      .select({ d: notificationDeliveries })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .where(and(eq(notifications.tripId, id), eq(notifications.event, 'trip.offered')));
    return rows.map((r) => r.d);
  }

  const post = (url: string, params: Record<string, string>) =>
    api('POST', url, {
      payload: new URLSearchParams(params).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  beforeEach(async () => {
    await resetDb();
    // Tests run at any hour: switch quiet hours off unless a test turns them on.
    await setSetting(SETTING_KEYS.voiceQuietStartHour, 0, null);
    await setSetting(SETTING_KEYS.voiceQuietEndHour, 0, null);
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    volunteer = await createTestUser({ role: 'volunteer' });
    await db.update(users).set({ notificationPreference: 'voice' }).where(eq(users.id, volunteer.id));
    tripId = await offerTo(volunteer);
  });

  it('calls instead of texting the offer', async () => {
    await drainJobs();
    const rows = await voiceRow(tripId);
    const voice = rows.find((r) => r.channel === 'voice');
    expect(voice?.status).toBe('sent');
    expect(rows.some((r) => r.channel === 'sms')).toBe(false);
    expect(captured.announcements.some((c) => c.deliveryId === voice!.id && c.to === volunteer.phone)).toBe(true);
  });

  it('reads the trip and accepts on 1', async () => {
    await drainJobs();
    const voice = (await voiceRow(tripId)).find((r) => r.channel === 'voice')!;
    const first = await post(`/webhooks/twilio/voice-notify/${voice.id}`, { CallStatus: 'in-progress', AnsweredBy: 'human' });
    expect(first.status).toBe(200);
    const xml = String(first.raw.body);
    expect(xml).toMatch(/<Gather/);
    expect(xml).toMatch(/Press 1 or say yes/);

    const ans = await post(`/webhooks/twilio/voice-notify/${voice.id}/answer?r=0`, { Digits: '1' });
    expect(String(ans.raw.body)).toMatch(/is yours/);
    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.status).toBe('accepted');
    expect(trip!.assignedVolunteerId).toBe(volunteer.id);
    const [offer] = await db.select().from(tripOffers).where(eq(tripOffers.tripId, tripId));
    expect(offer!.responseChannel).toBe('voice');

    await post(`/webhooks/twilio/voice-notify/${voice.id}/status`, { CallStatus: 'completed' });
    const [after] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, voice.id));
    expect(after!.status).toBe('delivered');
    expect(after!.voiceOutcome).toBe('accepted');
  });

  it('declines on "no"', async () => {
    await drainJobs();
    const voice = (await voiceRow(tripId)).find((r) => r.channel === 'voice')!;
    const ans = await post(`/webhooks/twilio/voice-notify/${voice.id}/answer?r=0`, { SpeechResult: 'No, sorry.' });
    expect(String(ans.raw.body)).toMatch(/someone else/);
    const [offer] = await db.select().from(tripOffers).where(eq(tripOffers.tripId, tripId));
    expect(offer!.status).toBe('declined');
  });

  it('tells a late answerer the trip is taken', async () => {
    await drainJobs();
    const voice = (await voiceRow(tripId)).find((r) => r.channel === 'voice')!;
    await db.update(tripOffers).set({ status: 'superseded' }).where(eq(tripOffers.tripId, tripId));
    const first = await post(`/webhooks/twilio/voice-notify/${voice.id}`, { AnsweredBy: 'human' });
    expect(String(first.raw.body)).toMatch(/already been taken/);
  });

  it('retries once after no answer, then texts the offer', async () => {
    await drainJobs();
    const voice = (await voiceRow(tripId)).find((r) => r.channel === 'voice')!;
    await post(`/webhooks/twilio/voice-notify/${voice.id}/status`, { CallStatus: 'no-answer' });
    let [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, voice.id));
    expect(row!.status).toBe('queued');

    // Make the retry due now and run it.
    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(sql`${jobs.dedupeKey} like ${'delivery:' + voice.id + ':retry%'}`);
    await drainJobs();
    expect(captured.announcements.filter((c) => c.deliveryId === voice.id)).toHaveLength(2);

    await post(`/webhooks/twilio/voice-notify/${voice.id}/status`, { CallStatus: 'completed', AnsweredBy: 'machine_start' });
    [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, voice.id));
    expect(row!.carriedBy).toBe('sms');
    expect(row!.fallbackReason).toMatch(/texted instead/);
    await drainJobs();
    expect(captured.sms.some((m) => m.to === volunteer.phone)).toBe(true);
  });

  it('texts an urgent offer after the first missed call', async () => {
    const urgentTrip = await offerTo(volunteer, { priority: 'urgent' });
    await drainJobs();
    const voice = (await voiceRow(urgentTrip)).find((r) => r.channel === 'voice')!;
    await post(`/webhooks/twilio/voice-notify/${voice.id}/status`, { CallStatus: 'busy' });
    const [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, voice.id));
    expect(row!.carriedBy).toBe('sms');
  });

  it('texts instead of calling during quiet hours', async () => {
    const hour = Number(new Intl.DateTimeFormat('en-CA', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Toronto' }).format(new Date()));
    await setSetting(SETTING_KEYS.voiceQuietStartHour, hour, null);
    await setSetting(SETTING_KEYS.voiceQuietEndHour, (hour + 1) % 24, null);
    const quietTrip = await offerTo(volunteer);
    const rows = await voiceRow(quietTrip);
    expect(rows.some((r) => r.channel === 'voice')).toBe(false);
    expect(rows.some((r) => r.channel === 'sms')).toBe(true);
  });

  it('calls about an urgent trip even in quiet hours', async () => {
    const hour = Number(new Intl.DateTimeFormat('en-CA', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Toronto' }).format(new Date()));
    await setSetting(SETTING_KEYS.voiceQuietStartHour, hour, null);
    await setSetting(SETTING_KEYS.voiceQuietEndHour, (hour + 1) % 24, null);
    const urgentTrip = await offerTo(volunteer, { priority: 'urgent' });
    const rows = await voiceRow(urgentTrip);
    expect(rows.some((r) => r.channel === 'voice')).toBe(true);
  });

  it('sends WhatsApp offers on WhatsApp for volunteers who chose it', async () => {
    const wa = await createTestUser({ role: 'volunteer' });
    await db.update(users).set({ notificationPreference: 'whatsapp' }).where(eq(users.id, wa.id));
    const waTrip = await offerTo(wa);
    const rows = await voiceRow(waTrip);
    expect(rows.some((r) => r.channel === 'whatsapp')).toBe(true);
    expect(rows.some((r) => r.channel === 'sms')).toBe(false);
  });

  it('understands keys and simple words', () => {
    expect(parseChoice('1')).toBe('accept');
    expect(parseChoice('2')).toBe('decline');
    expect(parseChoice('9')).toBe('repeat');
    expect(parseChoice(undefined, 'Yes please')).toBe('accept');
    expect(parseChoice(undefined, "no I can't")).toBe('decline');
    expect(parseChoice(undefined, 'hmm')).toBe('none');
  });
});

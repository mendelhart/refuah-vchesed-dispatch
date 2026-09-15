import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { smsMessages, smsThreads, tripOffers } from '../db/schema.js';
import { captured } from '../services/providers/inmemory.js';

/**
 * Two-way SMS.
 *
 * The behaviour under test is mostly about what is NOT thrown away. The legacy
 * webhook understood four words; everything else got an automated help message
 * and vanished. Each test here is a message that used to disappear.
 */
describe('SMS conversations', () => {
  let dispatcher: TestUser;
  let volunteer: TestUser;
  let tripId: string;
  let code: string;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });

  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher' });
    volunteer = await createTestUser({ role: 'volunteer' });

    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await drainJobs();

    const text = captured.sms.find((m) => m.to === volunteer.phone);
    code = /YES ([A-Z0-9-]+)/.exec(text?.body ?? '')?.[1]?.replace(/-/g, '') ?? '';
  });

  let sidCounter = 0;
  const sid = () => `SM_conv_${Date.now()}_${++sidCounter}`;

  const postSms = (params: Record<string, string>) =>
    api('POST', '/webhooks/twilio/sms', {
      // Form-encoded, exactly as Twilio posts it: the raw body is what the
      // signature covers, so an object serialised as JSON would not be parsed.
      payload: new URLSearchParams(params).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'test' },
    });

  it('turns a reply that is not a command into a conversation', async () => {
    const res = await postSms({
      From: volunteer.phone,
      To: '+15145550000',
      Body: 'I can take it but I will be ten minutes late',
      MessageSid: sid(),
    });
    expect(res.status).toBe(200);

    const threads = await db.select().from(smsThreads).where(eq(smsThreads.phone, volunteer.phone));
    expect(threads.length).toBe(1);
    expect(threads[0]!.partyType).toBe('volunteer');
    expect(threads[0]!.displayName).toBe(volunteer.fullName);
    expect(threads[0]!.unreadCount).toBe(1);

    const messages = await db.select().from(smsMessages).where(eq(smsMessages.threadId, threads[0]!.id));
    expect(messages.length).toBe(1);
    expect(messages[0]!.body).toMatch(/ten minutes late/);
    expect(messages[0]!.direction).toBe('inbound');
  });

  it('does not reply with an automated help message to a real sentence', async () => {
    const res = await postSms({
      From: volunteer.phone,
      To: '+15145550000',
      Body: 'She is not ready, can you push it an hour',
      MessageSid: sid(),
    });
    // An empty TwiML response: a person will answer, not a robot.
    expect(String(res.raw.body)).toBe('<Response/>');
  });

  it('keeps one thread per number and counts unread messages on it', async () => {
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'first', MessageSid: sid() });
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'second', MessageSid: sid() });
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'third', MessageSid: sid() });

    const threads = await db.select().from(smsThreads).where(eq(smsThreads.phone, volunteer.phone));
    expect(threads.length).toBe(1);
    // Maintained by the database trigger, not by whichever code path inserted.
    expect(threads[0]!.unreadCount).toBe(3);
    expect(threads[0]!.lastInboundAt).not.toBeNull();
  });

  it('opens a thread for a number nobody recognises', async () => {
    const res = await postSms({
      From: '+15145559999',
      To: '+15145550000',
      Body: 'Hello, my mother needs a ride to the hospital tomorrow',
      MessageSid: sid(),
    });
    expect(res.status).toBe(200);

    const [thread] = await db.select().from(smsThreads).where(eq(smsThreads.phone, '+15145559999'));
    expect(thread!.partyType).toBe('unknown');
    expect(thread!.userId).toBeNull();

    // And the reply reveals nothing about who is or is not registered.
    expect(String(res.raw.body)).not.toMatch(/volunteer|registered|not found/i);
  });

  it('still accepts a trip when the reply is a command', async () => {
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: sid() });

    const [offer] = await db.select().from(tripOffers).where(eq(tripOffers.tripId, tripId));
    expect(offer!.status).toBe('accepted');
    // A command is not a conversation.
    const threads = await db.select().from(smsThreads);
    expect(threads.length).toBe(0);
  });

  it('shows the queue to a dispatcher and marks a thread read when opened', async () => {
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'running late', MessageSid: sid() });

    const queue = await api('GET', '/api/conversations', { cookie: dispatcher.cookie });
    expect(queue.status).toBe(200);
    expect(queue.body.unread).toBe(1);
    const threads = queue.body.threads as Array<{ id: string; unreadCount: number; preview: string }>;
    expect(threads[0]!.unreadCount).toBe(1);
    expect(threads[0]!.preview).toMatch(/running late/);

    const opened = await api('GET', `/api/conversations/${threads[0]!.id}`, { cookie: dispatcher.cookie });
    expect(opened.status).toBe(200);
    expect((opened.body.messages as unknown[]).length).toBe(1);

    const after = await api('GET', '/api/conversations', { cookie: dispatcher.cookie });
    expect(after.body.unread).toBe(0);
  });

  it('lets a dispatcher own a conversation so two do not answer at once', async () => {
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'question', MessageSid: sid() });
    const queue = await api('GET', '/api/conversations', { cookie: dispatcher.cookie });
    const threadId = (queue.body.threads as Array<{ id: string }>)[0]!.id;

    const claimed = await api('POST', `/api/conversations/${threadId}/claim`, { cookie: dispatcher.cookie });
    expect(claimed.status).toBe(200);
    expect((claimed.body.thread as { ownerId: string }).ownerId).toBe(dispatcher.id);

    const released = await api('POST', `/api/conversations/${threadId}/release`, { cookie: dispatcher.cookie });
    expect((released.body.thread as { ownerId: string | null }).ownerId).toBeNull();
  });

  it('sends a reply and records it on the thread', async () => {
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'what time again?', MessageSid: sid() });
    const queue = await api('GET', '/api/conversations', { cookie: dispatcher.cookie });
    const threadId = (queue.body.threads as Array<{ id: string }>)[0]!.id;

    captured.reset();
    const replied = await api('POST', `/api/conversations/${threadId}/reply`, {
      cookie: dispatcher.cookie,
      payload: { body: 'Nine in the morning — thank you!' },
    });
    expect(replied.status).toBe(200);
    await drainJobs();

    expect(captured.sms.some((m) => m.to === volunteer.phone && /Nine in the morning/.test(m.body))).toBe(true);

    const messages = await db.select().from(smsMessages).where(eq(smsMessages.threadId, threadId));
    const outbound = messages.filter((m) => m.direction === 'outbound');
    expect(outbound.length).toBe(1);
    expect(outbound[0]!.body).toMatch(/Nine in the morning/);
  });

  it('replies to an unknown number directly, since there is no user to notify', async () => {
    await postSms({ From: '+15145558888', To: '+15145550000', Body: 'is anyone there', MessageSid: sid() });
    const queue = await api('GET', '/api/conversations', { cookie: dispatcher.cookie });
    const threadId = (queue.body.threads as Array<{ id: string }>)[0]!.id;

    captured.reset();
    const replied = await api('POST', `/api/conversations/${threadId}/reply`, {
      cookie: dispatcher.cookie,
      payload: { body: 'Yes — how can we help?' },
    });
    expect(replied.status).toBe(200);
    expect(captured.sms.some((m) => m.to === '+15145558888')).toBe(true);
  });

  it('reopens a closed conversation when the person writes again', async () => {
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'first', MessageSid: sid() });
    const queue = await api('GET', '/api/conversations', { cookie: dispatcher.cookie });
    const threadId = (queue.body.threads as Array<{ id: string }>)[0]!.id;

    await api('POST', `/api/conversations/${threadId}/status`, {
      cookie: dispatcher.cookie,
      payload: { status: 'closed' },
    });

    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'actually one more thing', MessageSid: sid() });

    const [thread] = await db.select().from(smsThreads).where(eq(smsThreads.id, threadId));
    expect(thread!.status).toBe('open');
    // Closing marked the earlier message read, so only the new one is unread.
    expect(thread!.unreadCount).toBe(1);
    const all = await db.select().from(smsMessages).where(eq(smsMessages.threadId, threadId));
    expect(all.length).toBe(2);
    const threads = await db.select().from(smsThreads).where(eq(smsThreads.phone, volunteer.phone));
    expect(threads.length).toBe(1);
  });

  it('refuses a volunteer any access to the conversation queue', async () => {
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'hello', MessageSid: sid() });
    const res = await api('GET', '/api/conversations', { cookie: volunteer.cookie });
    expect(res.status).toBe(403);
  });

  it('honours a timed STOP as a snooze rather than a permanent opt-out', async () => {
    const res = await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'STOP 2H', MessageSid: sid() });
    expect(String(res.raw.body)).toMatch(/paused/i);

    const status = await api('GET', '/api/me/status', { cookie: volunteer.cookie });
    expect(status.body.mutedUntil).toBeTruthy();

    const resume = await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'START', MessageSid: sid() });
    expect(String(resume.raw.body)).toMatch(/resumed/i);
    const after = await api('GET', '/api/me/status', { cookie: volunteer.cookie });
    expect(after.body.mutedUntil).toBeFalsy();
  });

  it('is idempotent when Twilio redelivers the same conversation message', async () => {
    const id = sid();
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'only once', MessageSid: id });
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'only once', MessageSid: id });

    const threads = await db.select().from(smsThreads).where(eq(smsThreads.phone, volunteer.phone));
    const messages = await db.select().from(smsMessages).where(eq(smsMessages.threadId, threads[0]!.id));
    expect(messages.length).toBe(1);
    expect(threads[0]!.unreadCount).toBe(1);
  });
});

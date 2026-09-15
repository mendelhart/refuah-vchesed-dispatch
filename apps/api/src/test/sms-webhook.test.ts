/**
 * SMS acceptance.
 *
 * This file deliberately configures real Twilio credentials so the genuine
 * signature validator is selected, and signs its own requests the way Twilio
 * does. The legacy webhook validated nothing and identified volunteers by
 * "the last ten digits" of a spoofable caller ID, so a forged POST could
 * accept a trip as anybody.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ESM hoists imports above top-level statements, so plain assignments here
// would run *after* env.ts had already been evaluated. vi.hoisted runs first,
// which is what makes the real Twilio validator the selected provider.
vi.hoisted(() => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000';
  process.env.TWILIO_AUTH_TOKEN = 'test_auth_token_for_signature_checks';
  process.env.TWILIO_PHONE_NUMBER = '+15145550000';
  process.env.TWILIO_SKIP_SIGNATURE_VALIDATION = 'false';
});

import twilio from 'twilio';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { smsEvents, tripOffers, trips } from '../db/schema.js';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';

const WEBHOOK_URL = 'http://localhost:8080/webhooks/twilio/sms';
const AUTH_TOKEN = 'test_auth_token_for_signature_checks';

function sign(params: Record<string, string>, url = WEBHOOK_URL): string {
  return twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
}

async function postSms(params: Record<string, string>, opts: { signature?: string | null } = {}) {
  const signature = opts.signature === undefined ? sign(params) : opts.signature;
  return api('POST', '/webhooks/twilio/sms', {
    payload: new URLSearchParams(params).toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(signature ? { 'x-twilio-signature': signature } : {}),
    },
  });
}

describe('inbound SMS webhook', () => {
  let dispatcher: TestUser;
  let volunteer: TestUser;
  let other: TestUser;
  let tripId: string;
  let code: string;
  let sidCounter = 0;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });

  beforeEach(async () => {
    await resetDb();
    sidCounter += 1;
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    volunteer = await createTestUser({ role: 'volunteer' });
    other = await createTestUser({ role: 'volunteer' });

    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, {
      cookie: dispatcher.cookie, payload: { volunteerIds: [volunteer.id] },
    });
    // The code is only ever transmitted; the database keeps a hash. Recover it
    // from the notification payload the same way the volunteer receives it.
    const rows = (await db.execute(sql`
      select payload->>'code' as code from notifications
      where trip_id = ${tripId} and event = 'trip.offered' limit 1
    `)) as unknown as Array<{ code: string }>;
    code = rows[0]!.code;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });

  const sid = () => `SM${Date.now()}${sidCounter}${Math.random().toString(36).slice(2, 8)}`;

  it('accepts a correctly signed message from the right volunteer', async () => {
    const res = await postSms({
      From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: sid(),
    });
    expect(res.status).toBe(200);
    expect(String(res.raw.body)).toMatch(/Confirmed/i);

    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.status).toBe('accepted');
    expect(trip!.assignedVolunteerId).toBe(volunteer.id);
  });

  it('rejects an unsigned request and changes nothing', async () => {
    const res = await postSms(
      { From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: sid() },
      { signature: null },
    );
    expect(res.status).toBe(403);

    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.status).toBe('offered');
    expect(trip!.assignedVolunteerId).toBeNull();

    const events = await db.select().from(smsEvents).where(eq(smsEvents.outcome, 'rejected_signature'));
    expect(events).toHaveLength(1);
    expect(events[0]!.signatureValid).toBe(false);
  });

  it('rejects a tampered body whose signature no longer matches', async () => {
    const params = { From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: sid() };
    const signature = sign(params);
    const res = await postSms({ ...params, Body: `YES ${code}`, From: other.phone }, { signature });
    expect(res.status).toBe(403);
    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.status).toBe('offered');
  });

  it('refuses a valid code sent from a different volunteer’s phone', async () => {
    // The attack the legacy design allowed: hold someone else's code, or spoof
    // a number. Both the code and the sender must line up.
    const res = await postSms({
      From: other.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: sid(),
    });
    expect(res.status).toBe(200);
    expect(String(res.raw.body)).toMatch(/not valid for this number/i);

    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.status).toBe('offered');
    expect(trip!.assignedVolunteerId).toBeNull();
  });

  it('refuses an accept with no code at all', async () => {
    const res = await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'YES', MessageSid: sid() });
    expect(String(res.raw.body)).toMatch(/code/i);
    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.status).toBe('offered');
  });

  it('refuses an unknown code', async () => {
    const res = await postSms({
      From: volunteer.phone, To: '+15145550000', Body: 'YES ZZZZZZZZZZ', MessageSid: sid(),
    });
    expect(String(res.raw.body)).toMatch(/not recognised|not valid/i);
    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.status).toBe('offered');
  });

  it('refuses an expired offer', async () => {
    await db.execute(sql`
      update trip_offers set offered_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
      where trip_id = ${tripId}
    `);
    const res = await postSms({
      From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: sid(),
    });
    expect(String(res.raw.body)).toMatch(/expired/i);
    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.status).toBe('offered');
  });

  it('refuses a code that has already been used', async () => {
    const first = sid();
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: first });
    const second = await postSms({
      From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: sid(),
    });
    expect(String(second.raw.body)).toMatch(/accepted that trip first|no longer available|not valid/i);
    const accepted = await db.select().from(tripOffers).where(sql`trip_id = ${tripId} and status = 'accepted'`);
    expect(accepted).toHaveLength(1);
  });

  it('is idempotent when Twilio redelivers the same message', async () => {
    const messageSid = sid();
    const a = await postSms({ From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: messageSid });
    const b = await postSms({ From: volunteer.phone, To: '+15145550000', Body: `YES ${code}`, MessageSid: messageSid });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const accepted = await db.select().from(tripOffers).where(sql`trip_id = ${tripId} and status = 'accepted'`);
    expect(accepted).toHaveLength(1);
    const events = await db.select().from(smsEvents).where(eq(smsEvents.providerSid, messageSid));
    expect(events).toHaveLength(1);
  });

  it('records a decline without assigning anyone', async () => {
    const res = await postSms({ From: volunteer.phone, To: '+15145550000', Body: `NO ${code}`, MessageSid: sid() });
    expect(String(res.raw.body)).toMatch(/noted/i);
    const [offer] = await db.select().from(tripOffers).where(eq(tripOffers.tripId, tripId));
    expect(offer!.status).toBe('declined');
    const [trip] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(trip!.assignedVolunteerId).toBeNull();
  });

  it('answers an unknown number without revealing whether it is registered', async () => {
    const res = await postSms({ From: '+15149999999', To: '+15145550000', Body: 'YES', MessageSid: sid() });
    expect(res.status).toBe(200);
    const body = String(res.raw.body);
    expect(body).not.toMatch(/not registered|unknown|no account/i);
    const [event] = await db.select().from(smsEvents).where(eq(smsEvents.outcome, 'unmatched'));
    expect(event).toBeDefined();
  });

  it('honours STOP', async () => {
    const res = await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'STOP', MessageSid: sid() });
    expect(res.status).toBe(200);
    const [event] = await db.select().from(smsEvents).where(eq(smsEvents.outcome, 'opt_out'));
    expect(event).toBeDefined();
    expect(event!.matchedUserId).toBe(volunteer.id);
  });

  it('logs every inbound message, accepted or not', async () => {
    await postSms({ From: volunteer.phone, To: '+15145550000', Body: 'what is the address?', MessageSid: sid() });
    const events = await db.select().from(smsEvents).where(eq(smsEvents.direction, 'inbound'));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.outcome !== null)).toBe(true);
  });
});

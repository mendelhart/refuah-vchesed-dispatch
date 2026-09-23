import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { callers } from '../db/schema.js';
import { captured } from '../services/providers/inmemory.js';

/**
 * The privacy boundary, on the surfaces added for the production build.
 *
 * The rule under test everywhere here: a volunteer receives what the current
 * stage of the work requires and nothing else. Before a claim, that is an area
 * and a time. After a claim, it is the address and the callback number for that
 * one trip. It is never a searchable directory of the people this organisation
 * drives.
 */
describe('privacy boundaries', () => {
  let dispatcher: TestUser;
  let volunteer: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher' });
    volunteer = await createTestUser({ role: 'volunteer' });
    captured.reset();
  });

  it('refuses a volunteer the caller directory entirely', async () => {
    await api('POST', '/api/callers', {
      cookie: dispatcher.cookie,
      payload: { name: 'Sara Klein', primaryPhone: '514-555-9001' },
    });

    expect((await api('GET', '/api/callers', { cookie: volunteer.cookie })).status).toBe(403);
    expect((await api('GET', '/api/callers/search?q=Sara', { cookie: volunteer.cookie })).status).toBe(403);
  });

  it('lets only dispatch delete a patient, and hides them afterwards', async () => {
    const created = await api('POST', '/api/callers', {
      cookie: dispatcher.cookie,
      payload: { name: 'Rivka Stern', primaryPhone: '514-555-9002' },
    });
    const id = (created.body as { caller: { id: string } }).caller.id;
    expect((await api('DELETE', `/api/callers/${id}`, { cookie: volunteer.cookie })).status).toBe(403);
    expect((await api('DELETE', `/api/callers/${id}`, { cookie: dispatcher.cookie })).status).toBe(200);
    expect((await api('GET', `/api/callers/${id}`, { cookie: dispatcher.cookie })).status).toBe(404);
  });

  it('keeps the caller’s identity out of an offer', async () => {
    const created = await api('POST', '/api/trips', {
      cookie: dispatcher.cookie,
      payload: sampleTrip({ callerName: 'Sara Klein', callerPhone: '514-555-9001' }),
    });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await drainJobs();

    const text = captured.sms.find((m) => m.to === volunteer.phone)!.body;
    expect(text).not.toMatch(/Sara Klein/);
    expect(text).not.toMatch(/555-?9001/);
    expect(text).not.toMatch(/1234 Avenue Bernard/);
    // The street without the number is enough to judge the journey.
    expect(text).toMatch(/Avenue Bernard/);

    const seen = await api('GET', `/api/trips/${tripId}`, { cookie: volunteer.cookie });
    expect(JSON.stringify(seen.body)).not.toMatch(/Sara Klein/);
    expect(JSON.stringify(seen.body)).not.toMatch(/5559001/);
  });

  it('gives the volunteer the full details once they have claimed it', async () => {
    const created = await api('POST', '/api/trips', {
      cookie: dispatcher.cookie,
      payload: sampleTrip({
        callerName: 'Sara Klein',
        callerPhone: '514-555-9001',
        callbackNumber: '514-555-1111',
        pickupEntrance: 'Side door, ring 2B',
        pickupParking: 'Loading bay is free after 9',
      }),
    });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });

    const seen = await api('GET', `/api/trips/${tripId}`, { cookie: volunteer.cookie });
    const trip = seen.body.trip as Record<string, unknown>;
    expect(trip.callerName).toBe('Sara Klein');
    expect(trip.callbackNumber).toBe('+15145551111');
    expect(trip.pickupEntrance).toMatch(/ring 2B/);
    expect(trip.pickupParking).toMatch(/Loading bay/);
  });

  it('does not leak the caller’s ride history to the volunteer driving them', async () => {
    const [caller] = await db
      .insert(callers)
      .values({ name: 'Sara Klein', primaryPhone: '+15145559001' })
      .returning();

    const created = await api('POST', '/api/trips', {
      cookie: dispatcher.cookie,
      payload: sampleTrip({ callerId: caller!.id, callerName: 'Sara Klein', callerPhone: '514-555-9001' }),
    });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });

    // Even the volunteer currently driving her cannot open her file.
    const res = await api('GET', `/api/callers/${caller!.id}`, { cookie: volunteer.cookie });
    expect(res.status).toBe(403);
  });

  it('records every caller lookup, because a searchable list of addresses should leave a trail', async () => {
    const created = await api('POST', '/api/callers', {
      cookie: dispatcher.cookie,
      payload: { name: 'Sara Klein', primaryPhone: '514-555-9001' },
    });
    const callerId = (created.body.caller as { id: string }).id;

    await api('GET', '/api/callers/search?q=Sara', { cookie: dispatcher.cookie });
    await api('GET', `/api/callers/${callerId}`, { cookie: dispatcher.cookie });

    const audit = await api('GET', '/api/audit?limit=50', { cookie: dispatcher.cookie });
    const actions = (audit.body.events as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('caller.searched');
    expect(actions).toContain('caller.viewed');
  });

  it('matches a caller on the exact number, never on the last ten digits', async () => {
    await api('POST', '/api/callers', {
      cookie: dispatcher.cookie,
      payload: { name: 'Sara Klein', primaryPhone: '+15145559001' },
    });

    const exact = await api('GET', '/api/callers/search?q=5145559001', { cookie: dispatcher.cookie });
    expect((exact.body.results as unknown[]).length).toBe(1);

    // A different country code with the same trailing digits is a different
    // person. The legacy comparison would have matched it.
    const other = await api('GET', '/api/callers/search?q=%2B445145559001', { cookie: dispatcher.cookie });
    expect((other.body.results as unknown[]).length).toBe(0);
  });

  it('keeps a volunteer out of every administrative surface', async () => {
    const endpoints: Array<[string, string]> = [
      ['GET', '/api/templates'],
      ['GET', '/api/licences/pending'],
      ['GET', '/api/applications'],
      ['GET', '/api/conversations'],
      ['GET', '/api/recurring-rides'],
      ['GET', '/api/exports'],
      ['GET', '/api/announcements'],
      ['GET', '/api/volunteers/overview'],
      ['GET', '/api/board/context'],
      ['GET', '/api/equipment/overdue'],
    ];
    for (const [method, url] of endpoints) {
      const res = await api(method as 'GET', url, { cookie: volunteer.cookie });
      expect([403, 404]).toContain(res.status);
    }
  });

  it('lets a volunteer manage their own record and nobody else’s', async () => {
    const other = await createTestUser({ role: 'volunteer' });

    const mine = await api('PUT', '/api/me/availability', {
      cookie: volunteer.cookie,
      payload: { windows: [{ weekday: 1, startMinute: 540, endMinute: 1020 }] },
    });
    expect(mine.status).toBe(200);

    const theirs = await api('PUT', `/api/volunteers/${other.id}/availability`, {
      cookie: volunteer.cookie,
      payload: { windows: [] },
    });
    expect(theirs.status).toBe(403);
  });

  it('serves the public card check without revealing anything else', async () => {
    const card = await api('GET', '/api/me/id-card', { cookie: volunteer.cookie });
    const cardBody = card.body.card as { volunteerNumber: string; verificationCode: string };

    const check = await api('GET', `/api/id-card/verify/${cardBody.verificationCode}`);
    expect(check.status).toBe(200);
    expect(check.body.valid).toBe(true);
    expect(check.body.fullName).toBe(volunteer.fullName);
    // No phone, no email, no groups, no trips.
    expect(JSON.stringify(check.body)).not.toMatch(/@|\+1514/);
  });

  it('does not let the printed volunteer number act as the verification key', async () => {
    // The number is in large type on a badge that gets photographed at
    // reception desks. If it were also the key, one photograph would let
    // somebody count upwards and confirm the whole roster.
    const card = await api('GET', '/api/me/id-card', { cookie: volunteer.cookie });
    const cardBody = card.body.card as { volunteerNumber: string; verificationCode: string };
    expect(cardBody.verificationCode).not.toBe(cardBody.volunteerNumber);
    expect(cardBody.verificationCode.length).toBeGreaterThanOrEqual(16);

    const guess = await api('GET', `/api/id-card/verify/${cardBody.volunteerNumber}`);
    expect(guess.status === 422 || guess.body.valid === false).toBe(true);
  });

  it('reports an unknown card as simply not valid', async () => {
    const res = await api('GET', '/api/id-card/verify/0123456789abcdef0123');
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.fullName).toBeUndefined();
  });

  it('stops honouring the card of a deactivated volunteer', async () => {
    const card = await api('GET', '/api/me/id-card', { cookie: volunteer.cookie });
    const token = (card.body.card as { verificationCode: string }).verificationCode;
    expect((await api('GET', `/api/id-card/verify/${token}`)).body.valid).toBe(true);

    const admin = await createTestUser({ role: 'admin' });
    await api('POST', `/api/users/${volunteer.id}/deactivate`, {
      cookie: admin.cookie,
      payload: { reason: 'Moved away' },
    });

    const after = await api('GET', `/api/id-card/verify/${token}`);
    expect(after.body.valid).toBe(false);
  });

  it('never returns another volunteer’s licence status', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await api('PUT', '/api/me/licence', {
      cookie: volunteer.cookie,
      payload: { licenceNumber: 'B1234567890AB', frontImage: png },
    });

    const overview = await api('GET', '/api/volunteers/overview', { cookie: dispatcher.cookie });
    // A dispatcher sees the STATUS, which is operational, and never the number.
    expect(JSON.stringify(overview.body)).toMatch(/licence_status/);
    expect(JSON.stringify(overview.body)).not.toMatch(/B123456/);
  });

  it('keeps conversation history out of a volunteer’s reach', async () => {
    const res = await api('POST', '/webhooks/twilio/sms', {
      payload: new URLSearchParams({
        From: '+15145557777',
        To: '+15145550000',
        Body: 'My mother needs a ride, her name is Rivka Gold',
        MessageSid: `SM_priv_${Date.now()}`,
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'test' },
    });
    expect(res.status).toBe(200);

    const queue = await api('GET', '/api/conversations', { cookie: dispatcher.cookie });
    const threadId = (queue.body.threads as Array<{ id: string }>)[0]!.id;

    const forbidden = await api('GET', `/api/conversations/${threadId}`, { cookie: volunteer.cookie });
    expect(forbidden.status).toBe(403);
  });

  it('does not let a volunteer read an arbitrary stored file', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await api('PUT', '/api/me/licence', {
      cookie: volunteer.cookie,
      payload: { licenceNumber: 'B1234567890AB', frontImage: png },
    });
    const licence = await api('GET', '/api/me/licence', { cookie: volunteer.cookie });
    const fileId = (licence.body.licence as { frontFileId: string }).frontFileId;

    // Not even their own — file reads are an administrative action, audited
    // with a reason. A volunteer has no need to re-download their own licence.
    const res = await api('GET', `/api/files/${fileId}`, { cookie: volunteer.cookie });
    expect(res.status).toBe(403);
  });
});

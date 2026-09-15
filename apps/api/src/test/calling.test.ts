import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/client.js';
import { calls } from '../db/schema.js';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { captured } from '../services/providers/inmemory.js';

/**
 * Masked calling.
 *
 * The legacy endpoint took a phone number from the request body and a
 * `recipientType` the client chose, so any authenticated user could dial any
 * number in the world. Here the caller names a relationship and the server
 * resolves the number only if that relationship entitles them to it.
 */
describe('masked calling', () => {
  let dispatcher: TestUser;
  let volunteer: TestUser;
  let stranger: TestUser;
  let tripId: string;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });

  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    volunteer = await createTestUser({ role: 'volunteer' });
    stranger = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    tripId = (created.body.trip as { id: string }).id;
    captured.reset();
  });

  it('lets a dispatcher call the trip caller, and logs it', async () => {
    const res = await api('POST', '/api/calls', {
      cookie: dispatcher.cookie, payload: { tripId, counterparty: 'caller' },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(calls);
    expect(row!.initiatedById).toBe(dispatcher.id);
    expect(row!.counterpartyType).toBe('caller');
    expect(row!.authorizationBasis).toMatch(/dispatcher/);
    // Only the last four digits are retained.
    expect(row!.destinationLast4).toBe('9001');
    expect(JSON.stringify(row)).not.toContain('+15145559001');

    // The initiator's own phone is rung first; neither party sees the other's number.
    expect(captured.calls[0]!.initiator).toBe(dispatcher.phone);
  });

  it('refuses a volunteer who is not assigned to the trip', async () => {
    const res = await api('POST', '/api/calls', {
      cookie: stranger.cookie, payload: { tripId, counterparty: 'caller' },
    });
    expect(res.status).toBe(403);
    expect(await db.select().from(calls)).toHaveLength(0);
  });

  it('lets the assigned volunteer call the caller, but only while engaged', async () => {
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });

    const ok = await api('POST', '/api/calls', {
      cookie: volunteer.cookie, payload: { tripId, counterparty: 'caller' },
    });
    expect(ok.status).toBe(200);

    await api('POST', `/api/trips/${tripId}/complete`, { cookie: volunteer.cookie, payload: {} });
    const after = await api('POST', '/api/calls', {
      cookie: volunteer.cookie, payload: { tripId, counterparty: 'caller' },
    });
    // Access ends when the job does.
    expect(after.status).toBe(403);
  });

  it('refuses a volunteer calling the assigned volunteer', async () => {
    await api('POST', `/api/trips/${tripId}/assign`, {
      cookie: dispatcher.cookie, payload: { volunteerId: volunteer.id },
    });
    const res = await api('POST', '/api/calls', {
      cookie: stranger.cookie, payload: { tripId, counterparty: 'volunteer' },
    });
    expect(res.status).toBe(403);
  });

  it('offers no way to dial an arbitrary number', async () => {
    // There is no field for one. Anything extra is ignored by the schema.
    const res = await api('POST', '/api/calls', {
      cookie: volunteer.cookie,
      payload: { counterparty: 'contact', recipientPhone: '+19998887777', to: '+19998887777' },
    });
    expect([403, 422]).toContain(res.status);
    expect(await db.select().from(calls)).toHaveLength(0);
  });

  it('refuses a volunteer the org contact list', async () => {
    const contact = await api('POST', '/api/contacts', {
      cookie: dispatcher.cookie, payload: { name: 'Hospital desk', phone: '+15145551234' },
    });
    const contactId = (contact.body.contact as { id: string }).id;
    const res = await api('POST', '/api/calls', {
      cookie: volunteer.cookie, payload: { counterparty: 'contact', contactId },
    });
    expect(res.status).toBe(403);
  });

  it('enforces a per-user daily call cap', async () => {
    await api('PUT', '/api/settings/calling.daily_limit_per_user', {
      cookie: (await createTestUser({ role: 'admin', groups: [] })).cookie, payload: { value: 2 },
    });
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await api('POST', '/api/calls', {
        cookie: dispatcher.cookie, payload: { tripId, counterparty: 'caller' },
      }));
    }
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThan(0);
  });

  it('shows the call log with names, durations and inline failure reasons', async () => {
    await api('POST', '/api/calls', { cookie: dispatcher.cookie, payload: { tripId, counterparty: 'caller' } });
    await db.update(calls).set({ status: 'no_answer', durationSeconds: 0 });
    const res = await api('GET', '/api/calls', { cookie: dispatcher.cookie });
    const row = (res.body.calls as Array<Record<string, unknown>>)[0]!;
    expect(row.outcomeLabel).toBe('No answer');
    expect(row.durationLabel).toBe('—'); // never connected is not "0s"
    expect(String(row.counterparty)).not.toMatch(/\+1514555900/);
  });

  it('scopes the call log: a volunteer sees only their own calls', async () => {
    await api('POST', '/api/calls', { cookie: dispatcher.cookie, payload: { tripId, counterparty: 'caller' } });
    const res = await api('GET', '/api/calls', { cookie: stranger.cookie });
    expect((res.body.calls as unknown[])).toHaveLength(0);
  });

  it('requires the initiator to have a phone number on file', async () => {
    const noPhone = await createTestUser({ role: 'dispatcher', groups: [] });
    await db.execute(
      (await import('drizzle-orm')).sql`update users set phone = null where id = ${noPhone.id}`,
    );
    const res = await api('POST', '/api/calls', {
      cookie: noPhone.cookie, payload: { tripId, counterparty: 'caller' },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/phone number/i);
  });
});

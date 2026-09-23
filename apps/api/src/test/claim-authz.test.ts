import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tripAssignments, tripOffers, trips } from '../db/schema.js';
import { hashToken } from '../lib/crypto.js';
import { generateOfferCode } from '../lib/offer-code.js';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';

/**
 * Spec §6: a volunteer accepting their own offer and a coordinator/admin
 * assigning someone are two different acts, on two different paths.
 */
describe('claim vs assign authorization', () => {
  let dispatcher: TestUser;
  let admin: TestUser;
  let v1: TestUser;
  let v2: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    admin = await createTestUser({ role: 'admin', groups: [] });
    v1 = await createTestUser({ role: 'volunteer' });
    v2 = await createTestUser({ role: 'volunteer' });
  });

  async function offered(): Promise<string> {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    const r = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(r.body.offered).toBe(2);
    return tripId;
  }

  /** Give v's pending offer a code we know (the real one is only ever sent, never stored). */
  async function codeFor(tripId: string, v: TestUser): Promise<string> {
    const code = generateOfferCode();
    await db.update(tripOffers).set({ tokenHash: hashToken(code) })
      .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.volunteerId, v.id)));
    return code;
  }

  const tripRow = async (id: string) => (await db.select().from(trips).where(eq(trips.id, id)))[0]!;

  it('volunteer claims own offer: allowed', async () => {
    const tripId = await offered();
    const r = await api('POST', `/api/trips/${tripId}/claim`, { cookie: v1.cookie, payload: {} });
    expect(r.status).toBe(200);
    expect((await tripRow(tripId)).assignedVolunteerId).toBe(v1.id);
  });

  it("volunteer using another volunteer's code: denied, nothing changes", async () => {
    const tripId = await offered();
    const code = await codeFor(tripId, v2);
    const r = await api('POST', '/api/offers/accept', { cookie: v1.cookie, payload: { code } });
    expect(r.status).toBe(409);
    expect((r.body.error as { code: string }).code).toBe('not_your_offer');
    expect((await tripRow(tripId)).status).toBe('offered');
  });

  it("coordinator using a volunteer's code on the claim path: denied and pointed to Assign", async () => {
    const tripId = await offered();
    const code = await codeFor(tripId, v1);
    const r = await api('POST', '/api/offers/accept', { cookie: dispatcher.cookie, payload: { code } });
    expect(r.status).toBe(409);
    expect((r.body.error as { message: string }).message).toMatch(/Assign/);
    const byTrip = await api('POST', `/api/trips/${tripId}/claim`, { cookie: dispatcher.cookie, payload: {} });
    expect(byTrip.status).toBe(409);
    expect((byTrip.body.error as { message: string }).message).toMatch(/Assign/);
    const row = await tripRow(tripId);
    expect(row.status).toBe('offered');
    expect(row.assignedVolunteerId).toBeNull();
  });

  it("admin using a volunteer's code on the claim path: denied too", async () => {
    const tripId = await offered();
    const code = await codeFor(tripId, v1);
    const r = await api('POST', '/api/offers/accept', { cookie: admin.cookie, payload: { code } });
    expect(r.status).toBe(409);
    expect((await tripRow(tripId)).status).toBe('offered');
  });

  it('coordinator and admin assign through the explicit path, recorded as assigned by them', async () => {
    const tripId = await offered();
    const r = await api('POST', `/api/trips/${tripId}/assign`, { cookie: dispatcher.cookie, payload: { volunteerId: v2.id } });
    expect(r.status).toBe(200);
    expect((await tripRow(tripId)).assignedVolunteerId).toBe(v2.id);
    const [a] = await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, tripId));
    expect(a!.assignedById).toBe(dispatcher.id);

    const t2 = await offered();
    const r2 = await api('POST', `/api/trips/${t2}/assign`, { cookie: admin.cookie, payload: { volunteerId: v1.id } });
    expect(r2.status).toBe(200);
  });

  it('volunteer cannot use the assign path', async () => {
    const tripId = await offered();
    const r = await api('POST', `/api/trips/${tripId}/assign`, { cookie: v1.cookie, payload: { volunteerId: v1.id } });
    expect(r.status).toBe(403);
  });

  it('expired offer: refused', async () => {
    const tripId = await offered();
    await db.update(tripOffers).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(tripOffers.tripId, tripId));
    const r = await api('POST', `/api/trips/${tripId}/claim`, { cookie: v1.cookie, payload: {} });
    expect(r.status).toBe(409);
    expect((r.body.error as { code: string }).code).toBe('expired');
  });

  it('already accepted trip: the second volunteer is told it was taken', async () => {
    const tripId = await offered();
    expect((await api('POST', `/api/trips/${tripId}/claim`, { cookie: v1.cookie, payload: {} })).status).toBe(200);
    const r = await api('POST', `/api/trips/${tripId}/claim`, { cookie: v2.cookie, payload: {} });
    expect(r.status).toBe(409);
    expect((await tripRow(tripId)).assignedVolunteerId).toBe(v1.id);
  });

  it('cancelled trip: cannot be claimed', async () => {
    const tripId = await offered();
    const c = await api('POST', `/api/trips/${tripId}/cancel`, { cookie: dispatcher.cookie, payload: { reason: 'caller cancelled' } });
    expect(c.status).toBe(200);
    const r = await api('POST', `/api/trips/${tripId}/claim`, { cookie: v1.cookie, payload: {} });
    expect(r.status).toBe(409);
    expect((await tripRow(tripId)).status).toBe('cancelled');
  });
});

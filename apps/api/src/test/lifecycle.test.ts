import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tripAssignments, tripOffers, trips } from '../db/schema.js';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';
import { captured } from '../services/providers/inmemory.js';

/**
 * The trip lifecycle, end to end, through the HTTP API.
 *
 * These are the tests the audit said would have caught essentially every
 * critical defect in the legacy application on day one.
 */
describe('trip lifecycle', () => {
  let dispatcher: TestUser;
  let volunteer: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });

  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher' });
    volunteer = await createTestUser({ role: 'volunteer' });
  });

  it('creates a trip with a unique, non-guessable reference', async () => {
    const a = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const b = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    expect(a.status).toBe(201);
    const refA = (a.body.trip as { reference: string }).reference;
    const refB = (b.body.trip as { reference: string }).reference;
    expect(refA).toMatch(/^RVC-\d{6}-\d{4}$/);
    expect(refA).not.toEqual(refB);
  });

  it('runs pending → offered → accepted → en_route → in_progress → completed', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    expect((created.body.trip as { status: string }).status).toBe('pending');

    const offered = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(offered.status).toBe(200);
    expect((offered.body.trip as { status: string }).status).toBe('offered');
    expect(offered.body.offered).toBe(1);

    const claimed = await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });
    expect(claimed.status).toBe(200);
    const trip = claimed.body.trip as { status: string; assignedVolunteer: { id: string } | null };
    expect(trip.status).toBe('accepted');

    // The defect that defined the audit: accepting must actually assign.
    expect(trip.assignedVolunteer).not.toBeNull();
    expect(trip.assignedVolunteer!.id).toBe(volunteer.id);

    for (const [path, expected] of [
      ['en-route', 'en_route'],
      ['start', 'in_progress'],
      ['complete', 'completed'],
    ] as const) {
      const res = await api('POST', `/api/trips/${tripId}/${path}`, { cookie: volunteer.cookie, payload: {} });
      expect(res.status).toBe(200);
      expect((res.body.trip as { status: string }).status).toBe(expected);
    }

    const [row] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(row!.completedAt).not.toBeNull();
    const assignments = await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, tripId));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.unassignedAt).not.toBeNull();
  });

  it('refuses a transition that the state machine does not allow', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    // pending → complete is not a legal edge.
    const res = await api('POST', `/api/trips/${tripId}/complete`, { cookie: dispatcher.cookie, payload: {} });
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe('stale_state');
  });

  it('assigns directly, preserving history across a reassignment', async () => {
    const second = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;

    await api('POST', `/api/trips/${tripId}/assign`, { cookie: dispatcher.cookie, payload: { volunteerId: volunteer.id } });
    const re = await api('POST', `/api/trips/${tripId}/reassign`, {
      cookie: dispatcher.cookie,
      payload: { volunteerId: second.id, reason: 'first volunteer unwell' },
    });
    expect(re.status).toBe(200);

    const history = await api('GET', `/api/trips/${tripId}/history`, { cookie: dispatcher.cookie });
    const assignments = history.body.events as never;
    void assignments;
    const rows = (history.body as { events: { assignments: Array<{ volunteerId: string; unassignedAt: string | null; unassignedReason: string | null }> } }).events.assignments;
    expect(rows).toHaveLength(2);
    const closed = rows.find((r) => r.unassignedAt !== null)!;
    expect(closed.volunteerId).toBe(volunteer.id);
    expect(closed.unassignedReason).toContain('unwell');
    // The outgoing volunteer is told the trip left them.
    await drainJobs();
    expect(captured.sms.some((m) => m.to === volunteer.phone && /reassigned/i.test(m.body))).toBe(true);
  });

  it('cancels with a reason and notifies the assigned volunteer', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });
    captured.reset();

    const res = await api('POST', `/api/trips/${tripId}/cancel`, {
      cookie: dispatcher.cookie,
      payload: { reason: 'Passenger rescheduled' },
    });
    expect(res.status).toBe(200);
    expect((res.body.trip as { status: string }).status).toBe('cancelled');

    await drainJobs();
    expect(captured.sms.some((m) => m.to === volunteer.phone)).toBe(true);

    const offers = await db.select().from(tripOffers).where(eq(tripOffers.tripId, tripId));
    expect(offers.every((o) => o.status !== 'pending')).toBe(true);
  });

  it('requires a cancellation reason', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    const res = await api('POST', `/api/trips/${tripId}/cancel`, { cookie: dispatcher.cookie, payload: { reason: '' } });
    expect(res.status).toBe(422);
  });

  it('expires an unanswered offer and tells the dispatchers', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: { expiresInMinutes: 1 } });

    // Wind the clock forward rather than waiting out the real window.
    const { sql } = await import('drizzle-orm');
    // Both timestamps shift, because the database enforces expires_at > offered_at.
    await db.execute(sql`
      update trip_offers
         set offered_at = now() - interval '2 hours',
             expires_at = now() - interval '1 minute'
       where trip_id = ${tripId}
    `);
    await db.execute(sql`update jobs set run_at = now() - interval '1 minute' where kind = 'offer.expire'`);
    await drainJobs();

    const [row] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(row!.status).toBe('expired');
    const [offer] = await db.select().from(tripOffers).where(eq(tripOffers.tripId, tripId));
    expect(offer!.status).toBe('expired');
  });

  it('validates the trip form and keeps the typed address verbatim', async () => {
    const bad = await api('POST', '/api/trips', {
      cookie: dispatcher.cookie,
      payload: sampleTrip({ callerName: '', callerPhone: '' }),
    });
    expect(bad.status).toBe(422);

    const typed = '742 Evergreen Terrace apt 3';
    const good = await api('POST', '/api/trips', {
      cookie: dispatcher.cookie,
      payload: sampleTrip({ pickup: { line1: typed, city: 'Montreal', province: 'QC' } }),
    });
    expect(good.status).toBe(201);
    // The legacy form rebuilt the address from parsed parts and blanked
    // anything typed freehand; line1 must survive exactly.
    expect((good.body.trip as { pickup: { line1: string } }).pickup.line1).toBe(typed);
  });

  it('refuses an edit based on a stale version', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const trip = created.body.trip as { id: string; version: number };
    await api('PATCH', `/api/trips/${trip.id}`, { cookie: dispatcher.cookie, payload: { passengerNotes: 'first edit' } });
    const stale = await api('PATCH', `/api/trips/${trip.id}`, {
      cookie: dispatcher.cookie,
      payload: { passengerNotes: 'second edit', version: trip.version },
    });
    expect(stale.status).toBe(409);
  });

  it('never hard-deletes a trip', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/cancel`, { cookie: dispatcher.cookie, payload: { reason: 'test' } });
    await api('DELETE', `/api/trips/${tripId}`, { cookie: dispatcher.cookie, payload: { reason: 'archive' } });
    const [row] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(row).toBeDefined();
    expect(row!.deletedAt).not.toBeNull();
  });

  it('records an audit event for every transition', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });
    await api('POST', `/api/trips/${tripId}/complete`, { cookie: volunteer.cookie, payload: {} });

    const audit = await api('GET', `/api/audit?entityType=trip&entityId=${tripId}`, { cookie: dispatcher.cookie });
    const actions = (audit.body.events as Array<{ action: string; actorName: string }>).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['trip.created', 'trip.offered', 'trip.claimed', 'trip.completed']),
    );
    const claim = (audit.body.events as Array<{ action: string; actorUserId: string }>).find((e) => e.action === 'trip.claimed')!;
    // The actor comes from the session, never the request body.
    expect(claim.actorUserId).toBe(volunteer.id);
  });

  it('keeps an offer for a volunteer outside the group from existing', async () => {
    const outsider = await createTestUser({ role: 'volunteer', groups: ['misamchem'] });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });

    const offers = await db.select().from(tripOffers)
      .where(and(eq(tripOffers.tripId, tripId), eq(tripOffers.volunteerId, outsider.id)));
    expect(offers).toHaveLength(0);

    const claim = await api('POST', `/api/trips/${tripId}/claim`, { cookie: outsider.cookie, payload: {} });
    expect(claim.status).toBe(409);
  });
});

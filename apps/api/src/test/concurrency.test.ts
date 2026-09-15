import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tripAssignments, tripOffers, trips } from '../db/schema.js';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';

/**
 * Concurrency.
 *
 * The audit's central finding was that nothing stopped two volunteers from
 * both "winning" the same trip. These tests fire genuinely simultaneous
 * requests — no mocking, no staggering — and assert that exactly one wins.
 */
describe('concurrent acceptance', () => {
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
  });

  async function offeredTrip(volunteerCount: number) {
    const volunteers: TestUser[] = [];
    for (let i = 0; i < volunteerCount; i += 1) {
      volunteers.push(await createTestUser({ role: 'volunteer' }));
    }
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    const offered = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(offered.body.offered).toBe(volunteerCount);
    return { tripId, volunteers };
  }

  it('two volunteers accepting at the same instant: exactly one succeeds', async () => {
    const { tripId, volunteers } = await offeredTrip(2);

    const [a, b] = await Promise.all([
      api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteers[0]!.cookie, payload: {} }),
      api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteers[1]!.cookie, payload: {} }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? volunteers[0]! : volunteers[1]!;
    const [row] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(row!.status).toBe('accepted');
    expect(row!.assignedVolunteerId).toBe(winner.id);

    // Exactly one live assignment, and exactly one accepted offer.
    const assignments = await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, tripId));
    expect(assignments).toHaveLength(1);
    const accepted = await db.select().from(tripOffers)
      .where(sql`trip_id = ${tripId} and status = 'accepted'`);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.volunteerId).toBe(winner.id);

    // The loser is told plainly, not silently ignored.
    const loser = a.status === 409 ? a : b;
    expect(JSON.stringify(loser.body)).toMatch(/accepted this trip first|no longer available/i);
  });

  it('eight volunteers accepting at once: exactly one succeeds', async () => {
    const { tripId, volunteers } = await offeredTrip(8);

    const results = await Promise.all(
      volunteers.map((v) => api('POST', `/api/trips/${tripId}/claim`, { cookie: v.cookie, payload: {} })),
    );

    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);

    const accepted = await db.select().from(tripOffers).where(sql`trip_id = ${tripId} and status = 'accepted'`);
    expect(accepted).toHaveLength(1);
    const pending = await db.select().from(tripOffers).where(sql`trip_id = ${tripId} and status = 'pending'`);
    expect(pending).toHaveLength(0);
    const assignments = await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, tripId));
    expect(assignments).toHaveLength(1);
  });

  it('the same volunteer double-tapping accept gets one assignment, not two', async () => {
    const { tripId, volunteers } = await offeredTrip(1);
    const v = volunteers[0]!;
    const [a, b] = await Promise.all([
      api('POST', `/api/trips/${tripId}/claim`, { cookie: v.cookie, payload: {} }),
      api('POST', `/api/trips/${tripId}/claim`, { cookie: v.cookie, payload: {} }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const assignments = await db.select().from(tripAssignments).where(eq(tripAssignments.tripId, tripId));
    expect(assignments).toHaveLength(1);
  });

  it('a dispatcher assigning while a volunteer accepts leaves one consistent result', async () => {
    const { tripId, volunteers } = await offeredTrip(2);
    const [claim, assign] = await Promise.all([
      api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteers[0]!.cookie, payload: {} }),
      api('POST', `/api/trips/${tripId}/assign`, {
        cookie: dispatcher.cookie,
        payload: { volunteerId: volunteers[1]!.id },
      }),
    ]);

    // Either order is acceptable; what is not acceptable is both "winning" or
    // the trip ending up with a status that implies a volunteer but has none.
    const [row] = await db.select().from(trips).where(eq(trips.id, tripId));
    expect(['accepted', 'assigned']).toContain(row!.status);
    expect(row!.assignedVolunteerId).not.toBeNull();

    const live = await db.select().from(tripAssignments)
      .where(sql`trip_id = ${tripId} and unassigned_at is null`);
    expect(live).toHaveLength(1);
    expect(live[0]!.volunteerId).toBe(row!.assignedVolunteerId);
    expect([claim.status, assign.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
  });

  it('concurrent edits do not silently overwrite each other', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const trip = created.body.trip as { id: string; version: number };
    const [a, b] = await Promise.all([
      api('PATCH', `/api/trips/${trip.id}`, { cookie: dispatcher.cookie, payload: { passengerNotes: 'A', version: trip.version } }),
      api('PATCH', `/api/trips/${trip.id}`, { cookie: dispatcher.cookie, payload: { passengerNotes: 'B', version: trip.version } }),
    ]);
    // One wins; the other is told the record moved rather than clobbering it.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import {
  api, createTestUser, drainJobs, futureDate, getApp, resetDb, sampleTrip, shutdown, type TestUser,
} from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { captured } from '../services/providers/index.js';

/**
 * Journeys: round trips, extra stops and passengers (item 3).
 * Every leg is an ordinary trip, so per-leg behaviour is tested through the
 * existing trip endpoints.
 */

const journey = (over: Record<string, unknown> = {}) => ({ trip: sampleTrip(), ...over });

async function count(table: string): Promise<number> {
  const r = await db.execute<{ n: number }>(raw.raw(`select count(*)::int as n from ${table}`));
  return Number(r[0]!.n);
}

describe('journeys', () => {
  let dispatcher: TestUser;
  let volunteer: TestUser;
  let other: TestUser;
  const original = env.MULTI_LEG_TRIPS_ENABLED;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    env.MULTI_LEG_TRIPS_ENABLED = true;
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    volunteer = await createTestUser({ role: 'volunteer' });
    other = await createTestUser({ role: 'volunteer' });
  });
  afterEach(() => { env.MULTI_LEG_TRIPS_ENABLED = original; });

  const post = (path: string, payload: unknown, who: TestUser = dispatcher, headers?: Record<string, string>) =>
    api('POST', path, { cookie: who.cookie, payload, ...(headers ? { headers } : {}) });

  it('is off by default, and every route is a 404 while off', async () => {
    expect(original).toBe(false);
    env.MULTI_LEG_TRIPS_ENABLED = false;
    expect((await post('/api/journeys', journey())).status).toBe(404);
    expect((await api('GET', '/api/journeys/awaiting-return', { cookie: dispatcher.cookie })).status).toBe(404);
    const trip = await post('/api/trips', sampleTrip());
    const id = (trip.body.trip as { id: string }).id;
    expect((await api('GET', `/api/trips/${id}/journey`, { cookie: dispatcher.cookie })).status).toBe(404);
    expect((await api('PUT', `/api/trips/${id}/passengers`, { cookie: dispatcher.cookie, payload: { passengers: [] } })).status).toBe(404);
    expect(await count('trip_journeys')).toBe(0);
  });

  it('a volunteer is refused (403) whether or not the feature is on', async () => {
    expect((await post('/api/journeys', journey(), volunteer)).status).toBe(403);
    env.MULTI_LEG_TRIPS_ENABLED = false;
    expect((await post('/api/journeys', journey(), volunteer)).status).toBe(403);
  });

  it('a round trip with a set time makes two rides, the second going back the other way', async () => {
    const res = await post('/api/journeys', journey({
      return: { mode: 'scheduled', pickupAt: futureDate(8) },
      passengers: [{ name: 'Sara Klein', mobilityNeeds: ['wheelchair'], seats: 1 }, { name: 'Her daughter', seats: 1 }],
    }));
    expect(res.status).toBe(201);
    const j = res.body.journey as { kind: string; legs: Array<{ from: string; to: string; isReturn: boolean; tripId: string }>; seatsNeeded: number };
    expect(j.kind).toBe('round_trip');
    expect(j.legs).toHaveLength(2);
    expect(j.legs[1]!.isReturn).toBe(true);
    expect(j.legs[1]!.from).toBe(j.legs[0]!.to);
    expect(j.legs[1]!.to).toBe(j.legs[0]!.from);
    expect(j.seatsNeeded).toBe(2);
    expect(await count('trip_passengers')).toBe(4); // two on each leg
    expect(await count('trips')).toBe(2);
  });

  it('extra stops make one ride per stretch, in order, and stops must move forward in time', async () => {
    const res = await post('/api/journeys', journey({
      stops: [
        { address: { line1: '5600 Avenue Durocher', city: 'Montreal' }, departAt: futureDate(5) },
        { address: { line1: '1650 Avenue Cedar', city: 'Montreal' }, departAt: futureDate(6) },
      ],
    }));
    expect(res.status).toBe(201);
    const j = res.body.journey as { kind: string; legs: Array<{ from: string; to: string; pickupAt: string }> };
    expect(j.kind).toBe('multi_stop');
    expect(j.legs.map((l) => [l.from, l.to])).toEqual([
      ['1234 Avenue Bernard', '5600 Avenue Durocher'],
      ['5600 Avenue Durocher', '1650 Avenue Cedar'],
      ['1650 Avenue Cedar', '3755 Chemin de la Côte-Sainte-Catherine'],
    ]);
    const bad = await post('/api/journeys', journey({
      stops: [{ address: { line1: '5600 Avenue Durocher' }, departAt: futureDate(1) }],
    }));
    expect(bad.status).toBe(422);
    expect(await count('trips')).toBe(3);
  });

  it('call when ready: no ride home until the call, then exactly one', async () => {
    const res = await post('/api/journeys', journey({ return: { mode: 'call_when_ready', expectedAt: futureDate(7) } }));
    const j = res.body.journey as { id: string; legs: unknown[]; awaitingReturnCall: boolean };
    expect(j.legs).toHaveLength(1);
    expect(j.awaitingReturnCall).toBe(true);
    const waiting = await api('GET', '/api/journeys/awaiting-return', { cookie: dispatcher.cookie });
    expect((waiting.body.journeys as unknown[]).length).toBe(1);

    // Two coordinators press "ready" at the same moment.
    const [a, b] = await Promise.all([
      post(`/api/journeys/${j.id}/return-ready`, {}),
      post(`/api/journeys/${j.id}/return-ready`, {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await count('trips')).toBe(2);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 201 ? a : b;
    expect((loser.body.error as { details: { tripId: string } }).details.tripId).toBe(winner.body.tripId);

    const after = await api('GET', '/api/journeys/awaiting-return', { cookie: dispatcher.cookie });
    expect((after.body.journeys as unknown[]).length).toBe(0);
    const audit = await db.execute(raw`select 1 from audit_events where action = 'journey.return_called'`);
    expect(audit.length).toBe(1);
  });

  it('cancelling one leg leaves the others as they were', async () => {
    const res = await post('/api/journeys', journey({ return: { mode: 'scheduled', pickupAt: futureDate(8) } }));
    const legs = (res.body.journey as { id: string; legs: Array<{ tripId: string }> }).legs;
    const cancel = await post(`/api/trips/${legs[0]!.tripId}/cancel`, { reason: 'Appointment moved' });
    expect(cancel.status).toBe(200);
    const view = await api('GET', `/api/journeys/${(res.body.journey as { id: string }).id}`, { cookie: dispatcher.cookie });
    const statuses = (view.body.journey as { legs: Array<{ status: string }> }).legs.map((l) => l.status);
    expect(statuses).toEqual(['cancelled', 'pending']);
  });

  it('offers go out per leg: offering the ride there does not offer the ride home', async () => {
    const res = await post('/api/journeys', journey({ return: { mode: 'scheduled', pickupAt: futureDate(8) } }));
    const legs = (res.body.journey as { legs: Array<{ tripId: string }> }).legs;
    await post(`/api/trips/${legs[0]!.tripId}/offer`, {});
    await drainJobs();
    const offers = await db.execute<{ trip_id: string }>(raw`select distinct trip_id from trip_offers`);
    expect(offers.map((o) => o.trip_id)).toEqual([legs[0]!.tripId]);
    expect(captured.sms.filter((m) => m.to === volunteer.phone)).toHaveLength(1);
  });

  it('a driver sees only where their own leg sits, nothing about other legs', async () => {
    const res = await post('/api/journeys', journey({ return: { mode: 'scheduled', pickupAt: futureDate(8) } }));
    const legs = (res.body.journey as { legs: Array<{ tripId: string }> }).legs;
    await post(`/api/trips/${legs[1]!.tripId}/assign`, { volunteerId: volunteer.id });
    const mine = await api('GET', `/api/trips/${legs[1]!.tripId}/journey`, { cookie: volunteer.cookie });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ position: { legIndex: 1, legCount: 2 } });
    expect((await api('GET', `/api/trips/${legs[0]!.tripId}/journey`, { cookie: volunteer.cookie })).status).toBe(404);
    expect((await api('GET', `/api/trips/${legs[1]!.tripId}/journey`, { cookie: other.cookie })).status).toBe(404);
    expect((await api('GET', `/api/trips/${legs[1]!.tripId}/passengers`, { cookie: volunteer.cookie })).status).toBe(403);
  });

  describe('seats', () => {
    async function threeSeatTrip(): Promise<string> {
      const res = await post('/api/journeys', journey({
        passengers: [{ name: 'A', seats: 1 }, { name: 'B', seats: 1 }, { name: 'C', seats: 1 }],
      }));
      return (res.body.journey as { legs: Array<{ tripId: string }> }).legs[0]!.tripId;
    }

    it('refuses to assign a driver whose car is too small, with a plain reason', async () => {
      await db.execute(raw`update users set vehicle_seats = 2 where id = ${volunteer.id}`);
      const tripId = await threeSeatTrip();
      const res = await post(`/api/trips/${tripId}/assign`, { volunteerId: volunteer.id });
      expect(res.status).toBe(409);
      expect((res.body.error as { message: string }).message).toMatch(/needs 3 seats.*has 2/);
    });

    it('a driver with no seat count on file is not refused', async () => {
      const tripId = await threeSeatTrip();
      expect((await post(`/api/trips/${tripId}/assign`, { volunteerId: volunteer.id })).status).toBe(200);
    });

    it('offers skip small cars and say why', async () => {
      await db.execute(raw`update users set vehicle_seats = 2 where id = ${volunteer.id}`);
      await db.execute(raw`update users set vehicle_seats = 4 where id = ${other.id}`);
      const tripId = await threeSeatTrip();
      await post(`/api/trips/${tripId}/offer`, {});
      const offered = await db.execute<{ volunteer_id: string }>(raw`select volunteer_id from trip_offers where trip_id = ${tripId}`);
      expect(offered.map((o) => o.volunteer_id)).toEqual([other.id]);
    });

    it('existing rides with no passengers listed are unaffected, flag on or off', async () => {
      await db.execute(raw`update users set vehicle_seats = 1 where id = ${volunteer.id}`);
      const trip = await post('/api/trips', sampleTrip());
      const id = (trip.body.trip as { id: string }).id;
      expect((await post(`/api/trips/${id}/assign`, { volunteerId: volunteer.id })).status).toBe(200);
    });

    it('with the feature off, listed passengers do not block anyone', async () => {
      await db.execute(raw`update users set vehicle_seats = 2 where id = ${volunteer.id}`);
      const tripId = await threeSeatTrip();
      env.MULTI_LEG_TRIPS_ENABLED = false;
      expect((await post(`/api/trips/${tripId}/assign`, { volunteerId: volunteer.id })).status).toBe(200);
    });
  });

  it('passenger needs are added to the ride so matching asks for the right driver', async () => {
    const trip = await post('/api/trips', sampleTrip({ mobilityNeeds: [] }));
    const id = (trip.body.trip as { id: string }).id;
    const res = await api('PUT', `/api/trips/${id}/passengers`, {
      cookie: dispatcher.cookie, payload: { passengers: [{ name: 'B', mobilityNeeds: ['oxygen'], seats: 1 }] },
    });
    expect(res.status).toBe(200);
    const [row] = await db.execute<{ mobility_needs: string[] }>(raw`select mobility_needs from trips where id = ${id}`);
    expect(row!.mobility_needs).toEqual(['oxygen']);
    const list = await api('GET', `/api/trips/${id}/passengers`, { cookie: dispatcher.cookie });
    expect((list.body.passengers as Array<{ name: string }>).map((p) => p.name)).toEqual(['B']);
  });

  it('a double submit with an idempotency key makes one journey', async () => {
    const before = env.IDEMPOTENCY_KEYS_ENABLED;
    env.IDEMPOTENCY_KEYS_ENABLED = true;
    try {
      const body = journey({ return: { mode: 'scheduled', pickupAt: futureDate(8) } });
      const headers = { 'idempotency-key': 'journey-double-tap-1' };
      const [a, b] = [await post('/api/journeys', body, dispatcher, headers), await post('/api/journeys', body, dispatcher, headers)];
      expect(a.status).toBe(201);
      expect(b.raw.headers['idempotent-replayed']).toBe('true');
      expect(await count('trip_journeys')).toBe(1);
      expect(await count('trips')).toBe(2);
    } finally {
      env.IDEMPOTENCY_KEYS_ENABLED = before;
    }
  });
});

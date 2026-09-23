import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createTestUser, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';

/**
 * Authorization and privacy.
 *
 * In the legacy application every admin page was reachable by typing its URL,
 * and a volunteer's browser downloaded the 200 most recent trips — caller
 * names, phone numbers, addresses and passenger notes — then hid most of them
 * with a client-side filter. These tests assert the server refuses, rather
 * than the interface hiding.
 */
describe('authorization', () => {
  let admin: TestUser;
  let dispatcher: TestUser;
  let volunteer: TestUser;
  let otherVolunteer: TestUser;
  let tripId: string;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });

  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin', groups: [] });
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    volunteer = await createTestUser({ role: 'volunteer' });
    otherVolunteer = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    tripId = (created.body.trip as { id: string }).id;
  });

  it('rejects every protected endpoint without a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/trips'], ['POST', '/api/trips'], ['GET', '/api/trips/summary'],
      ['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/settings'],
      ['GET', '/api/me/impact'], ['POST', '/api/calls'], ['GET', '/api/contacts'],
    ] as const) {
      const res = await api(method, url, { payload: {} });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it('refuses a volunteer the dispatcher board and dispatcher-only actions', async () => {
    expect((await api('GET', '/api/trips?scope=board', { cookie: volunteer.cookie })).status).toBe(403);
    expect((await api('GET', '/api/trips/summary', { cookie: volunteer.cookie })).status).toBe(403);
    expect((await api('POST', '/api/trips', { cookie: volunteer.cookie, payload: sampleTrip() })).status).toBe(403);
    expect((await api('POST', `/api/trips/${tripId}/offer`, { cookie: volunteer.cookie, payload: {} })).status).toBe(403);
    expect((await api('POST', `/api/trips/${tripId}/assign`, { cookie: volunteer.cookie, payload: { volunteerId: volunteer.id } })).status).toBe(403);
    expect((await api('GET', '/api/contacts', { cookie: volunteer.cookie })).status).toBe(403);
    expect((await api('GET', '/api/audit', { cookie: volunteer.cookie })).status).toBe(403);
  });

  it('lets a coordinator add a volunteer, but not a coordinator or admin', async () => {
    expect((await api('POST', '/api/users', {
      cookie: dispatcher.cookie,
      payload: { fullName: 'New Driver', phone: '514 555 7090', email: '', role: 'volunteer' },
    })).status).toBe(201);
    expect((await api('POST', '/api/users', {
      cookie: dispatcher.cookie,
      payload: { email: 'c@y.test', fullName: 'C Y', role: 'dispatcher' },
    })).status).toBe(403);
  });

  it('refuses a dispatcher admin-only actions', async () => {
    expect((await api('POST', '/api/users', {
      cookie: dispatcher.cookie,
      payload: { email: 'x@y.test', fullName: 'X Y', role: 'admin' },
    })).status).toBe(403);
    expect((await api('POST', `/api/users/${volunteer.id}/role`, {
      cookie: dispatcher.cookie, payload: { role: 'admin' },
    })).status).toBe(403);
    expect((await api('POST', `/api/users/${admin.id}/deactivate`, {
      cookie: dispatcher.cookie, payload: { reason: 'x' },
    })).status).toBe(403);
  });

  it('reports which channels really send, to coordinators only', async () => {
    expect((await api('GET', '/api/messaging/status', { cookie: volunteer.cookie })).status).toBe(403);
    const res = await api('GET', '/api/messaging/status', { cookie: dispatcher.cookie });
    expect(res.status).toBe(200);
    expect((res.body.channels as Record<string, string>).email).toBe('test');
  });

  it('lets a coordinator edit, message and remove a volunteer; a volunteer cannot', async () => {
    expect((await api('PATCH', `/api/users/${otherVolunteer.id}`, {
      cookie: volunteer.cookie, payload: { fullName: 'Hijacked' },
    })).status).toBe(403);
    expect((await api('POST', `/api/users/${otherVolunteer.id}/message`, {
      cookie: volunteer.cookie, payload: { channel: 'sms', body: 'hi' },
    })).status).toBe(403);
    expect((await api('POST', `/api/users/${otherVolunteer.id}/deactivate`, {
      cookie: volunteer.cookie, payload: { reason: 'x' },
    })).status).toBe(403);

    const edit = await api('PATCH', `/api/users/${otherVolunteer.id}`, {
      cookie: dispatcher.cookie, payload: { fullName: 'Renamed Driver', email: 'renamed@driver.test' },
    });
    expect(edit.status).toBe(200);
    expect((edit.body.user as { fullName: string }).fullName).toBe('Renamed Driver');

    expect((await api('POST', `/api/users/${otherVolunteer.id}/message`, {
      cookie: dispatcher.cookie, payload: { channel: 'whatsapp', body: 'Can you drive Thursday?' },
    })).status).toBe(200);
    expect((await api('POST', `/api/users/${otherVolunteer.id}/message`, {
      cookie: dispatcher.cookie, payload: { channel: 'sms', body: 'Can you drive Thursday?' },
    })).status).toBe(200);

    expect((await api('POST', `/api/users/${otherVolunteer.id}/suspend`, {
      cookie: volunteer.cookie, payload: {},
    })).status).toBe(403);
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const paused = await api('POST', `/api/users/${otherVolunteer.id}/suspend`, {
      cookie: dispatcher.cookie, payload: { until, reason: 'Away for a week' },
    });
    expect(paused.status).toBe(200);
    expect((paused.body.user as { status: string }).status).toBe('inactive');
    expect((await api('POST', `/api/users/${admin.id}/suspend`, {
      cookie: dispatcher.cookie, payload: {},
    })).status).toBe(403);
    expect((await api('POST', `/api/users/${otherVolunteer.id}/reactivate`, {
      cookie: dispatcher.cookie, payload: {},
    })).status).toBe(200);

    expect((await api('POST', `/api/users/${otherVolunteer.id}/deactivate`, {
      cookie: dispatcher.cookie, payload: { reason: 'Moved away' },
    })).status).toBe(200);
  });

  it('will not let a volunteer promote themselves', async () => {
    const res = await api('POST', `/api/users/${volunteer.id}/role`, {
      cookie: volunteer.cookie, payload: { role: 'admin' },
    });
    expect(res.status).toBe(403);
    const me = await api('GET', '/api/auth/me', { cookie: volunteer.cookie });
    expect((me.body.user as { role: string }).role).toBe('volunteer');
  });

  it('hides a trip a volunteer has no offer for, and does not leak it in lists', async () => {
    expect((await api('GET', `/api/trips/${tripId}`, { cookie: volunteer.cookie })).status).toBe(404);

    const mine = await api('GET', '/api/trips?scope=mine', { cookie: volunteer.cookie });
    expect(mine.status).toBe(200);
    expect((mine.body.items as unknown[]).length).toBe(0);

    const available = await api('GET', '/api/trips?scope=available', { cookie: volunteer.cookie });
    // Group membership alone is not enough — an offer row must exist.
    expect((available.body.items as unknown[]).length).toBe(0);
  });

  it('withholds caller identity and the exact pickup address before a claim', async () => {
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    const available = await api('GET', '/api/trips?scope=available', { cookie: volunteer.cookie });
    const items = available.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const offered = items[0]!;

    expect(offered.callerName).toBeUndefined();
    expect(offered.callerPhone).toBeUndefined();
    expect(offered.passengerNotes).toBeUndefined();
    expect(offered.pickup).toBeUndefined();
    expect(String(offered.pickupArea)).not.toContain('1234'); // street number stripped
    expect(JSON.stringify(offered)).not.toContain('Sara Klein');
    expect(JSON.stringify(offered)).not.toContain('5559001');

    // After claiming, the volunteer gets everything they need to do the job.
    await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });
    const full = await api('GET', `/api/trips/${tripId}`, { cookie: volunteer.cookie });
    const trip = full.body.trip as unknown as import('@rvc/shared').TripDto;
    expect(trip.callerName).toBe('Sara Klein');
    expect(trip.pickup.line1).toContain('1234');
    expect(trip.dropoff.notes).toBe('Main entrance');
  });

  it('stops a volunteer acting on a trip assigned to someone else', async () => {
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await api('POST', `/api/trips/${tripId}/claim`, { cookie: volunteer.cookie, payload: {} });

    for (const path of ['en-route', 'start', 'complete']) {
      const res = await api('POST', `/api/trips/${tripId}/${path}`, { cookie: otherVolunteer.cookie, payload: {} });
      expect(res.status, path).toBe(403);
    }
    const cancel = await api('POST', `/api/trips/${tripId}/cancel`, {
      cookie: otherVolunteer.cookie, payload: { reason: 'not mine' },
    });
    expect(cancel.status).toBe(403);
  });

  it('does not give volunteers other people’s contact details in the directory', async () => {
    const asVolunteer = await api('GET', '/api/directory', { cookie: volunteer.cookie });
    const rows = asVolunteer.body.volunteers as Array<{ email: string | null; phone: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.email === null && r.phone === null)).toBe(true);

    const asDispatcher = await api('GET', '/api/directory', { cookie: dispatcher.cookie });
    const privileged = asDispatcher.body.volunteers as Array<{ email: string | null }>;
    expect(privileged.some((r) => r.email !== null)).toBe(true);
  });

  it('blocks a deactivated user immediately', async () => {
    await api('POST', `/api/users/${volunteer.id}/deactivate`, {
      cookie: admin.cookie, payload: { reason: 'left the organisation' },
    });
    const res = await api('GET', '/api/trips?scope=mine', { cookie: volunteer.cookie });
    expect(res.status).toBe(401); // the session was revoked, not just flagged
  });

  it('refuses to remove the last administrator', async () => {
    const res = await api('POST', `/api/users/${admin.id}/role`, {
      cookie: admin.cookie, payload: { role: 'volunteer' },
    });
    expect(res.status).toBe(409);
  });

  it('does not expose internal errors to the client', async () => {
    const res = await api('GET', '/api/trips/not-a-uuid', { cookie: dispatcher.cookie });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toMatch(/postgres|drizzle|at Object|node_modules/i);
  });
});

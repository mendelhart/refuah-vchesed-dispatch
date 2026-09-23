import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captured, capturedExtra } from '../services/providers/inmemory.js';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';

/**
 * Adding volunteers with only a name and phone.
 *
 * Many drivers never open the app. They must be addable in seconds, must not
 * be contacted unless an administrator ticks a channel, and must still be
 * offered rides by text.
 */
describe('volunteer creation and invites', () => {
  let admin: TestUser;
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin', groups: [] });
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
  });

  it('creates a volunteer with only name and phone, sends nothing, and still offers them trips', async () => {
    const res = await api('POST', '/api/users', {
      cookie: admin.cookie,
      payload: { fullName: 'Quiet Driver', phone: '514 555 7001', email: '' },
    });
    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toBeNull();
    const id = (res.body.user as { id: string }).id;
    await drainJobs();
    expect(captured.sms.length).toBe(0);
    expect(capturedExtra.email.length).toBe(0);
    expect(capturedExtra.whatsapp.length).toBe(0);

    const list = await api('GET', '/api/users?role=volunteer', { cookie: admin.cookie });
    const me = (list.body.users as Array<{ id: string; email: string | null; activated: boolean }>).find((u) => u.id === id);
    expect(me?.email).toBeNull();
    expect(me?.activated).toBe(false);

    const trip = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (trip.body.trip as { id: string }).id;
    const offer = await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    expect(offer.status).toBe(200);
    await drainJobs();
    expect(captured.sms.some((m) => m.to === '+15145557001')).toBe(true);
  });

  it('invites only on the ticked channels', async () => {
    const res = await api('POST', '/api/users', {
      cookie: admin.cookie,
      payload: { fullName: 'Wa Only', phone: '514 555 7002', inviteVia: ['whatsapp'] },
    });
    expect(res.status).toBe(201);
    expect(res.body.invitedVia).toEqual(['whatsapp']);
    expect(typeof res.body.inviteUrl).toBe('string');
    await drainJobs();
    expect(capturedExtra.whatsapp.some((m) => m.body.includes('accept-invite'))).toBe(true);
    expect(captured.sms.length).toBe(0);
  });

  it('requires a phone for volunteers and an email for staff', async () => {
    expect((await api('POST', '/api/users', { cookie: admin.cookie, payload: { fullName: 'No Phone' } })).status).toBe(400);
    expect((await api('POST', '/api/users', {
      cookie: admin.cookie, payload: { fullName: 'Staff Nomail', phone: '514 555 7003', role: 'dispatcher' },
    })).status).toBe(400);
    expect((await api('POST', '/api/users', {
      cookie: admin.cookie, payload: { fullName: 'Mail Tick', phone: '514 555 7004', inviteVia: ['email'] },
    })).status).toBe(400);
  });

  it('lets a phone-only volunteer finish setup and sign in with their phone', async () => {
    const res = await api('POST', '/api/users', {
      cookie: admin.cookie, payload: { fullName: 'Phone Person', phone: '514 555 7005', sendInvite: true },
    });
    const token = new URL(res.body.inviteUrl as string).searchParams.get('token');
    const accepted = await api('POST', '/api/auth/accept-invite', {
      payload: { token, password: 'AVeryLongPass123!', fullName: 'Phone Person', phone: '514 555 7005' },
    });
    expect(accepted.status).toBe(200);
    const login = await api('POST', '/api/auth/login', { payload: { email: '(514) 555-7005', password: 'AVeryLongPass123!' } });
    expect(login.status).toBe(200);
  });
});

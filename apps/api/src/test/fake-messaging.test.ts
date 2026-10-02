import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, createTestUser, drainJobs, getApp, resetDb, sampleTrip, shutdown } from './harness.js';
import {
  callingProvider, captured, channelStatus, emailProvider, pushProvider, smsProvider, whatsappProvider,
} from '../services/providers/index.js';

/**
 * Nothing in tests or CI can reach a real person.
 *
 * With no provider credentials in the environment (the CI default), every
 * outbound channel must resolve to the in-memory provider, which records what
 * would have been sent and sends nothing. If someone adds a credential to the
 * CI environment, this fails before any test can text a real number.
 */
describe('fake messaging in tests and CI', () => {
  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await resetDb(); });

  it('every outbound channel is the in-memory provider', () => {
    expect({
      sms: smsProvider.name, push: pushProvider.name, calling: callingProvider.name,
      email: emailProvider.name, whatsapp: whatsappProvider.name,
    }).toEqual({ sms: 'memory', push: 'memory', calling: 'memory', email: 'memory', whatsapp: 'memory' });
    expect(Object.values(channelStatus())).toEqual(['test', 'test', 'test', 'test']);
  });

  it('records what would have been sent, so tests can assert on it', async () => {
    const dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    const volunteer = await createTestUser({ role: 'volunteer' });
    const res = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (res.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await drainJobs();
    const sms = captured.sms.filter((m) => m.to === volunteer.phone);
    expect(sms.length).toBe(1);
    expect(sms[0]!.body.length).toBeGreaterThan(0);
    // Nothing went anywhere else: one volunteer, one offer.
    expect(new Set(captured.sms.map((m) => m.to))).toEqual(new Set([volunteer.phone]));
  });
});

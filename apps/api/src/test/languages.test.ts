import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { enabledLanguages } from '../lib/flags.js';

/** Languages (item 7): English only until a reviewed language is switched on. */
describe('languages', () => {
  let vol: TestUser;
  const original = env.LANGUAGES_ENABLED;
  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => { await resetDb(); vol = await createTestUser({ role: 'volunteer' }); });
  afterEach(() => { env.LANGUAGES_ENABLED = original; });

  it('defaults to English only', async () => {
    expect(original).toBe('en');
    expect((await api('GET', '/api/public/languages')).body).toEqual({ available: ['en'] });
    expect((await api('PUT', '/api/me/locale', { cookie: vol.cookie, payload: { locale: 'fr' } })).status).toBe(422);
  });

  it('only known languages, English always first, whatever is typed', () => {
    env.LANGUAGES_ENABLED = ' HE, xx ,fr,';
    expect(enabledLanguages()).toEqual(['en', 'fr', 'he']);
    env.LANGUAGES_ENABLED = '';
    expect(enabledLanguages()).toEqual(['en']);
  });

  it('a person picks a switched-on language; it is kept and audited', async () => {
    env.LANGUAGES_ENABLED = 'en,fr';
    const set = await api('PUT', '/api/me/locale', { cookie: vol.cookie, payload: { locale: 'fr' } });
    expect(set.status).toBe(200);
    expect((await api('GET', '/api/me/locale', { cookie: vol.cookie })).body).toEqual({ locale: 'fr', available: ['en', 'fr'] });
    expect((await api('PUT', '/api/me/locale', { cookie: vol.cookie, payload: { locale: 'he' } })).status).toBe(422);
    const audit = await db.execute(raw`select 1 from audit_events where action = 'user.locale_changed'`);
    expect(audit.length).toBe(1);
  });

  it('if a language is switched off later, that person sees English', async () => {
    env.LANGUAGES_ENABLED = 'en,he';
    await api('PUT', '/api/me/locale', { cookie: vol.cookie, payload: { locale: 'he' } });
    env.LANGUAGES_ENABLED = 'en';
    expect((await api('GET', '/api/me/locale', { cookie: vol.cookie })).body).toEqual({ locale: 'en', available: ['en'] });
  });
});

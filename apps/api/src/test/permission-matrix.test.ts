import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import { api, createTestUser, getApp, resetDb, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';

/**
 * Permission matrix: every route the server registers, for every role.
 *
 * The other authorization suites check the endpoints someone thought of. This
 * one asks the server for its whole route table and probes all of it, so an
 * endpoint added tomorrow without a guard fails here instead of shipping.
 *
 * Every route is in exactly one bucket. The default bucket is COORDINATOR
 * (dispatcher + admin), so a new route is held to that rule until somebody
 * deliberately moves it:
 *
 *   PUBLIC       no session needed (sign-in, public signup, signed webhooks)
 *   SIGNED_IN    any signed-in person, volunteers included (their own data)
 *   COORDINATOR  dispatcher and admin; a volunteer gets 403        (default)
 *   ADMIN_ONLY   admin only; a dispatcher gets 403 too
 *
 * What is asserted, per bucket:
 *   anonymous   401 on everything except PUBLIC
 *   volunteer   403 on COORDINATOR and ADMIN_ONLY, never 401/403 on SIGNED_IN
 *   dispatcher  403 on ADMIN_ONLY, never 401/403 elsewhere
 *   admin       never 401/403 anywhere
 *
 * Probes send an empty body and a random id, so a handler that does run sees
 * nothing it can act on; the database is a throwaway test database.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
interface Route { method: Method; url: string }
const key = (r: Route) => `${r.method} ${r.url}`;

const PUBLIC = new Set([
  'GET /health',
  'GET /health/deep',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/accept-invite',
  'POST /api/auth/request-password-reset',
  'POST /api/auth/reset-password',
  'GET /api/push/public-key',
  'GET /api/public/signup-options',
  'POST /api/public/volunteer-applications',
  'POST /api/public/volunteer-applications/:reference/licence',
  'GET /api/id-card/verify/:token',
  // Webhooks are authenticated by provider signature, not by session; the
  // signature checks have their own suites (sms-webhook, waha-signature).
  'POST /webhooks/waha',
  'POST /webhooks/twilio/sms',
  'POST /webhooks/twilio/sms-status',
  'POST /webhooks/twilio/voice/:callId',
  'POST /webhooks/twilio/voice-notify/:deliveryId',
  'POST /webhooks/twilio/voice-notify/:deliveryId/answer',
  'POST /webhooks/twilio/voice-notify/:deliveryId/status',
  'POST /webhooks/twilio/call-status',
]);

const SIGNED_IN = new Set([
  'GET /api/auth/me',
  'POST /api/auth/mfa/setup',
  'POST /api/auth/mfa/enable',
  'POST /api/auth/mfa/verify',
  'POST /api/auth/change-password',
  'GET /api/announcements/:id/image',
  // Trip routes a volunteer uses on their own trips; the handlers scope by
  // assignment (covered by idor.test.ts and claim-authz.test.ts).
  'GET /api/trips',
  'GET /api/trips/:id',
  'GET /api/trips/:id/journey',
  'GET /api/me/departments',
  'POST /api/trips/:id/claim',
  'POST /api/trips/:id/en-route',
  'POST /api/trips/:id/start',
  'POST /api/trips/:id/complete',
  'POST /api/trips/:id/cancel',
  'POST /api/offers/accept',
  'GET /api/organization',
  'PATCH /api/me',
  'PUT /api/me/photo',
  'DELETE /api/me/photo',
  'GET /api/me/photo',
  'DELETE /api/me/photo/pending',
  'GET /api/me/impact',
  'GET /api/me/id-card',
  'POST /api/me/id-card/reissue',
  'POST /api/me/mute',
  'GET /api/me/status',
  'GET /api/me/services',
  'PUT /api/me/services',
  'GET /api/me/availability',
  'PUT /api/me/availability',
  'POST /api/me/availability/exceptions',
  'DELETE /api/me/availability/exceptions/:id',
  'GET /api/me/capabilities',
  'PUT /api/me/capabilities',
  'GET /api/me/licence',
  'PUT /api/me/licence',
  'POST /api/push/subscribe',
  'POST /api/push/unsubscribe',
  // Role-scoped lists: a volunteer gets a narrowed view (privacy.test.ts).
  'GET /api/users',
  'GET /api/users/:id/photo',
  'GET /api/groups',
  'GET /api/directory',
  'GET /api/duty',
  'GET /api/calls',
  'POST /api/calls',
  'GET /api/calendar/zmanim',
  'GET /api/calendar/hebrew',
  'GET /api/calendar/rest-periods',
  'GET /api/notifications',
  'POST /api/notifications/read',
  'GET /api/services',
  'GET /api/features',
  'GET /api/vehicles',
  'GET /api/equipment',
  'GET /api/equipment/categories',
  'GET /api/events/stream',
]);

const ADMIN_ONLY = new Set([
  'GET /api/admin/health',
  'GET /api/admin/backup/status',
  'POST /api/admin/backup/download',
  'POST /api/admin/view-as/:id',
  'GET /api/admin/data-fixes/never-set-up',
  'GET /api/admin/data-fixes/trips/by-reference/:reference',
  'POST /api/admin/data-fixes/trips/:id/outcome',
  'POST /api/applications/:id/reject',
  'POST /api/applications/:id/approve',
  'GET /api/templates',
  'GET /api/templates/:id',
  'PATCH /api/templates/:id',
  'POST /api/templates/:id/revert',
  'PUT /api/organization',
  'PUT /api/users/:id/photo',
  'DELETE /api/users/:id/photo',
  'POST /api/users/:id/password-reset',
  'POST /api/users/:id/mfa/reset',
  'POST /api/users/:id/role',
  'POST /api/users/:id/resend-invite',
  'PUT /api/settings/:key',
  'GET /api/departments',
  'PUT /api/departments/:slug/members',
  'GET /api/files/:id',
  'GET /api/exports',
  'POST /api/exports',
  'GET /api/exports/:id/download',
  'GET /api/licences/pending',
  'POST /api/licences/:id/review',
  'POST /api/licences/:id/verify',
]);

/** Query strings the probes use, where the bare route means something else.
 *  `GET /api/trips` defaults to the coordinator board; volunteers ask for
 *  their own trips with scope=mine (the board itself is refused below). */
const PROBE_QUERY: Record<string, string> = { 'GET /api/trips': '?scope=mine' };

/**
 * Routes whose handler answers 403 for a business rule rather than a role,
 * so an admin probing them with a random id is refused on purpose.
 * view-as: "you can preview active volunteers and coordinators only" — an id
 * that matches nobody is not someone you may preview.
 */
const RULE_403_FOR_ADMIN = new Set(['POST /api/admin/view-as/:id']);

/** Long-lived responses: only the anonymous refusal can be probed in-process. */
const STREAMING = new Set(['GET /api/events/stream']);

/** Reads the route table out of Fastify's own printout. */
export function parseRouteTree(tree: string): Route[] {
  const out: Route[] = [];
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const m = line.match(/^([│ ]*)[├└]── (\S+)(?: \(([^)]+)\))?\s*$/);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack[depth] = m[2]!;
    if (!m[3]) continue;
    const url = stack.join('');
    for (const method of m[3].split(', ')) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      out.push({ method: method as Method, url });
    }
  }
  return out;
}

function concrete(url: string): string {
  return url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
}

/** The role guard's own refusal (auth/guards.ts requireRole). Matching it,
 *  not just "403", proves the guard refused, not some later business rule. */
const GUARD_403 = /^This action requires: /;

async function probeFull(r: Route, cookie?: string): Promise<{ status: number; message: string }> {
  // Each probe is one request; the limiter is tested on purpose elsewhere.
  await db.execute(raw`truncate rate_limit_buckets`);
  const hasBody = r.method !== 'GET' && r.method !== 'DELETE';
  const res = await api(r.method, concrete(r.url) + (PROBE_QUERY[key(r)] ?? ''), {
    ...(cookie ? { cookie } : {}),
    ...(hasBody ? { payload: {} } : {}),
  });
  const message = (res.body as { error?: { message?: string } } | null)?.error?.message ?? '';
  return { status: res.status, message };
}

async function probe(r: Route, cookie?: string): Promise<number> {
  return (await probeFull(r, cookie)).status;
}

describe('permission matrix', () => {
  let routes: Route[] = [];
  let volunteer: TestUser;
  let dispatcher: TestUser;
  let admin: TestUser;

  beforeAll(async () => {
    const app = await getApp();
    await resetDb();
    routes = parseRouteTree(app.printRoutes({ commonPrefix: false }));
    volunteer = await createTestUser({ role: 'volunteer' });
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
    admin = await createTestUser({ role: 'admin', groups: [] });
  });
  afterAll(async () => { await shutdown(); });

  it('reads the full route table', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(routes.map(key)).toContain('POST /api/trips');
  });

  it('still refuses a volunteer the coordinator board', async () => {
    const res = await api('GET', '/api/trips?scope=board', { cookie: volunteer.cookie });
    expect(res.status).toBe(403);
  });

  it('has no stale or doubly-classified entries', () => {
    const live = new Set(routes.map(key));
    const lists = { PUBLIC, SIGNED_IN, ADMIN_ONLY, STREAMING, RULE_403_FOR_ADMIN, PROBE_QUERY: new Set(Object.keys(PROBE_QUERY)) };
    for (const [name, list] of Object.entries(lists)) {
      for (const entry of list) expect(live.has(entry), `${name} lists ${entry}, which no longer exists`).toBe(true);
    }
    for (const entry of PUBLIC) {
      expect(SIGNED_IN.has(entry) || ADMIN_ONLY.has(entry), `${entry} is in two buckets`).toBe(false);
    }
    for (const entry of SIGNED_IN) expect(ADMIN_ONLY.has(entry), `${entry} is in two buckets`).toBe(false);
  });

  it('refuses every non-public route without a session', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      if (PUBLIC.has(key(r))) continue;
      const status = await probe(r);
      if (status !== 401) wrong.push(`${key(r)} -> ${status}`);
    }
    expect(wrong, 'answered without a session (add a guard, or list it as PUBLIC)').toEqual([]);
  });

  it('refuses a volunteer every coordinator and admin route', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const k = key(r);
      if (PUBLIC.has(k) || STREAMING.has(k) || k === 'POST /api/auth/logout') continue;
      const { status, message } = await probeFull(r, volunteer.cookie);
      if (SIGNED_IN.has(k)) {
        if (status === 401 || status === 403) wrong.push(`${k} -> ${status} (should be open to volunteers)`);
      } else if (status !== 403 || !GUARD_403.test(message)) {
        wrong.push(`${k} -> ${status} "${message}" (the role guard did not refuse a volunteer; guard it, or list it as SIGNED_IN)`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('refuses a dispatcher the admin-only routes, and only those', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const k = key(r);
      if (PUBLIC.has(k) || STREAMING.has(k)) continue;
      const { status, message } = await probeFull(r, dispatcher.cookie);
      if (ADMIN_ONLY.has(k)) {
        if (status !== 403 || !GUARD_403.test(message)) wrong.push(`${k} -> ${status} "${message}" (the admin guard did not refuse a dispatcher)`);
      } else if (status === 401 || status === 403) {
        wrong.push(`${k} -> ${status} (dispatchers should reach it, or list it as ADMIN_ONLY)`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('never refuses an admin', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const k = key(r);
      if (PUBLIC.has(k) || STREAMING.has(k) || RULE_403_FOR_ADMIN.has(k)) continue;
      const status = await probe(r, admin.cookie);
      if (status === 401 || status === 403) wrong.push(`${k} -> ${status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('never answers a probe with a server error', async () => {
    // Empty bodies and unknown ids must be refused cleanly (4xx), not crash.
    const wrong: string[] = [];
    for (const r of routes) {
      const k = key(r);
      if (STREAMING.has(k)) continue;
      for (const cookie of [undefined, volunteer.cookie, dispatcher.cookie, admin.cookie]) {
        if (k === 'POST /api/auth/logout' && cookie) continue;
        const status = await probe(r, cookie);
        if (status >= 500) wrong.push(`${k} -> ${status}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

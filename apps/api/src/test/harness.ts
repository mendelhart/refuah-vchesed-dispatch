import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql as raw } from 'drizzle-orm';
import type { Role } from '@rvc/shared';
import { buildServer } from '../server.js';
import { db, closeDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { users, volunteerGroups, userGroups } from '../db/schema.js';
import { hashPassword } from '../lib/crypto.js';
import { createSession } from '../auth/session.js';
import { env } from '../env.js';
import { invalidateSettingsCache } from '../lib/settings.js';
import { bootstrapReferenceData } from '../db/bootstrap.js';
import { worker } from '../jobs/worker.js';
import {
  captured,
  capturedExtra,
  extraFaults,
  faults,
  resetMemoryObjectStore,
} from '../services/providers/inmemory.js';
import { VOLUNTEER_CAPABILITIES } from '@rvc/shared';
import { resetWhatsAppHealth } from '../services/whatsapp-failover.js';
import { pgArray } from '../lib/pg.js';

export const PASSWORD = 'TestPassword123!';

/** Full message text of an error, walking the `cause` chain. drizzle-orm
 *  >=0.45 wraps driver errors in `Failed query: ...` with the Postgres text
 *  underneath, so assertions on constraint messages must look through it. */
export function errorText(err: unknown): string {
  let text = '';
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) text += '\n' + cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  return text;
}

/** Like `expect(p).rejects.toThrow(re)` but matches against the cause chain. */
export async function rejectsWith(promise: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(errorText(err)).toMatch(re);
    return;
  }
  throw new Error(`expected the promise to reject with ${re}, but it resolved`);
}

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (app) return app;
  await runMigrations();
  app = await buildServer();
  await app.ready();
  return app;
}

export async function shutdown(): Promise<void> {
  if (app) await app.close();
  app = null;
  await closeDb();
}

/** Wipes every table between tests. Truncate rather than delete so the
 *  append-only trigger on audit_events does not block cleanup. */
export async function resetDb(): Promise<void> {
  await db.execute(raw`
    truncate table
      audit_events, notification_deliveries, notifications, push_subscriptions,
      sms_events, sms_messages, sms_threads, calls,
      trip_offers, trip_assignments, recurring_ride_occurrences, recurring_rides,
      trips, caller_addresses, callers, addresses,
      availability_rules, availability_exceptions, volunteer_services, service_types,
      driver_licences, volunteer_applications, stored_files, stored_file_blobs, data_exports, announcements,
      duty_shifts, message_template_versions, message_templates,
      equipment_loans, equipment, equipment_categories, vehicles, contacts,
      rate_limit_buckets, idempotency_keys, organization_info, jobs, auth_tokens, sessions, user_groups, users,
      volunteer_groups, trip_counters, sequence_counters, settings
    restart identity cascade
  `);
  invalidateSettingsCache();
  // The same reference data the application boots with: settings, groups,
  // service types and message templates. Targeting and every message depend on
  // it, so a test running without it would be testing a system that cannot
  // exist in production.
  await bootstrapReferenceData();
  captured.reset();
  capturedExtra.reset();
  resetMemoryObjectStore();
  faults.smsFailures = 0;
  faults.pushFailures = 0;
  extraFaults.emailFailures = 0;
  extraFaults.whatsappFailures = 0;
  resetWhatsAppHealth();
}

export interface TestUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  phone: string;
  cookie: string;
}

let phoneCounter = 1000;

export async function createTestUser(opts: {
  role?: Role;
  groups?: string[];
  status?: string;
  name?: string;
  phone?: string;
  login?: boolean;
  /** Defaults to every capability, so a test trip with mobility needs still
   *  finds candidates. Pass [] to exercise the capability filter. */
  capabilities?: string[];
  /** Defaults to every dispatchable service. Pass [] to exercise the opt-in filter. */
  services?: string[] | null;
}): Promise<TestUser> {
  const role = opts.role ?? 'volunteer';
  const n = ++phoneCounter;
  const email = `${role}${n}@test.local`;
  const phone = opts.phone ?? `+1514555${String(n).padStart(4, '0')}`;
  const [row] = await db
    .insert(users)
    .values({
      email,
      fullName: opts.name ?? `${role} ${n}`,
      phone,
      role,
      status: opts.status ?? 'active',
      passwordHash: await hashPassword(PASSWORD),
      notificationPreference: 'both',
      capabilities: opts.capabilities ?? [...VOLUNTEER_CAPABILITIES],
    })
    .returning();

  for (const slug of opts.groups ?? ['chesed_on_the_go']) {
    const [g] = await db.select().from(volunteerGroups).where(raw`slug = ${slug}`);
    if (g) await db.insert(userGroups).values({ userId: row!.id, groupId: g.id }).onConflictDoNothing();
  }

  // Opt in to services. Without a row here, targeting excludes the volunteer —
  // which is correct behaviour and is tested explicitly in targeting.test.ts.
  if (role === 'volunteer' && opts.services !== null) {
    const slugs = opts.services;
    await db.execute(
      slugs
        ? raw`insert into volunteer_services (user_id, service_type_id)
               select ${row!.id}::uuid, st.id from service_types st
                where st.slug = any(${pgArray(slugs)}::text[])
               on conflict do nothing`
        : raw`insert into volunteer_services (user_id, service_type_id)
               select ${row!.id}::uuid, st.id from service_types st
                where st.dispatchable and st.active
               on conflict do nothing`,
    );
  }

  let cookie = '';
  if (opts.login !== false && (opts.status ?? 'active') === 'active') {
    // Mint the session directly rather than POSTing /api/auth/login: the login
    // endpoint is deliberately rate-limited to 10 attempts per 5 minutes, and
    // that control is exercised on purpose in auth.test.ts rather than
    // accidentally throttling every other suite.
    const token = await createSession(row!.id, {});
    cookie = `${env.SESSION_COOKIE_NAME}=${token}`;
  }
  return { id: row!.id, email, fullName: row!.fullName, role, phone, cookie };
}

export async function login(email: string, password = PASSWORD): Promise<string> {
  const server = await getApp();
  const res = await server.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw2 = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  return raw2.split(';')[0]!;
}

export async function api(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {},
) {
  const server = await getApp();
  const res = await server.inject({
    method,
    url,
    ...(opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
  });
  let body: unknown = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body: body as Record<string, unknown>, raw: res };
}

/** Runs queued jobs to completion, as the real worker would. */
export async function drainJobs(): Promise<number> {
  return worker.drain();
}

export function futureDate(hours = 4): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export const sampleTrip = (over: Record<string, unknown> = {}) => ({
  callerName: 'Sara Klein',
  callerPhone: '514-555-9001',
  pickup: { line1: '1234 Avenue Bernard', city: 'Montreal', province: 'QC' },
  dropoff: { line1: '3755 Chemin de la Côte-Sainte-Catherine', city: 'Montreal', province: 'QC', notes: 'Main entrance' },
  pickupAt: futureDate(4),
  tripType: 'ride',
  priority: 'routine',
  groupSlug: 'chesed_on_the_go',
  assignmentMode: 'auto',
  mobilityNeeds: ['wheelchair'],
  passengerNotes: 'Needs help with the door.',
  ...over,
});

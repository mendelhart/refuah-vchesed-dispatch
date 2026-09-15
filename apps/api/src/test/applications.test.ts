import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql as raw } from 'drizzle-orm';
import { api, createTestUser, drainJobs, getApp, resetDb, shutdown, type TestUser } from './harness.js';
import { db } from '../db/client.js';
import { driverLicences, users, volunteerApplications, volunteerServices } from '../db/schema.js';
import { capturedExtra, captured } from '../services/providers/inmemory.js';

/**
 * Volunteer signup.
 *
 * The property every test here circles: **an applicant is not a user.** The
 * public endpoint must be able to take anything the internet throws at it
 * without that reaching the dispatch system, the volunteer directory, or a
 * login.
 */
describe('volunteer applications', () => {
  let admin: TestUser;
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    admin = await createTestUser({ role: 'admin' });
    dispatcher = await createTestUser({ role: 'dispatcher' });
    capturedExtra.reset();
    captured.reset();
  });

  const application = (over: Record<string, unknown> = {}) => ({
    fullName: 'Yehuda Brenner',
    email: 'yehuda.brenner@example.test',
    phone: '514-555-4321',
    addressLine: '4820 Avenue Van Horne',
    city: 'Montreal',
    postalCode: 'H3W 1H8',
    serviceArea: 'Outremont, Mile End, Snowdon',
    requestedServices: ['ride'],
    requestedGroups: ['chesed_on_the_go'],
    capabilities: ['walker'],
    hasVehicle: true,
    vehicleType: 'sedan',
    vehicleSeats: 4,
    availability: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
    languages: ['English', 'Yiddish'],
    notificationPreference: 'sms',
    consentContact: true,
    elapsedMs: 45_000,
    ...over,
  });

  it('rate-limits the public signup endpoint per IP', async () => {
    // The one unauthenticated write endpoint in the API. Its own limiter is
    // far tighter than the global one; a distinct IP keeps this test's window
    // separate from every other submission in the file.
    const { env } = await import('../env.js');
    const original = env.SIGNUP_MAX_PER_IP_PER_HOUR;
    env.SIGNUP_MAX_PER_IP_PER_HOUR = 2;
    try {
      const ip = { 'x-forwarded-for': '203.0.113.42' };
      const first = await api('POST', '/api/public/volunteer-applications', {
        payload: application({ phone: '514-555-1001', email: 'a1@example.test' }),
        headers: ip,
      });
      const second = await api('POST', '/api/public/volunteer-applications', {
        payload: application({ phone: '514-555-1002', email: 'a2@example.test' }),
        headers: ip,
      });
      const third = await api('POST', '/api/public/volunteer-applications', {
        payload: application({ phone: '514-555-1003', email: 'a3@example.test' }),
        headers: ip,
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(third.status).toBe(429);
      expect((third.body.error as { code: string }).code).toBe('rate_limited');
    } finally {
      env.SIGNUP_MAX_PER_IP_PER_HOUR = original;
    }
  });

  it('publishes the options and consent text the form needs', async () => {
    const res = await api('GET', '/api/public/signup-options');
    expect(res.status).toBe(200);
    expect((res.body.services as unknown[]).length).toBeGreaterThan(0);
    expect((res.body.consent as { text: string }).text).toMatch(/text message/i);
    expect((res.body.consent as { version: string }).version).toBeTruthy();
  });

  it('accepts a signup without creating a user', async () => {
    const res = await api('POST', '/api/public/volunteer-applications', { payload: application() });
    expect(res.status).toBe(201);
    expect(String(res.body.reference)).toMatch(/^RVC-A-/);

    const rows = await db.select().from(volunteerApplications);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('submitted');
    expect(rows[0]!.consentTextVersion).toBeTruthy();
    expect(rows[0]!.consentTextAt).not.toBeNull();

    // Nothing reached the users table.
    const created = await db
      .select()
      .from(users)
      .where(raw`lower(${users.email}) = 'yehuda.brenner@example.test'`);
    expect(created.length).toBe(0);
  });

  it('refuses a signup without consent', async () => {
    const res = await api('POST', '/api/public/volunteer-applications', {
      payload: application({ consentContact: false }),
    });
    expect(res.status).toBe(422);
    expect(await db.select().from(volunteerApplications)).toHaveLength(0);
  });

  it('refuses a signup with no service chosen', async () => {
    const res = await api('POST', '/api/public/volunteer-applications', {
      payload: application({ requestedServices: [] }),
    });
    expect(res.status).toBe(422);
  });

  it('silently absorbs a honeypot submission', async () => {
    const res = await api('POST', '/api/public/volunteer-applications', {
      payload: application({ website: 'http://spam.example' }),
    });
    // Answered as if accepted — telling a bot it was caught only teaches it.
    expect(res.status).toBe(202);
    expect(await db.select().from(volunteerApplications)).toHaveLength(0);
  });

  it('refuses a form submitted faster than a person could type it', async () => {
    const res = await api('POST', '/api/public/volunteer-applications', {
      payload: application({ elapsedMs: 400 }),
    });
    expect(res.status).toBe(422);
    expect(await db.select().from(volunteerApplications)).toHaveLength(0);
  });

  it('updates rather than duplicates when the same person submits twice', async () => {
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const second = await api('POST', '/api/public/volunteer-applications', {
      payload: application({ serviceArea: 'Outremont only' }),
    });
    expect(second.status).toBe(201);

    const rows = await db.select().from(volunteerApplications);
    expect(rows.length).toBe(1);
    expect(rows[0]!.serviceArea).toBe('Outremont only');
  });

  it('does not reveal that a phone number already belongs to a volunteer', async () => {
    const existing = await createTestUser({ role: 'volunteer', phone: '+15145554321' });
    const res = await api('POST', '/api/public/volunteer-applications', { payload: application() });

    // Same cheerful answer as any other submission.
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/exists|already|duplicate/i);

    // But the reviewer is told.
    const [row] = await db.select().from(volunteerApplications);
    expect(row!.duplicateOfUserId).toBe(existing.id);
  });

  it('shows a reviewer the possible matches', async () => {
    const existing = await createTestUser({ role: 'volunteer', phone: '+15145554321' });
    const submitted = await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const [row] = await db.select().from(volunteerApplications);

    const detail = await api('GET', `/api/applications/${row!.id}`, { cookie: dispatcher.cookie });
    expect(detail.status).toBe(200);
    const matches = detail.body.possibleMatches as Array<{ id: string }>;
    expect(matches.some((m) => m.id === existing.id)).toBe(true);
    expect(String(submitted.body.reference)).toMatch(/^RVC-A-/);
  });

  it('refuses an unauthenticated look at the application queue', async () => {
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const res = await api('GET', '/api/applications');
    expect(res.status).toBe(401);
  });

  it('refuses a volunteer any look at the application queue', async () => {
    const volunteer = await createTestUser({ role: 'volunteer' });
    const res = await api('GET', '/api/applications', { cookie: volunteer.cookie });
    expect(res.status).toBe(403);
  });

  it('approves an application into a real volunteer, once', async () => {
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const [row] = await db.select().from(volunteerApplications);

    const approved = await api('POST', `/api/applications/${row!.id}/approve`, {
      cookie: admin.cookie,
      payload: {},
    });
    expect(approved.status).toBe(200);
    expect(String(approved.body.volunteerNumber)).toMatch(/^V\d{4}$/);

    const userId = approved.body.userId as string;
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user!.fullName).toBe('Yehuda Brenner');
    expect(user!.role).toBe('volunteer');
    expect(user!.status).toBe('active');
    expect(user!.mustChangePassword).toBe(true);
    expect(user!.capabilities).toContain('walker');
    expect(user!.applicationId).toBe(row!.id);

    // Services and availability came across.
    const services = await db.select().from(volunteerServices).where(eq(volunteerServices.userId, userId));
    expect(services.length).toBe(1);

    const availability = await api('GET', `/api/volunteers/${userId}/availability`, {
      cookie: dispatcher.cookie,
    });
    expect((availability.body.windows as unknown[]).length).toBe(1);

    // Approving twice is refused, not silently duplicated.
    const again = await api('POST', `/api/applications/${row!.id}/approve`, {
      cookie: admin.cookie,
      payload: {},
    });
    expect(again.status).toBe(409);
  });

  it('sends the approved volunteer an invitation they can actually use', async () => {
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const [row] = await db.select().from(volunteerApplications);
    capturedExtra.reset();

    await api('POST', `/api/applications/${row!.id}/approve`, { cookie: admin.cookie, payload: {} });
    await drainJobs();

    const email = capturedExtra.email.find((m) => m.to === 'yehuda.brenner@example.test');
    expect(email).toBeTruthy();
    const link = /https?:\/\/\S*accept-invite\?token=([A-Za-z0-9_-]+)/.exec(email!.text);
    expect(link).toBeTruthy();

    const accepted = await api('POST', '/api/auth/accept-invite', {
      payload: {
        token: link![1],
        password: 'BrandNewPassword123!',
        fullName: 'Yehuda Brenner',
        phone: '514-555-4321',
      },
    });
    expect(accepted.status).toBe(200);
  });

  it('refuses approval when the phone number already belongs to a volunteer', async () => {
    await createTestUser({ role: 'volunteer', phone: '+15145554321' });
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const [row] = await db.select().from(volunteerApplications);

    const res = await api('POST', `/api/applications/${row!.id}/approve`, {
      cookie: admin.cookie,
      payload: {},
    });
    expect(res.status).toBe(409);
    expect((res.body.error as { message: string }).message).toMatch(/already a volunteer/i);

    // And nothing was half-created.
    const [after] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, row!.id));
    expect(after!.status).toBe('submitted');
    expect(after!.convertedUserId).toBeNull();
  });

  it('rejects an application without creating anything', async () => {
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const [row] = await db.select().from(volunteerApplications);

    const res = await api('POST', `/api/applications/${row!.id}/reject`, {
      cookie: admin.cookie,
      payload: { notes: 'Outside the service area' },
    });
    expect(res.status).toBe(200);

    const [after] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, row!.id));
    expect(after!.status).toBe('rejected');
    expect(after!.reviewedById).toBe(admin.id);
    expect(after!.reviewedAt).not.toBeNull();
    expect(await db.select().from(users).where(raw`lower(${users.email}) = 'yehuda.brenner@example.test'`)).toHaveLength(0);
  });

  it('asks for more information and lets the applicant resubmit', async () => {
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const [row] = await db.select().from(volunteerApplications);

    const asked = await api('POST', `/api/applications/${row!.id}/request-info`, {
      cookie: dispatcher.cookie,
      payload: { message: 'Could you confirm which evenings you are free?' },
    });
    expect(asked.status).toBe(200);

    const [after] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, row!.id));
    expect(after!.status).toBe('info_requested');
    expect(after!.infoRequestMessage).toMatch(/evenings/);

    const resubmitted = await api('POST', '/api/public/volunteer-applications', {
      payload: application({ availabilityNote: 'Tuesday and Thursday evenings' }),
    });
    expect(resubmitted.status).toBe(201);

    const [final] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, row!.id));
    expect(final!.status).toBe('submitted');
    expect(final!.availabilityNote).toMatch(/Tuesday/);
  });

  it('refuses to let a dispatcher approve — approval is the trust boundary', async () => {
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const [row] = await db.select().from(volunteerApplications);
    const res = await api('POST', `/api/applications/${row!.id}/approve`, {
      cookie: dispatcher.cookie,
      payload: {},
    });
    expect(res.status).toBe(403);
  });

  it('scrubs the abuse-prevention fields once the person is approved', async () => {
    await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const [row] = await db.select().from(volunteerApplications);
    expect(row!.submittedIp).not.toBeNull();

    await api('POST', `/api/applications/${row!.id}/approve`, { cookie: admin.cookie, payload: {} });

    const [after] = await db.select().from(volunteerApplications).where(eq(volunteerApplications.id, row!.id));
    expect(after!.submittedIp).toBeNull();
    expect(after!.submittedUserAgent).toBeNull();
  });

  it('carries a licence submitted with the application over to the volunteer', async () => {
    const submitted = await api('POST', '/api/public/volunteer-applications', { payload: application() });
    const reference = submitted.body.reference as string;

    // A 1x1 PNG — real magic bytes, because the upload path checks them.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const upload = await api('POST', `/api/public/volunteer-applications/${reference}/licence`, {
      payload: { licenceNumber: 'B1234-567890-12', province: 'QC', expiresOn: '2030-04-01', frontImage: png },
    });
    expect(upload.status).toBe(200);

    const [row] = await db.select().from(volunteerApplications);
    const approved = await api('POST', `/api/applications/${row!.id}/approve`, {
      cookie: admin.cookie,
      payload: {},
    });

    const [licence] = await db
      .select()
      .from(driverLicences)
      .where(eq(driverLicences.userId, approved.body.userId as string));
    expect(licence).toBeTruthy();
    expect(licence!.status).toBe('pending_review');
    // Last four alphanumeric characters of B1234-567890-12.
    expect(licence!.numberLast4).toBe('9012');
    // The number itself is not readable from the row.
    expect(licence!.numberCiphertext).not.toMatch(/B1234/);
  });
});

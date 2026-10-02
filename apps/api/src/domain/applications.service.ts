import { and, asc, desc, eq, isNull, or, sql as raw } from 'drizzle-orm';
import { APPLICATION_STATUSES, SETTING_KEYS, VOLUNTEER_CAPABILITIES } from '@rvc/shared';
import { db } from '../db/client.js';
import {
  availabilityRules,
  driverLicences,
  organizationInfo,
  serviceTypes,
  userGroups,
  users,
  volunteerApplications,
  volunteerGroups,
  volunteerServices,
} from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from '../lib/audit.js';
import { normalizePhone, requirePhone } from '../lib/phone.js';
import { getNumberSetting } from '../lib/settings.js';
import { pgArray } from '../lib/pg.js';
import { notify } from '../services/notification.service.js';
import { renderTemplate } from '../services/templates.service.js';
import { issueAuthToken } from './users.service.js';
import { ensureVolunteerNumber } from './volunteer.service.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';
import { generateToken, hashToken, constantTimeEquals } from '../lib/crypto.js';

/**
 * Volunteer signup and onboarding.
 *
 * The central rule: **an applicant is not a user.** Nothing submitted through
 * the public form creates a row in `users`, can be offered a trip, can log in,
 * or appears in any directory. Conversion happens once, on approval, by an
 * administrator, in one transaction — and the application keeps a pointer to
 * the user it became, so "where did this volunteer come from?" is answerable.
 *
 * Why that is worth the extra table: the alternative, which is what most
 * systems do, is to create a `users` row with `status = 'pending'` and rely on
 * every query in the codebase remembering to exclude it. That works until one
 * query forgets, and then a stranger who filled in a web form is in the
 * volunteer directory with somebody's phone number in front of them.
 *
 * Consent text is versioned and its acceptance timestamped, because "did they
 * agree to be contacted?" is a question with a legal answer.
 */

export const CONSENT_VERSION = '2026-09-a';

export const CONSENT_TEXT = `I would like to volunteer with Refuah V'Chesed. I agree to be contacted by
text message, WhatsApp, email or phone about volunteering, and I understand I
can pause or stop those messages at any time. I understand that Refuah V'Chesed
keeps the details I have given here in order to organise volunteering, and that
I can ask for them to be corrected or removed.`;

export interface ApplicationInput {
  fullName: string;
  email: string;
  phone: string;
  addressLine?: string | null;
  city?: string | null;
  postalCode?: string | null;
  serviceArea?: string | null;
  requestedServices: string[];
  requestedGroups?: string[];
  capabilities?: string[];
  hasVehicle?: boolean;
  vehicleType?: string | null;
  vehicleSeats?: number | null;
  availabilityNote?: string | null;
  availability?: Array<{ weekday: number; startMinute: number; endMinute: number }>;
  languages?: string[];
  referredBy?: string | null;
  notes?: string | null;
  notificationPreference?: string;
  consentContact: boolean;
  consentBackgroundCheck?: boolean;
  ownershipToken?: string;
  ownershipReference?: string;
  submittedIp?: string | null;
  submittedUserAgent?: string | null;
}

export interface SubmitResult {
  reference: string;
  id: string;
  duplicate: boolean;
  ownershipToken?: string;
}

/**
 * Accepts a public signup.
 *
 * Deliberately forgiving about what it tells the submitter. A duplicate
 * application, or one from somebody who is already a volunteer, returns the
 * same cheerful acknowledgement as a new one — because the alternative turns
 * this endpoint into a way to test whether a phone number belongs to a
 * volunteer of this organisation, which is not information a stranger is
 * entitled to.
 */
export async function submitApplication(input: ApplicationInput): Promise<SubmitResult> {
  if (!env.PUBLIC_SIGNUP_ENABLED) {
    throw Errors.forbidden('Volunteer signup is closed at the moment.');
  }
  if (!input.consentContact) {
    throw Errors.validation('We need your agreement to contact you before we can take this.');
  }
  const fullName = input.fullName?.trim();
  if (!fullName || fullName.length < 2) throw Errors.validation('Please give your full name.');

  const email = input.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw Errors.validation('That email address does not look right.');
  }
  const phone = requirePhone(input.phone, 'phone');

  const services = await db
    .select({ slug: serviceTypes.slug })
    .from(serviceTypes)
    .where(eq(serviceTypes.active, true));
  const validSlugs = new Set(services.map((s) => s.slug));
  const requestedServices = (input.requestedServices ?? []).filter((s) => validSlugs.has(s));
  if (requestedServices.length === 0) {
    throw Errors.validation('Please choose at least one kind of help you would like to give.');
  }

  const capabilities = (input.capabilities ?? []).filter((c) =>
    VOLUNTEER_CAPABILITIES.includes(c as never),
  );

  const groups = await db.select({ slug: volunteerGroups.slug }).from(volunteerGroups);
  const validGroups = new Set(groups.map((g) => g.slug));
  const requestedGroups = (input.requestedGroups ?? []).filter((g) => validGroups.has(g));

  // Duplicate detection. Three signals, in order of confidence.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(isNull(users.deletedAt), or(eq(users.phone, phone), raw`lower(${users.email}) = ${email}`)))
    .limit(1);

  const windowDays = await getNumberSetting(SETTING_KEYS.applicationDuplicateWindowDays);
  const [recent] = await db
    .select({ id: volunteerApplications.id, reference: volunteerApplications.reference, status: volunteerApplications.status, tokenHash: volunteerApplications.ownershipTokenHash, expiresAt: volunteerApplications.ownershipExpiresAt })
    .from(volunteerApplications)
    .where(
      and(
        isNull(volunteerApplications.deletedAt),
        input.ownershipReference ? eq(volunteerApplications.reference, input.ownershipReference) : or(eq(volunteerApplications.phone, phone), raw`lower(${volunteerApplications.email}) = ${email}`),
        raw`${volunteerApplications.createdAt} > now() - (${windowDays} || ' days')::interval`,
      ),
    )
    .orderBy(desc(volunteerApplications.createdAt))
    .limit(1);

  // Matching an identifier is duplicate detection, never proof of ownership.
  if (recent && (recent.status === 'submitted' || recent.status === 'info_requested')) {
    const owns = input.ownershipReference === recent.reference && input.ownershipToken &&
      recent.tokenHash && recent.expiresAt && recent.expiresAt > new Date() &&
      constantTimeEquals(hashToken(input.ownershipToken), recent.tokenHash);
    if (!owns) {
      // Same generic acknowledgement, without disclosing the existing reference.
      if (input.ownershipToken || input.ownershipReference) throw Errors.validation('That application link has expired. Ask the office for a new link.');
      return { reference: 'RVC-A-RECEIVED', id: recent.id, duplicate: true };
    }
    const changed = await db
      .update(volunteerApplications)
      .set({
        fullName,
        email,
        phone,
        consentBackgroundCheck: input.consentBackgroundCheck ?? false,
        notificationPreference: input.notificationPreference ?? 'sms',
        addressLine: input.addressLine ?? null,
        city: input.city ?? null,
        postalCode: input.postalCode ?? null,
        serviceArea: input.serviceArea ?? null,
        requestedServices,
        requestedGroups,
        capabilities,
        hasVehicle: input.hasVehicle ?? false,
        vehicleType: input.vehicleType ?? null,
        vehicleSeats: input.vehicleSeats ?? null,
        availabilityNote: input.availabilityNote ?? null,
        availability: input.availability ?? null,
        languages: input.languages ?? [],
        referredBy: input.referredBy ?? null,
        notes: input.notes ?? null,
        status: 'submitted',
        updatedAt: new Date(),
      })
      .where(and(eq(volunteerApplications.id, recent.id),
        eq(volunteerApplications.ownershipTokenHash, recent.tokenHash!),
        raw`${volunteerApplications.ownershipExpiresAt} > now()`,
        raw`${volunteerApplications.status} in ('submitted','info_requested')`,
        isNull(volunteerApplications.deletedAt)))
      .returning({ id: volunteerApplications.id });
    if (!changed.length) throw Errors.conflict('That application changed. Ask the office for a new link.');

    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: 'application.resubmitted',
      entityType: 'volunteer_application',
      entityId: recent.id,
      metadata: { reference: recent.reference },
    });
    return { reference: recent.reference, id: recent.id, duplicate: true };
  }

  if (input.ownershipReference || input.ownershipToken) throw Errors.validation('That application link has expired. Ask the office for a new link.');
  const refRows = (await db.execute(
    raw`select next_application_reference() as reference`,
  )) as unknown as Array<{ reference: string }>;
  const reference = refRows[0]!.reference;

  const ownershipToken = generateToken();
  const [row] = await db
    .insert(volunteerApplications)
    .values({
      reference,
      ownershipTokenHash: hashToken(ownershipToken),
      ownershipExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      fullName,
      email,
      phone,
      addressLine: input.addressLine ?? null,
      city: input.city ?? null,
      postalCode: input.postalCode ?? null,
      serviceArea: input.serviceArea ?? null,
      requestedServices,
      requestedGroups,
      capabilities,
      hasVehicle: input.hasVehicle ?? false,
      vehicleType: input.vehicleType ?? null,
      vehicleSeats: input.vehicleSeats ?? null,
      availabilityNote: input.availabilityNote ?? null,
      availability: input.availability ?? null,
      languages: input.languages ?? [],
      referredBy: input.referredBy ?? null,
      notes: input.notes ?? null,
      notificationPreference: input.notificationPreference ?? 'sms',
      consentContact: true,
      consentBackgroundCheck: input.consentBackgroundCheck ?? false,
      consentTextAt: new Date(),
      consentTextVersion: CONSENT_VERSION,
      submittedIp: input.submittedIp ?? null,
      submittedUserAgent: input.submittedUserAgent?.slice(0, 300) ?? null,
      duplicateOfUserId: existingUser?.id ?? null,
      duplicateOfApplicationId: recent?.id ?? null,
    })
    .returning();

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: 'application.submitted',
    entityType: 'volunteer_application',
    entityId: row!.id,
    next: { reference, fullName, services: requestedServices },
    metadata: { possibleDuplicate: Boolean(existingUser || recent) },
  });

  // Tell the applicant, and tell whoever reviews these.
  await sendApplicantMessage(row!.id, 'volunteer.application_received').catch((err: unknown) =>
    logger.error({ err, applicationId: row!.id }, 'application acknowledgement failed'),
  );
  await notifyReviewers(row!).catch((err: unknown) =>
    logger.error({ err }, 'could not notify reviewers of a new application'),
  );

  return { reference, id: row!.id, duplicate: Boolean(existingUser || recent), ownershipToken };
}

async function orgName(): Promise<{ name: string; phone: string | null }> {
  const [org] = await db.select().from(organizationInfo).limit(1);
  return { name: org?.name ?? "Refuah V'Chesed", phone: org?.phone ?? null };
}

/**
 * Messages an applicant.
 *
 * Applicants have no user row, so `notify()` — which is keyed on a user — does
 * not apply. This sends directly and records the attempt in the audit trail,
 * which is the right trade: a delivery-record table keyed on users would need a
 * nullable user column, and a nullable foreign key on the notification path is
 * how "who was this sent to?" becomes unanswerable.
 */
async function sendApplicantMessage(
  applicationId: string,
  key: 'volunteer.application_received' | 'volunteer.application_approved' |
       'volunteer.application_rejected' | 'volunteer.application_info_requested',
  extra: Record<string, unknown> = {},
): Promise<void> {
  const [app] = await db
    .select()
    .from(volunteerApplications)
    .where(eq(volunteerApplications.id, applicationId))
    .limit(1);
  if (!app) return;

  const org = await orgName();
  const vars = {
    fullName: app.fullName,
    reference: app.reference,
    orgName: org.name,
    orgPhone: org.phone,
    ...extra,
  };

  const { emailProvider, smsProvider } = await import('../services/providers/index.js');

  const email = await renderTemplate(key, 'email', vars).catch(() => null);
  if (email) {
    try {
      await emailProvider.send({
        to: app.email,
        subject: email.subject ?? org.name,
        text: email.body,
      });
    } catch (err) {
      logger.error({ err, applicationId, key }, 'applicant email failed');
    }
  }

  // Only the two messages an applicant is actually waiting on also go by text.
  if (key === 'volunteer.application_received' || key === 'volunteer.application_approved') {
    const sms = await renderTemplate(key, 'sms', vars).catch(() => null);
    if (sms) {
      try {
        await smsProvider.send(app.phone, sms.body);
      } catch (err) {
        logger.error({ err, applicationId, key }, 'applicant SMS failed');
      }
    }
  }

  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: 'application.messaged',
    entityType: 'volunteer_application',
    entityId: applicationId,
    metadata: { template: key },
  });
}

async function notifyReviewers(app: { id: string; fullName: string; reference: string; phone: string; requestedServices: string[] }): Promise<void> {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.status, 'active'), isNull(users.deletedAt)));

  const rendered = await renderTemplate('admin.application_submitted', 'email', {
    fullName: app.fullName,
    reference: app.reference,
    phone: app.phone,
    services: app.requestedServices.join(', '),
    reviewUrl: `${env.APP_URL}/admin/applications/${app.id}`,
  });

  for (const admin of admins) {
    await notify({
      userId: admin.id,
      event: 'admin.application_submitted',
      title: `New volunteer application — ${app.fullName}`,
      body: rendered.body,
      subject: rendered.subject ?? `New volunteer application — ${app.fullName}`,
      payload: { applicationId: app.id },
    }).catch((err: unknown) => logger.warn({ err, adminId: admin.id }, 'reviewer notification failed'));
  }
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export async function listApplications(status = 'submitted', limit = 100) {
  const rows = await db
    .select()
    .from(volunteerApplications)
    .where(
      status === 'all'
        ? isNull(volunteerApplications.deletedAt)
        : and(isNull(volunteerApplications.deletedAt), eq(volunteerApplications.status, status)),
    )
    .orderBy(asc(volunteerApplications.createdAt))
    .limit(limit);
  return rows.map(({ ownershipTokenHash: _hash, ownershipExpiresAt: _expiry, ...row }) => { void _hash; void _expiry; return row; });
}

export async function getApplication(actor: AuditActor, id: string) {
  const [app] = await db
    .select()
    .from(volunteerApplications)
    .where(eq(volunteerApplications.id, id))
    .limit(1);
  if (!app) throw Errors.notFound('That application no longer exists.');

  const licence = (
    await db.select().from(driverLicences).where(eq(driverLicences.applicationId, id)).limit(1)
  )[0];

  // Show the reviewer why this looks like a duplicate rather than making them
  // search for it.
  const possibleMatches = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email, phone: users.phone, status: users.status })
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        or(eq(users.phone, app.phone), raw`lower(${users.email}) = lower(${app.email})`),
      ),
    )
    .limit(5);

  await recordAudit({
    actor,
    action: 'application.viewed',
    entityType: 'volunteer_application',
    entityId: id,
    metadata: { reference: app.reference },
  });

  const { ownershipTokenHash: _hash, ownershipExpiresAt: _expiry, ...safeApplication } = app;
  void _hash; void _expiry;
  return { application: safeApplication, licence: licence ?? null, possibleMatches };
}

export async function requestMoreInformation(actor: AuditActor, id: string, message: string) {
  if (!message.trim()) throw Errors.validation('Say what you need from them.');
  const [app] = await db
    .select()
    .from(volunteerApplications)
    .where(eq(volunteerApplications.id, id))
    .limit(1);
  if (!app) throw Errors.notFound('That application no longer exists.');
  if (app.status === 'approved') {
    throw Errors.conflict('That application has already been approved.');
  }

  const ownershipToken = generateToken();
  await db
    .update(volunteerApplications)
    .set({
      ownershipTokenHash: hashToken(ownershipToken),
      ownershipExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'info_requested',
      infoRequestedAt: new Date(),
      infoRequestMessage: message,
      reviewedById: actor.userId,
      updatedAt: new Date(),
    })
    .where(eq(volunteerApplications.id, id));

  await recordAudit({
    actor,
    action: 'application.info_requested',
    entityType: 'volunteer_application',
    entityId: id,
    next: { status: 'info_requested' },
    metadata: { message: message.slice(0, 500) },
  });

  await sendApplicantMessage(id, 'volunteer.application_info_requested', {
    message,
    resumeUrl: `${env.APP_URL}/volunteer/apply#ref=${encodeURIComponent(app.reference)}&token=${encodeURIComponent(ownershipToken)}`,
  });

  return { status: 'info_requested' };
}

export async function rejectApplication(actor: AuditActor, id: string, opts: { notes?: string; message?: string }) {
  const [app] = await db
    .select()
    .from(volunteerApplications)
    .where(eq(volunteerApplications.id, id))
    .limit(1);
  if (!app) throw Errors.notFound('That application no longer exists.');
  if (app.status === 'approved') {
    throw Errors.conflict('That application has already been approved; deactivate the volunteer instead.');
  }

  await db
    .update(volunteerApplications)
    .set({
      status: 'rejected',
      reviewedById: actor.userId,
      reviewedAt: new Date(),
      reviewNotes: opts.notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(volunteerApplications.id, id));

  await recordAudit({
    actor,
    action: 'application.rejected',
    entityType: 'volunteer_application',
    entityId: id,
    previous: { status: app.status },
    next: { status: 'rejected' },
    metadata: { notes: opts.notes ?? null },
  });

  await sendApplicantMessage(id, 'volunteer.application_rejected', {
    message: opts.message ?? '',
  });

  return { status: 'rejected' };
}

/**
 * Approval — the conversion.
 *
 * One transaction creates the user, their groups, their service opt-ins, their
 * availability and their volunteer number, moves any licence record across, and
 * stamps the application as converted. If any part fails, none of it happened
 * and the application is still waiting, which is a recoverable state; a
 * half-created volunteer is not.
 */
export async function approveApplication(
  actor: AuditActor,
  id: string,
  overrides: {
    role?: 'volunteer' | 'dispatcher';
    groupSlugs?: string[];
    serviceSlugs?: string[];
    notes?: string | null;
  } = {},
) {
  const result = await db.transaction(async (tx) => {
    const [app] = await tx
      .select()
      .from(volunteerApplications)
      .where(eq(volunteerApplications.id, id))
      .for('update')
      .limit(1);
    if (!app) throw Errors.notFound('That application no longer exists.');
    if (app.status === 'approved') {
      throw Errors.conflict('That application has already been approved.', {
        userId: app.convertedUserId,
      });
    }

    const phone = normalizePhone(app.phone);
    const [clash] = await tx
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(
        and(
          isNull(users.deletedAt),
          or(
            phone ? eq(users.phone, phone) : raw`false`,
            raw`lower(${users.email}) = lower(${app.email})`,
          ),
        ),
      )
      .limit(1);
    if (clash) {
      throw Errors.conflict(
        `${clash.fullName} is already a volunteer with that phone number or email. Merge them rather than creating a second record.`,
        { existingUserId: clash.id },
      );
    }

    const [user] = await tx
      .insert(users)
      .values({
        email: app.email,
        fullName: app.fullName,
        phone,
        role: overrides.role ?? 'volunteer',
        status: 'active',
        notificationPreference: app.notificationPreference,
        addressLine: app.addressLine,
        serviceArea: app.serviceArea,
        capabilities: app.capabilities,
        languages: app.languages,
        hasVehicle: app.hasVehicle,
        vehicleSeats: app.vehicleSeats,
        preferredVehicleType: app.vehicleType,
        mustChangePassword: true,
        approvedAt: new Date(),
        approvedById: actor.userId,
        applicationId: app.id,
      })
      .returning();

    const groupSlugs = overrides.groupSlugs ?? app.requestedGroups;
    if (groupSlugs.length) {
      const groups = await tx
        .select()
        .from(volunteerGroups)
        .where(raw`${volunteerGroups.slug} = any(${pgArray(groupSlugs)}::text[])`);
      if (groups.length) {
        await tx.insert(userGroups).values(groups.map((g) => ({ userId: user!.id, groupId: g.id })));
      }
    }

    const serviceSlugs = overrides.serviceSlugs ?? app.requestedServices;
    if (serviceSlugs.length) {
      const svcs = await tx
        .select()
        .from(serviceTypes)
        .where(raw`${serviceTypes.slug} = any(${pgArray(serviceSlugs)}::text[])`);
      if (svcs.length) {
        await tx.insert(volunteerServices).values(
          svcs.map((s) => ({ userId: user!.id, serviceTypeId: s.id, optedInById: actor.userId })),
        );
      }
    }

    if (app.availability?.length) {
      await tx.insert(availabilityRules).values(
        app.availability.map((w) => ({
          userId: user!.id,
          weekday: w.weekday,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
        })),
      );
    }

    // A licence submitted with the application follows the person.
    await tx
      .update(driverLicences)
      .set({ userId: user!.id, updatedAt: new Date() })
      .where(eq(driverLicences.applicationId, app.id));

    await tx
      .update(volunteerApplications)
      .set({
        status: 'approved',
        reviewedById: actor.userId,
        reviewedAt: new Date(),
        reviewNotes: overrides.notes ?? null,
        convertedUserId: user!.id,
        // The abuse-prevention fields have done their job; they are personal
        // data with no further purpose.
        submittedIp: null,
        submittedUserAgent: null,
        updatedAt: new Date(),
      })
      .where(eq(volunteerApplications.id, app.id));

    const { number: volunteerNumber } = await ensureVolunteerNumber(user!.id, tx);

    await recordAudit(
      {
        actor,
        action: 'application.approved',
        entityType: 'volunteer_application',
        entityId: app.id,
        previous: { status: app.status },
        next: { status: 'approved', userId: user!.id },
        metadata: { reference: app.reference, volunteerNumber },
      },
      tx,
    );
    await recordAudit(
      {
        actor,
        action: 'user.created',
        entityType: 'user',
        entityId: user!.id,
        next: { fullName: user!.fullName, role: user!.role, from: 'application' },
        metadata: { applicationId: app.id },
      },
      tx,
    );

    const invite = await issueAuthToken(user!.id, 'invite', 7 * 24 * 60, tx);
    return { user: user!, applicationId: app.id, inviteUrl: invite.url, volunteerNumber };
  });

  await sendApplicantMessage(result.applicationId, 'volunteer.application_approved', {
    inviteUrl: result.inviteUrl,
    expiresIn: '7 days',
  });

  return {
    userId: result.user.id,
    volunteerNumber: result.volunteerNumber,
    status: 'approved' as const,
  };
}

export async function applicationCounts(): Promise<Record<string, number>> {
  const rows = (await db.execute(raw`
    select status, count(*)::int as n
    from volunteer_applications
    where deleted_at is null
    group by status
  `)) as unknown as Array<{ status: string; n: number }>;
  const out: Record<string, number> = {};
  for (const s of APPLICATION_STATUSES) out[s] = 0;
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

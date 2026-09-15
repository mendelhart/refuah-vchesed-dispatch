import { and, eq, isNull, sql as raw } from 'drizzle-orm';
import { SETTING_KEYS } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { driverLicences, users } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { decryptField, encryptField, fieldEncryptionAvailable } from '../lib/crypto.js';
import { licenceVerificationProvider } from '../services/providers/index.js';
import { getNumberSetting } from '../lib/settings.js';
import { localDateString, addDaysToDateString } from '../lib/time.js';
import { logger } from '../lib/logger.js';

/**
 * Driver licences.
 *
 * The single most important sentence in this file: **this system does not
 * verify driver's licences.** It stores an image and a number so that a human
 * being can look at them, and it records that a human being did. A licence
 * reaches `verified` only when a contracted verification service affirmatively
 * says so and returns a reference — and the database refuses the value
 * otherwise (migration 0004), independently of this code.
 *
 * Why that matters here rather than in a comment nobody reads: an organisation
 * that believes its software checked a licence will stop checking the licence.
 * The status vocabulary is therefore deliberately blunt —
 *
 *   pending_review — submitted, nobody has looked
 *   on_file        — an administrator has seen the image. NOT a validity claim.
 *   verified       — an external service confirmed it. Carries provider + ref.
 *   rejected       — an administrator declined it
 *   expired        — the recorded expiry date has passed
 *
 * The number is encrypted at rest; only its last four characters are stored in
 * clear, which is what an administrator needs to match a record to an image.
 */

export interface LicenceInput {
  userId?: string | null;
  applicationId?: string | null;
  licenceNumber?: string | null;
  province?: string;
  country?: string;
  expiresOn?: string | null;
  frontFileId?: string | null;
  backFileId?: string | null;
}

export async function recordLicence(
  actor: AuditActor,
  input: LicenceInput,
  exec: Executor = db,
) {
  if (!input.userId && !input.applicationId) {
    throw Errors.validation('A licence must belong to a volunteer or an application.');
  }
  if (input.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn)) {
    throw Errors.validation('Expiry must be YYYY-MM-DD.');
  }

  let numberCiphertext: string | null = null;
  let numberLast4: string | null = null;
  if (input.licenceNumber?.trim()) {
    if (!fieldEncryptionAvailable()) {
      throw Errors.upstream(
        'Licence numbers cannot be stored because field encryption is not configured (FIELD_ENCRYPTION_KEY).',
      );
    }
    const clean = input.licenceNumber.replace(/\s+/g, '').toUpperCase();
    if (clean.length < 6) throw Errors.validation('That does not look like a licence number.');
    numberCiphertext = encryptField(clean);
    // Last four ALPHANUMERIC characters. Quebec licences are written with
    // hyphens, and slicing the raw string produced values like "0-12" that the
    // column's own format check rejected — correctly, since a person matching a
    // record to a photograph needs four readable characters.
    const alnum = clean.replace(/[^A-Z0-9]/g, '');
    if (alnum.length < 4) throw Errors.validation('That does not look like a licence number.');
    numberLast4 = alnum.slice(-4);
  }

  const existing = input.userId
    ? (
        await exec
          .select()
          .from(driverLicences)
          .where(and(eq(driverLicences.userId, input.userId), isNull(driverLicences.deletedAt)))
          .limit(1)
      )[0]
    : undefined;

  if (existing) {
    const [updated] = await exec
      .update(driverLicences)
      .set({
        province: input.province ?? existing.province,
        country: input.country ?? existing.country,
        expiresOn: input.expiresOn ?? existing.expiresOn,
        ...(numberCiphertext ? { numberCiphertext, numberLast4 } : {}),
        ...(input.frontFileId ? { frontFileId: input.frontFileId } : {}),
        ...(input.backFileId ? { backFileId: input.backFileId } : {}),
        // Any change to the document puts it back in the review queue. Carrying
        // a previous approval forward onto a new image is how an unreviewed
        // document ends up marked as seen.
        status: 'pending_review',
        verificationProvider: null,
        verificationReference: null,
        verifiedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(driverLicences.id, existing.id))
      .returning();

    await recordAudit(
      {
        actor,
        action: 'licence.updated',
        entityType: 'driver_licence',
        entityId: existing.id,
        previous: { status: existing.status, last4: existing.numberLast4 },
        next: { status: updated!.status, last4: updated!.numberLast4 },
      },
      exec,
    );
    return updated!;
  }

  const [row] = await exec
    .insert(driverLicences)
    .values({
      userId: input.userId ?? null,
      applicationId: input.applicationId ?? null,
      province: input.province ?? 'QC',
      country: input.country ?? 'CA',
      numberCiphertext,
      numberLast4,
      expiresOn: input.expiresOn ?? null,
      frontFileId: input.frontFileId ?? null,
      backFileId: input.backFileId ?? null,
      status: 'pending_review',
    })
    .returning();

  await recordAudit(
    {
      actor,
      action: 'licence.recorded',
      entityType: 'driver_licence',
      entityId: row!.id,
      next: { userId: input.userId, applicationId: input.applicationId, last4: numberLast4 },
    },
    exec,
  );
  return row!;
}

/**
 * An administrator's review.
 *
 * Note what this cannot do: set `verified`. The only decisions available to a
 * person are "I have seen this" (`on_file`) and "no" (`rejected`).
 */
export async function reviewLicence(
  actor: AuditActor,
  licenceId: string,
  decision: 'on_file' | 'rejected',
  notes?: string | null,
) {
  if (decision !== 'on_file' && decision !== 'rejected') {
    throw Errors.validation(
      "A review can record 'on_file' or 'rejected'. Only a verification service can mark a licence verified.",
    );
  }
  const [before] = await db
    .select()
    .from(driverLicences)
    .where(eq(driverLicences.id, licenceId))
    .limit(1);
  if (!before) throw Errors.notFound('That licence record no longer exists.');

  const [after] = await db
    .update(driverLicences)
    .set({
      status: decision,
      reviewedById: actor.userId,
      reviewedAt: new Date(),
      reviewNotes: notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(driverLicences.id, licenceId))
    .returning();

  await recordAudit({
    actor,
    action: `licence.${decision}`,
    entityType: 'driver_licence',
    entityId: licenceId,
    previous: { status: before.status },
    next: { status: decision },
    metadata: { notes: notes ?? null },
  });
  return after!;
}

/**
 * Asks the configured verification service about a licence.
 *
 * With no service configured this returns `unsupported` and changes nothing —
 * which is the honest outcome, and is what the default provider does. When a
 * service is configured and answers positively, the provider name, its
 * reference and the timestamp are written together with the status, because the
 * database will reject the row otherwise.
 */
export async function verifyLicence(actor: AuditActor, licenceId: string) {
  const [licence] = await db
    .select()
    .from(driverLicences)
    .where(eq(driverLicences.id, licenceId))
    .limit(1);
  if (!licence) throw Errors.notFound('That licence record no longer exists.');

  if (!licenceVerificationProvider.enabled) {
    await recordAudit({
      actor,
      action: 'licence.verification_unavailable',
      entityType: 'driver_licence',
      entityId: licenceId,
      metadata: { provider: licenceVerificationProvider.name },
    });
    return {
      verified: false,
      status: 'unsupported' as const,
      detail:
        'No licence verification service is configured, so nothing has been verified. The document is on file for a person to check.',
    };
  }

  const number = decryptField(licence.numberCiphertext);
  if (!number) {
    throw Errors.validation('There is no licence number on file to check.');
  }

  const holder = licence.userId
    ? (await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, licence.userId)))[0]
    : null;

  const result = await licenceVerificationProvider.verify({
    licenceNumber: number,
    province: licence.province,
    country: licence.country,
    fullName: holder?.fullName ?? '',
  });

  if (result.verified && result.reference) {
    await db
      .update(driverLicences)
      .set({
        status: 'verified',
        verificationProvider: licenceVerificationProvider.name,
        verificationReference: result.reference,
        verifiedAt: result.checkedAt,
        updatedAt: new Date(),
      })
      .where(eq(driverLicences.id, licenceId));
  }

  await recordAudit({
    actor,
    action: 'licence.verification_attempted',
    entityType: 'driver_licence',
    entityId: licenceId,
    next: { verified: result.verified, status: result.status },
    metadata: { provider: licenceVerificationProvider.name, reference: result.reference },
  });

  return { verified: result.verified, status: result.status, detail: result.detail };
}

export async function getLicenceForUser(userId: string) {
  const [row] = await db
    .select({
      id: driverLicences.id,
      province: driverLicences.province,
      numberLast4: driverLicences.numberLast4,
      expiresOn: driverLicences.expiresOn,
      status: driverLicences.status,
      frontFileId: driverLicences.frontFileId,
      backFileId: driverLicences.backFileId,
      reviewedAt: driverLicences.reviewedAt,
      verificationProvider: driverLicences.verificationProvider,
      verifiedAt: driverLicences.verifiedAt,
    })
    .from(driverLicences)
    .where(and(eq(driverLicences.userId, userId), isNull(driverLicences.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listLicencesForReview() {
  return db
    .select({
      licence: driverLicences,
      userName: users.fullName,
    })
    .from(driverLicences)
    .leftJoin(users, eq(users.id, driverLicences.userId))
    .where(and(eq(driverLicences.status, 'pending_review'), isNull(driverLicences.deletedAt)))
    .orderBy(driverLicences.createdAt);
}

/**
 * Marks lapsed licences expired and warns about ones about to lapse.
 *
 * Expiry is a date arithmetic fact, not a verification claim, so the system is
 * allowed to assert it.
 */
export async function scanLicenceExpiry(): Promise<{ expired: number; expiring: number }> {
  const today = localDateString(new Date());
  const warnDays = await getNumberSetting(SETTING_KEYS.licenceExpiryWarningDays);
  const warnBefore = addDaysToDateString(today, warnDays);

  const expired = (await db.execute(raw`
    update driver_licences
       set status = 'expired', updated_at = now()
     where deleted_at is null
       and expires_on is not null
       and expires_on < ${today}
       and status <> 'expired'
     returning id
  `)) as unknown as Array<{ id: string }>;

  const expiring = (await db.execute(raw`
    select l.id, u.full_name, l.expires_on
      from driver_licences l
      join users u on u.id = l.user_id
     where l.deleted_at is null
       and l.expires_on between ${today} and ${warnBefore}
       and l.status <> 'expired'
  `)) as unknown as Array<{ id: string; full_name: string; expires_on: string }>;

  if (expired.length || expiring.length) {
    logger.info({ expired: expired.length, expiring: expiring.length }, 'licence expiry scan');
  }
  return { expired: expired.length, expiring: expiring.length };
}

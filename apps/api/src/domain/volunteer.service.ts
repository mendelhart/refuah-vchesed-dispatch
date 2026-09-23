import { and, asc, eq, inArray, isNull, sql as raw } from 'drizzle-orm';
import {
  AVAILABILITY_EXCEPTION_KINDS,
  VOLUNTEER_CAPABILITIES,
  WEEKDAYS,
  type VolunteerCapability,
} from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import {
  availabilityExceptions,
  availabilityRules,
  serviceTypes,
  users,
  volunteerServices,
} from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { minuteToClock12 } from '../lib/time.js';
import { generateToken } from '../lib/crypto.js';

/**
 * The volunteer's own record: what they can do, when they can do it, and the
 * card they show at a hospital door.
 *
 * All of this is self-serve by design. In the legacy application a volunteer
 * who could not drive next Tuesday had no way to say so except by ignoring the
 * messages, which is indistinguishable from not seeing them. Every field here
 * exists so that silence stops being the only available answer — and, unlike
 * the legacy `availability` blob, every field here is actually read by the
 * dispatch engine (see domain/targeting.ts).
 */

export interface AvailabilityWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

function assertWindow(w: AvailabilityWindow): void {
  if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) {
    throw Errors.validation('weekday must be 0 (Sunday) through 6 (Saturday)');
  }
  if (
    !Number.isInteger(w.startMinute) ||
    !Number.isInteger(w.endMinute) ||
    w.startMinute < 0 ||
    w.endMinute > 1440 ||
    w.startMinute >= w.endMinute
  ) {
    throw Errors.validation(
      'An availability window must start before it ends, within a single day.',
    );
  }
}

/** Replaces the volunteer's weekly windows wholesale — the UI edits a grid. */
export async function setAvailability(
  actor: AuditActor,
  userId: string,
  windows: AvailabilityWindow[],
): Promise<AvailabilityWindow[]> {
  for (const w of windows) assertWindow(w);

  // Merge overlapping windows on the same day, so "9-12 and 11-14" becomes
  // 9-14 rather than two rows that both match and double-count.
  const merged: AvailabilityWindow[] = [];
  for (const w of [...windows].sort((a, b) =>
    a.weekday === b.weekday ? a.startMinute - b.startMinute : a.weekday - b.weekday,
  )) {
    const last = merged[merged.length - 1];
    if (last && last.weekday === w.weekday && w.startMinute <= last.endMinute) {
      last.endMinute = Math.max(last.endMinute, w.endMinute);
    } else {
      merged.push({ ...w });
    }
  }

  return db.transaction(async (tx) => {
    const previous = await tx
      .select()
      .from(availabilityRules)
      .where(eq(availabilityRules.userId, userId));

    await tx.delete(availabilityRules).where(eq(availabilityRules.userId, userId));
    if (merged.length) {
      await tx.insert(availabilityRules).values(merged.map((w) => ({ userId, ...w })));
    }

    await recordAudit(
      {
        actor,
        action: 'volunteer.availability_changed',
        entityType: 'user',
        entityId: userId,
        previous: { windows: previous.map(describeWindow) },
        next: { windows: merged.map(describeWindow) },
      },
      tx,
    );
    return merged;
  });
}

function describeWindow(w: { weekday: number; startMinute: number; endMinute: number }): string {
  return `${WEEKDAYS[w.weekday] ?? w.weekday} ${minuteToClock12(w.startMinute)}–${minuteToClock12(w.endMinute)}`;
}

export async function getAvailability(userId: string, exec: Executor = db) {
  const [rules, exceptions] = await Promise.all([
    exec
      .select({
        weekday: availabilityRules.weekday,
        startMinute: availabilityRules.startMinute,
        endMinute: availabilityRules.endMinute,
      })
      .from(availabilityRules)
      .where(eq(availabilityRules.userId, userId))
      .orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startMinute)),
    exec
      .select()
      .from(availabilityExceptions)
      .where(
        and(
          eq(availabilityExceptions.userId, userId),
          raw`${availabilityExceptions.endsAt} > now() - interval '30 days'`,
        ),
      )
      .orderBy(asc(availabilityExceptions.startsAt)),
  ]);
  return {
    windows: rules,
    /** Empty windows means no stated restriction — see targeting.ts. */
    unrestricted: rules.length === 0,
    exceptions,
  };
}

export async function addAvailabilityException(
  actor: AuditActor,
  userId: string,
  input: { kind: string; startsAt: Date; endsAt: Date; reason?: string | null },
) {
  if (!AVAILABILITY_EXCEPTION_KINDS.includes(input.kind as never)) {
    throw Errors.validation(`kind must be one of: ${AVAILABILITY_EXCEPTION_KINDS.join(', ')}`);
  }
  if (input.endsAt <= input.startsAt) {
    throw Errors.validation('The end of the period must be after its start.');
  }
  const [row] = await db
    .insert(availabilityExceptions)
    .values({
      userId,
      kind: input.kind,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason ?? null,
    })
    .returning();
  await recordAudit({
    actor,
    action: 'volunteer.availability_exception_added',
    entityType: 'user',
    entityId: userId,
    next: { kind: input.kind, startsAt: input.startsAt, endsAt: input.endsAt },
  });
  return row!;
}

export async function removeAvailabilityException(
  actor: AuditActor,
  userId: string,
  id: string,
): Promise<void> {
  const deleted = await db
    .delete(availabilityExceptions)
    .where(and(eq(availabilityExceptions.id, id), eq(availabilityExceptions.userId, userId)))
    .returning({ id: availabilityExceptions.id });
  if (!deleted.length) throw Errors.notFound('That time off is no longer on file.');
  await recordAudit({
    actor,
    action: 'volunteer.availability_exception_removed',
    entityType: 'user',
    entityId: userId,
    previous: { id },
  });
}

// ---------------------------------------------------------------------------
// Services — what a volunteer has agreed to be asked about
// ---------------------------------------------------------------------------

export async function listServiceTypes(exec: Executor = db) {
  return exec
    .select()
    .from(serviceTypes)
    .where(eq(serviceTypes.active, true))
    .orderBy(asc(serviceTypes.sortOrder), asc(serviceTypes.name));
}

export async function getVolunteerServices(userId: string, exec: Executor = db) {
  return exec
    .select({
      id: serviceTypes.id,
      slug: serviceTypes.slug,
      name: serviceTypes.name,
      description: serviceTypes.description,
      dispatchable: serviceTypes.dispatchable,
      optedInAt: volunteerServices.optedInAt,
    })
    .from(volunteerServices)
    .innerJoin(serviceTypes, eq(serviceTypes.id, volunteerServices.serviceTypeId))
    .where(eq(volunteerServices.userId, userId))
    .orderBy(asc(serviceTypes.sortOrder));
}

/**
 * Sets the complete opt-in list. Self-serve for the volunteer; a dispatcher may
 * also set it for someone during a phone call, and the audit records which.
 */
export async function setVolunteerServices(
  actor: AuditActor,
  userId: string,
  slugs: string[],
): Promise<string[]> {
  const available = await listServiceTypes();
  const bySlug = new Map(available.map((s) => [s.slug, s]));
  const unknown = slugs.filter((s) => !bySlug.has(s));
  if (unknown.length) {
    throw Errors.validation(`Unknown service: ${unknown.join(', ')}`, { unknown });
  }

  return db.transaction(async (tx) => {
    const previous = await tx
      .select({ slug: serviceTypes.slug })
      .from(volunteerServices)
      .innerJoin(serviceTypes, eq(serviceTypes.id, volunteerServices.serviceTypeId))
      .where(eq(volunteerServices.userId, userId));

    await tx.delete(volunteerServices).where(eq(volunteerServices.userId, userId));
    if (slugs.length) {
      await tx.insert(volunteerServices).values(
        slugs.map((slug) => ({
          userId,
          serviceTypeId: bySlug.get(slug)!.id,
          optedInById: actor.userId,
        })),
      );
    }
    await recordAudit(
      {
        actor,
        action: 'volunteer.services_changed',
        entityType: 'user',
        entityId: userId,
        previous: { services: previous.map((p) => p.slug) },
        next: { services: slugs },
      },
      tx,
    );
    return slugs;
  });
}

export async function setCapabilities(
  actor: AuditActor,
  userId: string,
  capabilities: string[],
): Promise<string[]> {
  const unknown = capabilities.filter(
    (c) => !VOLUNTEER_CAPABILITIES.includes(c as VolunteerCapability),
  );
  if (unknown.length) {
    throw Errors.validation(`Unknown capability: ${unknown.join(', ')}`, { unknown });
  }
  const unique = [...new Set(capabilities)];
  const [before] = await db
    .select({ capabilities: users.capabilities })
    .from(users)
    .where(eq(users.id, userId));
  if (!before) throw Errors.notFound('Volunteer not found.');

  await db.update(users).set({ capabilities: unique, updatedAt: new Date() }).where(eq(users.id, userId));
  await recordAudit({
    actor,
    action: 'volunteer.capabilities_changed',
    entityType: 'user',
    entityId: userId,
    previous: { capabilities: before.capabilities },
    next: { capabilities: unique },
  });
  return unique;
}

// ---------------------------------------------------------------------------
// Volunteer number and ID card
// ---------------------------------------------------------------------------

/**
 * Assigns the permanent volunteer number printed on the ID card, and the
 * opaque token behind its QR code.
 *
 * Idempotent: a volunteer who already has them keeps them. Numbers are never
 * reused, because a card in circulation outlives the record behind it.
 */
export async function ensureVolunteerNumber(
  userId: string,
  exec: Executor = db,
): Promise<{ number: string; cardToken: string }> {
  const [existing] = await exec
    .select({ n: users.volunteerNumber, token: users.cardToken })
    .from(users)
    .where(eq(users.id, userId));

  const number =
    existing?.n ??
    ((await exec.execute(raw`select next_volunteer_number() as n`)) as unknown as Array<{ n: string }>)[0]!.n;
  const cardToken = existing?.token ?? generateToken(15);

  if (!existing?.n || !existing?.token) {
    await exec.update(users).set({ volunteerNumber: number, cardToken }).where(eq(users.id, userId));
  }
  return { number, cardToken };
}

/**
 * A lost card: give it a new QR code. The old card's link stops working at
 * once (the check page says it is not valid), the volunteer number stays.
 */
export async function reissueCardToken(actor: AuditActor, userId: string): Promise<{ cardToken: string }> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!row) throw Errors.notFound('That person is no longer on file.');
  await ensureVolunteerNumber(userId);
  const cardToken = generateToken(15);
  await db.update(users).set({ cardToken }).where(eq(users.id, userId));
  await recordAudit({ actor, action: 'id_card.reissued', entityType: 'user', entityId: userId });
  return { cardToken };
}

export interface IdCard {
  volunteerNumber: string;
  fullName: string;
  role: string;
  /** Data URL of the volunteer photo, or null. */
  photo: string | null;
  groups: string[];
  services: string[];
  capabilities: string[];
  memberSince: string | null;
  organization: { name: string; phone: string | null };
  /** Opaque value encoded into the card's QR code for door checks. */
  verificationCode: string;
}

/**
 * The ID card a volunteer shows at a hospital reception desk.
 *
 * The QR code carries a verification URL, not personal data: anyone scanning it
 * gets a page that confirms the card is current, which is the question being
 * asked, without printing a phone number onto a badge that can be photographed.
 */
export async function buildIdCard(userId: string): Promise<IdCard> {
  const { number, cardToken } = await ensureVolunteerNumber(userId);
  const rows = (await db.execute(raw`
    select u.full_name, u.role, u.created_at, u.capabilities, u.photo_url,
           coalesce(array_agg(distinct g.name) filter (where g.name is not null), '{}') as groups,
           coalesce(array_agg(distinct st.name) filter (where st.name is not null), '{}') as services,
           (select name from organization_info limit 1)  as org_name,
           (select phone from organization_info limit 1) as org_phone
    from users u
    left join user_groups ug on ug.user_id = u.id
    left join volunteer_groups g on g.id = ug.group_id
    left join volunteer_services vs on vs.user_id = u.id
    left join service_types st on st.id = vs.service_type_id
    where u.id = ${userId}::uuid
    group by u.id, u.full_name, u.role, u.created_at, u.capabilities, u.photo_url
  `)) as unknown as Array<{
    full_name: string;
    role: string;
    created_at: Date;
    capabilities: string[];
    photo_url: string | null;
    groups: string[];
    services: string[];
    org_name: string | null;
    org_phone: string | null;
  }>;

  const row = rows[0];
  if (!row) throw Errors.notFound('Volunteer not found.');

  return {
    volunteerNumber: number,
    fullName: row.full_name,
    role: row.role,
    photo: row.photo_url && row.photo_url.startsWith('data:image/') ? row.photo_url : null,
    groups: row.groups ?? [],
    services: row.services ?? [],
    capabilities: row.capabilities ?? [],
    memberSince: row.created_at ? new Date(row.created_at).toISOString() : null,
    organization: { name: row.org_name ?? "Refuah V'Chesed", phone: row.org_phone ?? null },
    verificationCode: cardToken,
  };
}

/**
 * Public, unauthenticated card check.
 *
 * Accepts the QR token. It deliberately answers the one question a hospital
 * reception desk is asking — is this person currently a volunteer here — and
 * nothing else: no phone number, no email, no groups, no ride history. An
 * unknown or deactivated card is simply "not valid", with no hint as to which.
 */
export async function verifyIdCard(
  cardToken: string,
): Promise<{ valid: boolean; fullName?: string; volunteerNumber?: string; organization?: string; photo?: string }> {
  if (!cardToken || cardToken.length < 8) return { valid: false };
  const [row] = await db
    .select({ fullName: users.fullName, status: users.status, number: users.volunteerNumber, photo: users.photoUrl })
    .from(users)
    .where(and(eq(users.cardToken, cardToken), isNull(users.deletedAt)))
    .limit(1);
  if (!row || row.status !== 'active') return { valid: false };
  return {
    valid: true,
    fullName: row.fullName,
    volunteerNumber: row.number ?? undefined,
    organization: "Refuah V'Chesed",
    // Shown to the desk so they can match the face to the card holder (owner
    // decision, Sep 23). Sent inline: the page is unauthenticated, and only a
    // current card ever gets this far.
    photo: row.photo && row.photo.startsWith('data:image/') ? row.photo : undefined,
  };
}

/** Bulk helper used by the consolidated volunteer screen. */
export async function volunteerSummaries(userIds: string[], exec: Executor = db) {
  if (!userIds.length) return [];
  return exec
    .select({
      userId: volunteerServices.userId,
      slug: serviceTypes.slug,
    })
    .from(volunteerServices)
    .innerJoin(serviceTypes, eq(serviceTypes.id, volunteerServices.serviceTypeId))
    .where(inArray(volunteerServices.userId, userIds));
}

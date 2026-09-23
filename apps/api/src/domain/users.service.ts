import { and, asc, eq, inArray, isNull, sql as raw } from 'drizzle-orm';
import type { Role } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { authTokens, sessions, userGroups, users, volunteerGroups } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { normalizePhone } from '../lib/phone.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { revokeAllSessionsForUser } from '../auth/session.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';

/** Issues a hashed, expiring, single-use invite or reset token. */
export async function issueAuthToken(
  userId: string,
  kind: 'invite' | 'password_reset',
  ttlMinutes: number,
  exec: Executor = db,
): Promise<{ token: string; url: string }> {
  const token = generateToken(32);
  await exec.insert(authTokens).values({
    userId, kind, tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  });
  const path = kind === 'invite' ? 'accept-invite' : 'reset-password';
  const url = `${env.APP_URL}/${path}?token=${token}`;
  // In development and test there is no mail provider; the link is logged so
  // the flow is exercisable end to end. DEPLOYMENT.md covers wiring real email.
  logger.info({ userId, kind, url }, 'auth token issued');
  return { token, url };
}

async function setGroups(exec: Executor, userId: string, slugs: string[]): Promise<void> {
  const groups = slugs.length
    ? await exec.select().from(volunteerGroups).where(inArray(volunteerGroups.slug, slugs))
    : [];
  if (groups.length !== slugs.length) {
    const found = new Set(groups.map((g) => g.slug));
    throw Errors.validation(`Unknown group(s): ${slugs.filter((s) => !found.has(s)).join(', ')}`);
  }
  await exec.delete(userGroups).where(eq(userGroups.userId, userId));
  if (groups.length) {
    await exec.insert(userGroups).values(groups.map((g) => ({ userId, groupId: g.id })));
  }
}

export interface CreateUserArgs {
  email: string; fullName: string; phone?: string | null;
  role: Role; groupSlugs: string[]; status: string; sendInvite: boolean;
}

export async function createUser(actor: AuditActor, args: CreateUserArgs) {
  return db.transaction(async (tx) => {
    const phone = normalizePhone(args.phone);
    if (args.phone && !phone) throw Errors.validation('Phone number is not valid', { field: 'phone' });

    const existing = await tx.select({ id: users.id }).from(users)
      .where(and(raw`lower(${users.email}) = ${args.email.toLowerCase()}`, isNull(users.deletedAt))).limit(1);
    if (existing.length) throw Errors.conflict('Someone with that email address already exists.');

    if (phone) {
      const dupe = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.phone, phone), isNull(users.deletedAt))).limit(1);
      if (dupe.length) throw Errors.conflict('Someone with that phone number already exists. SMS replies must map to exactly one person.');
    }

    const [user] = await tx.insert(users).values({
      email: args.email, fullName: args.fullName, phone,
      role: args.role, status: args.status, mustChangePassword: true,
    }).returning();

    await setGroups(tx, user!.id, args.groupSlugs);

    /**
     * A new volunteer is opted in to the dispatchable services by default.
     *
     * Without this a volunteer created by an administrator would match no
     * service in targeting and would never be offered a trip — an account that
     * looks correct on every screen and silently receives nothing. They can
     * narrow it themselves from their profile.
     */
    if (user!.role === 'volunteer') {
      await tx.execute(raw`
        insert into volunteer_services (user_id, service_type_id)
        select ${user!.id}::uuid, st.id from service_types st
         where st.dispatchable and st.active
        on conflict do nothing
      `);
    }

    await recordAudit({
      actor, action: 'user.created', entityType: 'user', entityId: user!.id,
      next: { email: user!.email, fullName: user!.fullName, role: user!.role, groups: args.groupSlugs },
    }, tx);

    let inviteUrl: string | null = null;
    if (args.sendInvite) inviteUrl = (await issueAuthToken(user!.id, 'invite', 60 * 24 * 7, tx)).url;
    return { user: user!, inviteUrl };
  });
}

export async function updateUser(actor: AuditActor, userId: string, patch: Record<string, unknown>) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1).for('update');
    if (!before) throw Errors.notFound('User');

    const set: Record<string, unknown> = {};
    for (const key of ['fullName', 'status', 'preferredVehicleType', 'emergencyContactName', 'addressLine', 'photoUrl', 'notificationPreference'] as const) {
      if (key in patch) set[key] = patch[key] ?? null;
    }
    if ('phone' in patch) {
      const phone = normalizePhone(patch.phone as string);
      if (patch.phone && !phone) throw Errors.validation('Phone number is not valid', { field: 'phone' });
      if (phone && phone !== before.phone) {
        const dupe = await tx.select({ id: users.id }).from(users)
          .where(and(eq(users.phone, phone), isNull(users.deletedAt))).limit(1);
        if (dupe.length) throw Errors.conflict('Another person already has that phone number.');
      }
      set.phone = phone;
    }
    if ('emergencyContactPhone' in patch) set.emergencyContactPhone = normalizePhone(patch.emergencyContactPhone as string);
    if ('availability' in patch) set.availability = patch.availability;
    if ('navHidden' in patch) set.navHidden = Array.isArray(patch.navHidden) ? patch.navHidden : [];

    const [after] = Object.keys(set).length
      ? await tx.update(users).set(set).where(eq(users.id, userId)).returning()
      : [before];

    if (Array.isArray(patch.groupSlugs)) await setGroups(tx, userId, patch.groupSlugs as string[]);

    // Deactivation must not leave live sessions behind.
    if (set.status && set.status !== 'active') await revokeAllSessionsForUser(userId, tx);

    await recordAudit({
      actor, action: 'user.updated', entityType: 'user', entityId: userId,
      previous: { fullName: before.fullName, status: before.status, phone: before.phone ? `••${before.phone.slice(-4)}` : null },
      next: { fullName: after!.fullName, status: after!.status, phone: after!.phone ? `••${after!.phone.slice(-4)}` : null },
      metadata: { fields: Object.keys(set), groupSlugs: patch.groupSlugs ?? undefined },
    }, tx);
    return after!;
  });
}

/** Role changes are separate from profile edits, admin-only, and always audited. */
export async function changeRole(actor: AuditActor, userId: string, role: Role) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for('update');
    if (!before) throw Errors.notFound('User');
    if (before.role === role) return before;

    if (before.role === 'admin' && role !== 'admin') {
      const adminRows = (await tx.execute(raw`
        select count(*)::int as n from users where role = 'admin' and status = 'active' and deleted_at is null
      `)) as unknown as Array<{ n: number }>;
      const n = Number(adminRows[0]!.n);
      if (n <= 1) throw Errors.conflict('This is the last active administrator. Promote someone else first.');
    }

    const [after] = await tx.update(users).set({ role }).where(eq(users.id, userId)).returning();
    await revokeAllSessionsForUser(userId, tx); // new privileges require a fresh session
    await recordAudit({
      actor, action: 'user.role_changed', entityType: 'user', entityId: userId,
      previous: { role: before.role }, next: { role },
    }, tx);
    return after!;
  });
}

/** Soft delete. Operational history referencing this person is preserved. */
export async function deactivateUser(actor: AuditActor, userId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for('update');
    if (!before) throw Errors.notFound('User');

    const openRows = (await tx.execute(raw`
      select count(*)::int as open from trips
      where assigned_volunteer_id = ${userId}
        and status in ('assigned','accepted','en_route','in_progress') and deleted_at is null
    `)) as unknown as Array<{ open: number }>;
    const open = Number(openRows[0]!.open);
    if (open > 0) throw Errors.conflict(`This volunteer still has ${open} active trip(s). Reassign them first.`);

    const [after] = await tx.update(users)
      .set({ status: 'deactivated', deletedAt: new Date(), email: `${before.email}.deleted.${Date.now()}`, phone: null })
      .where(eq(users.id, userId)).returning();
    await revokeAllSessionsForUser(userId, tx);
    await tx.delete(authTokens).where(eq(authTokens.userId, userId));
    await recordAudit({
      actor, action: 'user.deactivated', entityType: 'user', entityId: userId,
      previous: { email: before.email, status: before.status }, metadata: { reason },
    }, tx);
    return after!;
  });
}

export interface ListUsersArgs { role?: Role; groupSlug?: string; status?: string; search?: string; limit: number; }

/** Directory listing. Contact details are included only for dispatch roles. */
export async function listUsers(viewerRole: Role, args: ListUsersArgs) {
  const conditions = [isNull(users.deletedAt)];
  if (args.role) conditions.push(eq(users.role, args.role));
  if (args.status) conditions.push(eq(users.status, args.status));
  if (args.search) conditions.push(raw`lower(${users.fullName}) like ${`%${args.search.toLowerCase()}%`}`);

  const rows = await db.select({
    id: users.id, fullName: users.fullName, email: users.email, phone: users.phone,
    role: users.role, status: users.status, photoUrl: users.photoUrl,
    groupSlugs: raw<string[]>`coalesce(array_agg(distinct ${volunteerGroups.slug}) filter (where ${volunteerGroups.slug} is not null), '{}')`,
  }).from(users)
    .leftJoin(userGroups, eq(userGroups.userId, users.id))
    .leftJoin(volunteerGroups, eq(volunteerGroups.id, userGroups.groupId))
    .where(and(...conditions))
    .groupBy(users.id)
    .orderBy(asc(users.fullName))
    .limit(args.limit);

  const filtered = args.groupSlug ? rows.filter((r) => r.groupSlugs.includes(args.groupSlug!)) : rows;
  const privileged = viewerRole === 'dispatcher' || viewerRole === 'admin';

  return filtered.map((r) => ({
    id: r.id, fullName: r.fullName, role: r.role, status: r.status,
    photoUrl: r.photoUrl, groupSlugs: r.groupSlugs,
    // Volunteers see who else is on the roster, not how to contact them.
    email: privileged ? r.email : null,
    phone: privileged ? r.phone : null,
  }));
}

export async function activeSessionCount(userId: string): Promise<number> {
  const [row] = await db.select({ n: raw<number>`count(*)::int` }).from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), raw`${sessions.expiresAt} > now()`));
  return row?.n ?? 0;
}

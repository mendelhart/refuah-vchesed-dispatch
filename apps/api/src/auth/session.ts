import { and, eq, isNull, lt, or, sql as raw } from 'drizzle-orm';
import type { Role, SessionUser, UserStatus } from '@rvc/shared';
import { SETTING_KEYS } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { sessions, userGroups, users, volunteerGroups } from '../db/schema.js';
import { generateToken, hashToken, verifyPassword, hashPassword } from '../lib/crypto.js';
import { getNumberSetting } from '../lib/settings.js';
import { Errors } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

export interface AuthenticatedUser extends SessionUser {
  sessionId: string;
}

export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
}

/** Everything the request pipeline needs, in one query. */
async function loadSessionUser(userId: string, exec: Executor = db): Promise<SessionUser | null> {
  const rows = await exec
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      status: users.status,
      phone: users.phone,
      notificationPreference: users.notificationPreference,
      navHidden: users.navHidden,
      mustChangePassword: users.mustChangePassword,
      deletedAt: users.deletedAt,
      groupId: volunteerGroups.id,
      groupSlug: volunteerGroups.slug,
      groupName: volunteerGroups.name,
    })
    .from(users)
    .leftJoin(userGroups, eq(userGroups.userId, users.id))
    .leftJoin(volunteerGroups, eq(volunteerGroups.id, userGroups.groupId))
    .where(eq(users.id, userId));

  const first = rows[0];
  if (!first || first.deletedAt) return null;

  const groups = rows
    .filter((r) => r.groupId && r.groupSlug && r.groupName)
    .map((r) => ({ id: r.groupId!, slug: r.groupSlug!, name: r.groupName! }));

  return {
    id: first.id,
    email: first.email,
    fullName: first.fullName,
    role: first.role as Role,
    status: first.status as UserStatus,
    phone: first.phone,
    groups,
    notificationPreference: first.notificationPreference as SessionUser['notificationPreference'],
    navHidden: first.navHidden,
    mustChangePassword: first.mustChangePassword,
  };
}

export async function authenticate(
  email: string,
  password: string,
  ctx: LoginContext,
): Promise<{ token: string; user: SessionUser }> {
  // Volunteers added with only a phone sign in with their mobile number.
  const identifier = email.trim();
  const byPhone = !identifier.includes('@') ? normalizePhone(identifier) : null;
  const [row] = await db
    .select()
    .from(users)
    .where(and(
      byPhone ? eq(users.phone, byPhone) : raw`lower(${users.email}) = ${identifier.toLowerCase()}`,
      isNull(users.deletedAt),
    ))
    .limit(1);

  // Deliberately identical failure for "no such account", "wrong password" and
  // "deactivated": account enumeration is a real risk for a volunteer roster.
  const genericFailure = Errors.unauthorized('Email/phone or password is incorrect');

  if (row?.lockedUntil && row.lockedUntil > new Date()) {
    throw Errors.rateLimited('Too many failed attempts. Try again in a few minutes.');
  }

  const ok = await verifyPassword(password, row?.passwordHash ?? null);
  if (!row || !ok) {
    if (row) {
      const failed = row.failedLoginCount + 1;
      await db
        .update(users)
        .set({
          failedLoginCount: failed,
          lockedUntil:
            failed >= MAX_FAILED_LOGINS
              ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
              : row.lockedUntil,
        })
        .where(eq(users.id, row.id));
    }
    throw genericFailure;
  }

  if (row.status === 'inactive' && row.suspendedUntil && row.suspendedUntil <= new Date()) {
    // The pause has ended; housekeeping may simply not have run yet.
    await db.update(users).set({ status: 'active', suspendedUntil: null, suspensionReason: null }).where(eq(users.id, row.id));
    row.status = 'active';
  }
  if (row.status === 'inactive') {
    // Only reached with the right password, so this reveals nothing to a stranger.
    const until = row.suspendedUntil
      ? ` until ${row.suspendedUntil.toLocaleDateString('en-CA', { timeZone: 'America/Toronto', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`
      : '';
    throw Errors.forbidden(`Your volunteer account is paused${until}. Please contact a coordinator.`);
  }
  if (row.status !== 'active') throw genericFailure;

  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, row.id));

  const token = await createSession(row.id, ctx);
  const user = await loadSessionUser(row.id);
  if (!user) throw Errors.internal();
  return { token, user };
}

export async function createSession(userId: string, ctx: LoginContext): Promise<string> {
  const ttlHours = await getNumberSetting(SETTING_KEYS.sessionTtlHours);
  const token = generateToken(32);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent?.slice(0, 300) ?? null,
  });
  return token;
}

export async function resolveSession(token: string): Promise<AuthenticatedUser | null> {
  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        isNull(sessions.revokedAt),
        raw`${sessions.expiresAt} > now()`,
      ),
    )
    .limit(1);
  if (!row) return null;

  const user = await loadSessionUser(row.userId);
  if (!user || user.status !== 'active') return null;

  // Touch at most once a minute to keep login writes off the hot path.
  void db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(sessions.id, row.id), lt(sessions.lastSeenAt, new Date(Date.now() - 60_000))))
    .catch(() => {});

  return { ...user, sessionId: row.id };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/** Used on password change, role change and deactivation. */
export async function revokeAllSessionsForUser(userId: string, exec: Executor = db): Promise<void> {
  await exec
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function setPassword(
  userId: string,
  password: string,
  opts: { mustChange?: boolean } = {},
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      mustChangePassword: opts.mustChange ?? false,
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, userId));
}

export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(or(raw`${sessions.expiresAt} < now() - interval '30 days'`, raw`${sessions.revokedAt} < now() - interval '30 days'`))
    .returning({ id: sessions.id });
  return deleted.length;
}

export { loadSessionUser };

/**
 * The first administrator, on a platform with no shell.
 *
 * This system ships no default credentials, on purpose: a dispatch system that
 * boots with a known password is a dispatch system anyone can sign in to. But
 * that leaves a real problem on hosts where there is no way to run a one-off
 * command against the database — Render's free tier has no shell, and the
 * seed script refuses to run against production by design.
 *
 * So the first account is created from configuration, with NO password, and the
 * single-use invitation link is written to the log. Whoever set the variable
 * reads it once, opens it once, and chooses a password.
 *
 * Three rules keep this from being a back door:
 *
 *   * It does nothing unless BOOTSTRAP_ADMIN_EMAIL is set.
 *   * It creates an account only when the users table is empty. On a system
 *     that already has people in it, an administrator is added by another
 *     administrator — never by an environment variable someone edited.
 *   * It goes inert the moment that account has a password. From then on the
 *     variable does nothing and the ordinary reset flow is the way back in.
 *
 * Each boot supersedes the previous link rather than adding to it: a free host
 * that sleeps idle services cold-starts often, and the alternative — keeping
 * the first token and staying silent — strands anyone who missed the log line
 * until it expires. Superseding means the newest line in the log is always the
 * one that works, and every older one is already dead.
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import { db } from './client.js';
import { authTokens, userGroups, users, volunteerGroups } from './schema.js';
import { issueAuthToken } from '../domain/users.service.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

/** Long enough to be read from a log at a reasonable hour, short enough to matter. */
const INVITE_TTL_MINUTES = 24 * 60;

export async function bootstrapAdmin(): Promise<void> {
  const email = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return;

  const [existing] = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  let userId: string;

  if (existing) {
    if (existing.passwordHash) {
      logger.info({ email }, 'bootstrap administrator already has a password — nothing to do');
      return;
    }
    userId = existing.id;
  } else {
    const [totals] = await db.select({ value: count() }).from(users);
    if ((totals?.value ?? 0) > 0) {
      logger.warn(
        { email, existingUsers: totals?.value },
        'BOOTSTRAP_ADMIN_EMAIL ignored: this system already has users. Add administrators from the admin screens.',
      );
      return;
    }

    const [created] = await db
      .insert(users)
      .values({
        email,
        fullName: env.BOOTSTRAP_ADMIN_NAME,
        role: 'admin',
        status: 'active',
        // No password. The invitation link below is the only way in, and it is
        // single-use, hashed at rest and expiring.
        passwordHash: null,
        notificationPreference: 'email',
      })
      .returning({ id: users.id });

    userId = created!.id;

    // An administrator who belongs to no group sees an empty board and would
    // reasonably conclude the system is broken.
    const groups = await db.select({ id: volunteerGroups.id }).from(volunteerGroups);
    for (const group of groups) {
      await db.insert(userGroups).values({ userId, groupId: group.id }).onConflictDoNothing();
    }

    logger.info({ email }, 'created the first administrator');
  }

  const superseded = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.userId, userId), eq(authTokens.kind, 'invite'), isNull(authTokens.usedAt)))
    .returning({ id: authTokens.id });

  const { url } = await issueAuthToken(userId, 'invite', INVITE_TTL_MINUTES);

  // The path as well as the URL. The URL is built from APP_URL, which is a
  // configured value and therefore a value that can be wrong — and a wrong one
  // here means the one link that gets anybody into the system points at the
  // wrong host. The path costs a few characters and is always usable: append it
  // to whatever address the web app actually answers on.
  const path = url.slice(url.indexOf('/accept-invite'));

  logger.info(
    { url, path, validForHours: INVITE_TTL_MINUTES / 60, supersededLinks: superseded.length },
    'FIRST SIGN-IN LINK — single use. Open it to set a password; any earlier link is now dead.',
  );
}

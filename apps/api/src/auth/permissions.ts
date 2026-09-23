import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import type { AuthenticatedUser } from './session.js';

/**
 * Who may act on whom. One rule, used by every route that changes or contacts
 * a person, so a new screen cannot forget it.
 *
 *  - Admins may act on anyone.
 *  - Coordinators ("dispatcher" in the code) may act on volunteers only, unless
 *    the route widens it to anyone who is not an admin (editing details).
 *  - `allowSelf` lets a coordinator act on their own record (e.g. their ID card).
 */
export async function assertCanManagePerson(
  actor: AuthenticatedUser,
  targetId: string,
  opts: { verb: string; coordinatorMay?: 'volunteers' | 'non-admins'; allowSelf?: boolean },
): Promise<void> {
  if (actor.role === 'admin') return;
  if (actor.role !== 'dispatcher') throw Errors.forbidden();
  if (targetId === actor.id) {
    if (opts.allowSelf) return;
    throw Errors.forbidden(`You cannot ${opts.verb} yourself. Ask an admin.`);
  }
  const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, targetId)).limit(1);
  if (!target) throw Errors.notFound('That person is no longer on file.');
  const ok = (opts.coordinatorMay ?? 'volunteers') === 'volunteers' ? target.role === 'volunteer' : target.role !== 'admin';
  if (!ok) {
    throw Errors.forbidden(
      opts.coordinatorMay === 'non-admins'
        ? `Only an admin can ${opts.verb} an admin.`
        : `Only an admin can ${opts.verb} a coordinator or admin.`,
    );
  }
}

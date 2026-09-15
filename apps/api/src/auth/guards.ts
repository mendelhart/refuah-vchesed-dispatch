import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@rvc/shared';
import { isDispatchRole } from '@rvc/shared';
import { Errors } from '../lib/errors.js';
import type { AuthenticatedUser } from './session.js';
import type { AuditActor } from '../lib/audit.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Authorization is enforced here and in the service layer, never in the UI.
 *
 * Two levels, and both are required:
 *   - route level: `requireRole(...)` as a preHandler,
 *   - object level: the service functions check that *this* user may act on
 *     *this* record (see domain/trips.service.ts).
 *
 * The web app's route guards exist only so people don't see a page that will
 * refuse them; they are not a security control and are documented as such.
 */

export function currentUser(req: FastifyRequest): AuthenticatedUser {
  if (!req.user) throw Errors.unauthorized();
  return req.user;
}

export function actorFrom(req: FastifyRequest): AuditActor {
  const user = req.user;
  return {
    userId: user?.id ?? null,
    name: user?.fullName ?? 'Anonymous',
    role: user?.role ?? 'system',
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    requestId: req.id,
  };
}

/**
 * Guards MUST be async.
 *
 * Fastify v5 decides a hook's calling convention from its arity: a function
 * taking three arguments is callback-style and must call `done()`, anything
 * shorter is promise-style and is awaited. A plain synchronous two-argument
 * guard therefore returns `undefined`, Fastify awaits a non-promise, and the
 * request hangs forever instead of erroring — silently, on every authenticated
 * route. Keep the `async` keyword on every hook in this file.
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.user) throw Errors.unauthorized();
}

export function requireRole(...roles: Role[]) {
  return async function guard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const user = currentUser(req);
    if (!roles.includes(user.role)) {
      throw Errors.forbidden(`This action requires: ${roles.join(' or ')}`);
    }
  };
}

export const requireDispatcher = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await requireRole('dispatcher', 'admin')(req, reply);
};

export const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await requireRole('admin')(req, reply);
};

/** True when the user may see dispatcher-level detail (full PII on a trip). */
export function canSeeDispatchDetail(user: AuthenticatedUser): boolean {
  return isDispatchRole(user.role);
}

/** Group membership check used for volunteer-scoped queries. */
export function userGroupIds(user: AuthenticatedUser): string[] {
  return user.groups.map((g) => g.id);
}

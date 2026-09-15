import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { acceptInviteSchema, changePasswordSchema, loginSchema, resetPasswordSchema, requestPasswordResetSchema } from '@rvc/shared';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { authTokens, users } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { hashToken } from '../lib/crypto.js';
import { requirePhone } from '../lib/phone.js';
import { recordAudit } from '../lib/audit.js';
import { actorFrom, currentUser, requireAuth } from '../auth/guards.js';
import {
  authenticate, loadSessionUser, revokeAllSessionsForUser, revokeSession, setPassword, createSession,
} from '../auth/session.js';
import { verifyPassword } from '../lib/crypto.js';

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Login is rate-limited far more tightly than the global default.
  app.post('/api/auth/login', {
    config: { rateLimit: { max: () => env.LOGIN_MAX_PER_IP_PER_5MIN, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const { token, user } = await authenticate(body.email, body.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] as string | undefined,
    });
    await recordAudit({
      actor: { userId: user.id, name: user.fullName, role: user.role, ip: req.ip, requestId: req.id },
      action: 'auth.login', entityType: 'user', entityId: user.id,
    });
    reply.setCookie(env.SESSION_COOKIE_NAME, token, cookieOptions(60 * 60 * 24 * 14));
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.user) {
      await revokeSession(req.user.sessionId);
      await recordAudit({ actor: actorFrom(req), action: 'auth.logout', entityType: 'user', entityId: req.user.id });
    }
    reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.user) throw Errors.unauthorized();
    return { user: await loadSessionUser(req.user.id) };
  });

  app.post('/api/auth/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const body = changePasswordSchema.parse(req.body);
    const user = currentUser(req);
    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    if (!(await verifyPassword(body.currentPassword, row?.passwordHash ?? null))) {
      throw Errors.unauthorized('Your current password is not correct');
    }
    await db.transaction(async (tx) => {
      await setPassword(user.id, body.newPassword, { mustChange: false }, tx);
      await revokeAllSessionsForUser(user.id, tx);
      await recordAudit({ actor: actorFrom(req), action: 'auth.password_changed', entityType: 'user', entityId: user.id }, tx);
    });
    // Every other session is gone; issue a fresh one so the user stays signed in here.
    const token = await createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] as string });
    reply.setCookie(env.SESSION_COOKIE_NAME, token, cookieOptions(60 * 60 * 24 * 14));
    return { ok: true };
  });

  /** Invite acceptance: the volunteer sets their own password. */
  app.post('/api/auth/accept-invite', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const body = acceptInviteSchema.parse(req.body);
    const phone = requirePhone(body.phone, 'phone');

    const result = await db.transaction(async (tx) => {
      const [token] = await tx.select().from(authTokens)
        .where(and(eq(authTokens.tokenHash, hashToken(body.token)), eq(authTokens.kind, 'invite'), isNull(authTokens.usedAt)))
        .limit(1).for('update');
      if (!token || token.expiresAt < new Date()) throw Errors.unauthorized('This invitation link has expired. Ask an administrator for a new one.');

      await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, token.id));
      await tx.update(users).set({ fullName: body.fullName, phone, status: 'active' }).where(eq(users.id, token.userId));
      await setPassword(token.userId, body.password, { mustChange: false }, tx);
      await recordAudit({
        actor: { userId: token.userId, name: body.fullName, role: 'volunteer', ip: req.ip, requestId: req.id },
        action: 'auth.invite_accepted', entityType: 'user', entityId: token.userId,
      }, tx);
      return token.userId;
    });

    const session = await createSession(result, { ip: req.ip, userAgent: req.headers['user-agent'] as string });
    reply.setCookie(env.SESSION_COOKIE_NAME, session, cookieOptions(60 * 60 * 24 * 14));
    return { user: await loadSessionUser(result) };
  });

  /** Always returns ok — never reveals whether an address is registered. */
  app.post('/api/auth/request-password-reset', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (req) => {
    const body = requestPasswordResetSchema.parse(req.body);
    const [user] = await db.select({ id: users.id, fullName: users.fullName })
      .from(users).where(and(eq(users.email, body.email), isNull(users.deletedAt))).limit(1);
    if (user) {
      const { issueAuthToken } = await import('../domain/users.service.js');
      await issueAuthToken(user.id, 'password_reset', 60);
    }
    return { ok: true };
  });

  app.post('/api/auth/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req) => {
    const body = resetPasswordSchema.parse(req.body);
    await db.transaction(async (tx) => {
      const [token] = await tx.select().from(authTokens)
        .where(and(eq(authTokens.tokenHash, hashToken(body.token)), eq(authTokens.kind, 'password_reset'), isNull(authTokens.usedAt)))
        .limit(1).for('update');
      if (!token || token.expiresAt < new Date()) throw Errors.unauthorized('This reset link has expired.');
      await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, token.id));
      await setPassword(token.userId, body.password, { mustChange: false }, tx);
      await revokeAllSessionsForUser(token.userId, tx);
      await recordAudit({
        actor: { userId: token.userId, name: 'Self-service reset', role: 'volunteer', ip: req.ip, requestId: req.id },
        action: 'auth.password_reset', entityType: 'user', entityId: token.userId,
      }, tx);
    });
    return { ok: true };
  });
}

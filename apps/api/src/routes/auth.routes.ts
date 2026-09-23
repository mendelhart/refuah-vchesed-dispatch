import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, ne, sql as raw } from 'drizzle-orm';
import { acceptInviteSchema, changePasswordSchema, loginSchema, resetPasswordSchema, requestPasswordResetSchema } from '@rvc/shared';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { z } from 'zod';
import { authTokens, sessions, users } from '../db/schema.js';
import { newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { decryptField, encryptField, fieldEncryptionAvailable } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import { hashToken } from '../lib/crypto.js';
import { requirePhone } from '../lib/phone.js';
import { recordAudit } from '../lib/audit.js';
import { actorFrom, currentUser, requireAuth } from '../auth/guards.js';
import {
  authenticate, loadSessionUser, revokeAllSessionsForUser, revokeSession, setPassword, createSession, roleNeedsMfa,
} from '../auth/session.js';

/** Authenticator secrets are encrypted at rest when the field key is configured. */
function sealSecret(secret: string): string {
  return fieldEncryptionAvailable() ? `enc:${encryptField(secret)}` : `raw:${secret}`;
}
function openSecret(stored: string | null): string | null {
  if (!stored) return null;
  if (stored.startsWith('enc:')) return decryptField(stored.slice(4));
  if (stored.startsWith('raw:')) return stored.slice(4);
  return null;
}
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
    const me = await loadSessionUser(req.user.id);
    if (me && req.user.mfaPending) {
      const [row] = await db.select({ on: users.totpEnabledAt }).from(users).where(eq(users.id, req.user.id));
      me.mfa = row?.on ? 'verify' : 'setup';
    }
    return {
      user: me,
      ...(req.viewAsBy ? { viewAsBy: req.viewAsBy } : {}),
    };
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

  // --- two-step sign-in ------------------------------------------------------
  const codeBody = z.object({ code: z.string().trim().min(6).max(20) });
  const mfaLimit = { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } };
  const pendingUser = (req: Parameters<typeof currentUser>[0]) => {
    const user = currentUser(req);
    if (!user.mfaPending) throw Errors.conflict('Two-step sign-in is already done for this session.');
    return user;
  };
  const clearPending = (sessionId: string) =>
    db.update(sessions).set({ mfaPending: false }).where(eq(sessions.id, sessionId));

  /** Start setup: a new secret to add to the authenticator app. */
  app.post('/api/auth/mfa/setup', mfaLimit, async (req) => {
    const user = pendingUser(req);
    const [row] = await db.select({ on: users.totpEnabledAt, email: users.email, phone: users.phone })
      .from(users).where(eq(users.id, user.id));
    if (row?.on) throw Errors.conflict('Two-step sign-in is already set up. Enter the code from your app.');
    const secret = newTotpSecret();
    await db.update(users).set({ totpPendingSecret: sealSecret(secret) }).where(eq(users.id, user.id));
    return { secret, otpauthUrl: otpauthUrl(secret, row?.email ?? row?.phone ?? user.fullName) };
  });

  /** Finish setup with the first code; returns recovery codes, shown once. */
  app.post('/api/auth/mfa/enable', mfaLimit, async (req) => {
    const user = pendingUser(req);
    const { code } = codeBody.parse(req.body);
    const [row] = await db.select({ pending: users.totpPendingSecret, on: users.totpEnabledAt })
      .from(users).where(eq(users.id, user.id));
    if (row?.on) throw Errors.conflict('Two-step sign-in is already set up.');
    const secret = openSecret(row?.pending ?? null);
    if (!secret) throw Errors.conflict('Start setup again.');
    const step = verifyTotp(secret, code);
    if (step === null) throw Errors.validation('That code did not match. Check the time on your phone and try the newest code.');
    const recovery = newRecoveryCodes();
    await db.update(users).set({
      totpSecret: sealSecret(secret), totpPendingSecret: null, totpEnabledAt: new Date(), totpLastStep: step,
      totpRecoveryHashes: recovery.map((c) => hashToken(c.replace(/[^a-z0-9]/g, ''))),
    }).where(eq(users.id, user.id));
    await clearPending(user.sessionId);
    await recordAudit({ actor: actorFrom(req), action: 'auth.mfa_enabled', entityType: 'user', entityId: user.id });
    return { recoveryCodes: recovery };
  });

  /** Sign-in step two: a code from the app, or one recovery code. */
  app.post('/api/auth/mfa/verify', mfaLimit, async (req) => {
    const user = pendingUser(req);
    const { code } = codeBody.parse(req.body);
    const [row] = await db.select({
      secret: users.totpSecret, last: users.totpLastStep, recovery: users.totpRecoveryHashes,
    }).from(users).where(eq(users.id, user.id));
    const secret = openSecret(row?.secret ?? null);
    if (!secret) throw Errors.conflict('Two-step sign-in is not set up yet.');
    const step = verifyTotp(secret, code);
    if (step !== null) {
      if (row!.last !== null && step <= row!.last) throw Errors.validation('That code was already used. Wait for the next one.');
      await db.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id));
    } else {
      const hash = hashToken(code.toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (!row!.recovery.includes(hash)) throw Errors.validation('That code did not match.');
      await db.update(users).set({ totpRecoveryHashes: row!.recovery.filter((h) => h !== hash) }).where(eq(users.id, user.id));
      await recordAudit({ actor: actorFrom(req), action: 'auth.mfa_recovery_used', entityType: 'user', entityId: user.id,
        metadata: { remaining: row!.recovery.length - 1 } });
    }
    await clearPending(user.sessionId);
    await recordAudit({ actor: actorFrom(req), action: 'auth.mfa_verified', entityType: 'user', entityId: user.id });
    return { user: await loadSessionUser(user.id) };
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

      const patch: Partial<typeof users.$inferInsert> = { fullName: body.fullName, phone, status: 'active' };
      if (body.email) {
        const email = body.email.toLowerCase();
        const [taken] = await tx.select({ id: users.id }).from(users)
          .where(and(raw`lower(${users.email}) = ${email}`, isNull(users.deletedAt), ne(users.id, token.userId))).limit(1);
        if (taken) throw Errors.conflict('That email address is already used by another account.');
        patch.email = email;
      }
      await tx.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, token.id));
      await tx.update(users).set(patch).where(eq(users.id, token.userId));
      await setPassword(token.userId, body.password, { mustChange: false }, tx);
      await recordAudit({
        actor: { userId: token.userId, name: body.fullName, role: 'volunteer', ip: req.ip, requestId: req.id },
        action: 'auth.invite_accepted', entityType: 'user', entityId: token.userId,
      }, tx);
      return token.userId;
    });

    const [invited] = await db.select({ role: users.role }).from(users).where(eq(users.id, result));
    const mfaPending = roleNeedsMfa(invited?.role ?? 'volunteer');
    const session = await createSession(result, { ip: req.ip, userAgent: req.headers['user-agent'] as string }, { mfaPending });
    reply.setCookie(env.SESSION_COOKIE_NAME, session, cookieOptions(60 * 60 * 24 * 14));
    const acceptedUser = await loadSessionUser(result);
    if (acceptedUser && mfaPending) acceptedUser.mfa = 'setup';
    return { user: acceptedUser };
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

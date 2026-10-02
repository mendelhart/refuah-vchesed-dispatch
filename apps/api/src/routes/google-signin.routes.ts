import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql as raw } from 'drizzle-orm';
import { uuidSchema } from '@rvc/shared';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { actorFrom, currentUser, requireAdmin } from '../auth/guards.js';
import { createSession, loadSessionUser, roleNeedsMfa } from '../auth/session.js';
import { verifyGoogleIdToken } from '../auth/google.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { recordAudit } from '../lib/audit.js';
import { Errors } from '../lib/errors.js';
import { isOn, requireFlag } from '../lib/flags.js';
import { pgErrorCode } from '../lib/pg.js';

/**
 * Google sign-in (item 9). NEEDS MENDEL'S OK, WITH THIS DIFF, BEFORE MERGING.
 *
 * Off unless GOOGLE_SIGNIN_ENABLED is true and GOOGLE_CLIENT_ID is set.
 * Password sign-in is not touched. Google sign-in only signs in an existing,
 * active account that an administrator approved by name; it never creates
 * an account, never changes a role, and never skips the app's own two-step
 * check for the roles that need it.
 *
 * The browser goes to Google and comes back with a signed ID token (no
 * client secret is involved). The token must carry the one-time value this
 * browser was given (kept in a cookie and used once), so a token cannot be
 * replayed or pushed into somebody else's browser.
 */

const NONCE_COOKIE = 'rvc_google_nonce';
const googleSignInSchema = z.object({ credential: z.string().min(20).max(4096) });
const googleApprovalSchema = z.object({ userId: uuidSchema });
const on = requireFlag('googleSignIn');
const notApproved = () => Errors.unauthorized('This Google account is not set up for sign-in here. Sign in with your password, or ask an administrator.');

export async function googleSignInRoutes(app: FastifyInstance): Promise<void> {
  // Public: the sign-in page asks whether to show the Google button.
  app.get('/api/public/google-signin', async () => (
    isOn('googleSignIn') ? { enabled: true, clientId: env.GOOGLE_CLIENT_ID } : { enabled: false }
  ));

  app.post('/api/auth/google/start', {
    preHandler: on,
    config: { rateLimit: { max: () => env.LOGIN_MAX_PER_IP_PER_5MIN, timeWindow: '5 minutes' } },
  }, async (_req, reply) => {
    const nonce = generateToken(24);
    await db.execute(raw`delete from google_signin_nonces where expires_at < now() - interval '1 day'`);
    await db.execute(raw`insert into google_signin_nonces (nonce_hash, expires_at) values (${hashToken(nonce)}, now() + interval '10 minutes')`);
    reply.setCookie(NONCE_COOKIE, nonce, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/api/auth/google', maxAge: 600 });
    return { nonce, clientId: env.GOOGLE_CLIENT_ID };
  });

  app.post('/api/auth/google', {
    preHandler: on,
    config: { rateLimit: { max: () => env.LOGIN_MAX_PER_IP_PER_5MIN, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const { credential } = googleSignInSchema.parse(req.body);
    const nonce = req.cookies?.[NONCE_COOKIE];
    reply.clearCookie(NONCE_COOKIE, { path: '/api/auth/google' });
    if (!nonce) throw Errors.unauthorized('Google sign-in took too long or was started in another window. Try again.');

    const claims = await verifyGoogleIdToken(credential, { clientId: env.GOOGLE_CLIENT_ID!, nonce });
    // One use per value, within ten minutes.
    const used = await db.execute(raw`
      update google_signin_nonces set used_at = now()
       where nonce_hash = ${hashToken(nonce)} and used_at is null and expires_at > now() returning 1`);
    if (!used.length) throw Errors.unauthorized('Google sign-in took too long or was started in another window. Try again.');

    const [row] = await db.execute<{ approval_id: string; user_id: string; full_name: string; role: 'volunteer' | 'dispatcher' | 'admin'; status: string; locked_until: Date | null; totp_enabled_at: Date | null }>(raw`
      select a.id as approval_id, u.id as user_id, u.full_name, u.role, u.status, u.locked_until, u.totp_enabled_at
        from google_signin_approvals a join users u on u.id = a.user_id
       where a.email = ${claims.email} and a.revoked_at is null
         and lower(u.email) = a.email and u.deleted_at is null
       limit 1`);
    if (!row) {
      await recordAudit({
        actor: { userId: null, name: 'Unauthenticated', role: 'system', ip: req.ip, requestId: req.id },
        action: 'auth.google_refused', entityType: 'user', entityId: 'unknown', metadata: { reason: 'not_approved' },
      }).catch(() => undefined);
      throw notApproved();
    }
    if (row.locked_until && new Date(row.locked_until) > new Date()) throw Errors.rateLimited('Too many failed attempts. Try again in a few minutes.');
    if (row.status !== 'active') throw Errors.forbidden('Your account is not active. Please contact a coordinator.');

    await db.execute(raw`update users set last_login_at = now() where id = ${row.user_id}`);
    await db.execute(raw`update google_signin_approvals set last_used_at = now() where id = ${row.approval_id}`);
    const mfaPending = roleNeedsMfa(row.role);
    const token = await createSession(row.user_id, { ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined }, { mfaPending });
    const user = await loadSessionUser(row.user_id);
    if (!user) throw Errors.internal();
    if (mfaPending) user.mfa = row.totp_enabled_at ? 'verify' : 'setup';
    await recordAudit({
      actor: { userId: row.user_id, name: row.full_name, role: row.role, ip: req.ip, requestId: req.id },
      action: 'auth.login', entityType: 'user', entityId: row.user_id, metadata: { method: 'google' },
    });
    reply.setCookie(env.SESSION_COOKIE_NAME, token, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 14 });
    return { user };
  });

  // --- administrators approve people by name -----------------------------------------

  const admin = { preHandler: [requireAdmin, on] };

  app.get('/api/admin/google-signin', admin, async () => {
    const approvals = await db.execute<{ id: string; user_id: string; full_name: string; email: string; role: string; approved_at: string; approved_by: string | null; last_used_at: string | null; matches: boolean }>(raw`
      select a.id, a.user_id, u.full_name, a.email, u.role, a.approved_at, b.full_name as approved_by, a.last_used_at,
             (lower(coalesce(u.email, '')) = a.email and u.deleted_at is null and u.status = 'active') as matches
        from google_signin_approvals a join users u on u.id = a.user_id left join users b on b.id = a.approved_by_id
       where a.revoked_at is null order by u.full_name`);
    const people = await db.execute<{ id: string; full_name: string; email: string; role: string }>(raw`
      select u.id, u.full_name, lower(u.email) as email, u.role from users u
       where u.deleted_at is null and u.status = 'active' and u.email is not null and u.email <> ''
         and not exists (select 1 from google_signin_approvals a where a.user_id = u.id and a.revoked_at is null)
       order by (u.role = 'volunteer'), u.full_name limit 1000`);
    return {
      approvals: approvals.map((a) => ({
        id: a.id, userId: a.user_id, fullName: a.full_name, email: a.email, role: a.role,
        approvedAt: a.approved_at, approvedBy: a.approved_by, lastUsedAt: a.last_used_at, stillMatches: Boolean(a.matches),
      })),
      people: people.map((p) => ({ id: p.id, fullName: p.full_name, email: p.email, role: p.role })),
    };
  });

  app.post('/api/admin/google-signin', admin, async (req, reply) => {
    const { userId } = googleApprovalSchema.parse(req.body);
    const [u] = await db.execute<{ email: string | null; status: string }>(raw`
      select lower(email) as email, status from users where id = ${userId} and deleted_at is null`);
    if (!u) throw Errors.notFound('Person');
    if (!u.email) throw Errors.validation('This person has no email address. Add their Google address to their account first.');
    if (u.status !== 'active') throw Errors.validation('Only active accounts can be approved.');
    try {
      const [row] = await db.execute<{ id: string }>(raw`
        insert into google_signin_approvals (user_id, email, approved_by_id) values (${userId}, ${u.email}, ${currentUser(req).id}) returning id`);
      await recordAudit({ actor: actorFrom(req), action: 'auth.google_approved', entityType: 'user', entityId: userId, next: { email: u.email } });
      reply.code(201);
      return { id: row!.id };
    } catch (err) {
      if (pgErrorCode(err) === '23505') throw Errors.conflict('This person or this address is already approved.');
      throw err;
    }
  });

  app.post('/api/admin/google-signin/:id/revoke', admin, async (req) => {
    const { id } = z.object({ id: uuidSchema }).parse(req.params);
    const [row] = await db.execute<{ user_id: string }>(raw`
      update google_signin_approvals set revoked_at = now(), revoked_by_id = ${currentUser(req).id}
       where id = ${id} and revoked_at is null returning user_id`);
    if (!row) throw Errors.notFound('Approval');
    await recordAudit({ actor: actorFrom(req), action: 'auth.google_revoked', entityType: 'user', entityId: row.user_id });
    return { ok: true };
  });
}

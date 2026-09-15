import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  changeRoleSchema, createUserSchema, pushSubscriptionSchema,
  updateMeSchema, updateUserSchema, uuidSchema,
} from '@rvc/shared';
import { db } from '../db/client.js';
import { pushSubscriptions, users, volunteerGroups } from '../db/schema.js';
import { actorFrom, currentUser, requireAdmin, requireAuth, requireDispatcher } from '../auth/guards.js';
import { changeRole, createUser, deactivateUser, issueAuthToken, listUsers, updateUser } from '../domain/users.service.js';
import { volunteerImpact } from '../domain/impact.js';
import { loadSessionUser } from '../auth/session.js';
import { recordAudit } from '../lib/audit.js';
import { normalizePhone } from '../lib/phone.js';
import { vapidPublicKey } from '../services/providers/index.js';
import { Errors } from '../lib/errors.js';

const idParam = z.object({ id: uuidSchema });

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', { preHandler: requireAuth }, async (req) => {
    const q = z.object({
      role: z.enum(['volunteer', 'dispatcher', 'admin']).optional(),
      groupSlug: z.string().max(60).optional(),
      status: z.string().max(20).optional(),
      search: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const user = currentUser(req);
    return { users: await listUsers(user.role, q) };
  });

  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const { user, inviteUrl } = await createUser(actorFrom(req), body);
    reply.status(201);
    // The invite URL is returned to the admin so they can pass it on until
    // transactional email is wired up (see docs/DEPLOYMENT.md).
    return { user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role }, inviteUrl };
  });

  app.patch('/api/users/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateUserSchema.parse(req.body);
    const actor = currentUser(req);
    // Dispatchers may maintain the roster; only admins may change status.
    if (actor.role !== 'admin' && body.status) throw Errors.forbidden('Only administrators can change account status.');
    const updated = await updateUser(actorFrom(req), id, body as Record<string, unknown>);
    return { user: { id: updated.id, fullName: updated.fullName, status: updated.status } };
  });

  app.post('/api/users/:id/role', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = changeRoleSchema.parse(req.body);
    const updated = await changeRole(actorFrom(req), id, body.role);
    return { user: { id: updated.id, role: updated.role } };
  });

  app.post('/api/users/:id/deactivate', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    await deactivateUser(actorFrom(req), id, body.reason);
    return { ok: true };
  });

  app.post('/api/users/:id/resend-invite', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { url } = await issueAuthToken(id, 'invite', 60 * 24 * 7);
    await recordAudit({ actor: actorFrom(req), action: 'user.invite_resent', entityType: 'user', entityId: id });
    return { inviteUrl: url };
  });

  // --- self service --------------------------------------------------------

  app.patch('/api/me', { preHandler: requireAuth }, async (req) => {
    const body = updateMeSchema.parse(req.body);
    const user = currentUser(req);
    await updateUser(actorFrom(req), user.id, body as Record<string, unknown>);
    return { user: await loadSessionUser(user.id) };
  });

  app.get('/api/me/impact', { preHandler: requireAuth }, async (req) =>
    volunteerImpact(currentUser(req).id),
  );

  /**
   * Snooze. Without this, volunteers at scale either ignore every message or
   * turn notifications off for good — the reference product's own SMS inbox
   * was full of people typing "#Mute" at a human.
   */
  app.post('/api/me/mute', { preHandler: requireAuth }, async (req) => {
    const body = z.object({ hours: z.number().int().min(0).max(24 * 30) }).parse(req.body);
    const user = currentUser(req);
    const until = body.hours === 0 ? null : new Date(Date.now() + body.hours * 3_600_000);
    await db.update(users).set({ mutedUntil: until }).where(eq(users.id, user.id));
    await recordAudit({
      actor: actorFrom(req), action: body.hours === 0 ? 'user.unmuted' : 'user.muted',
      entityType: 'user', entityId: user.id, metadata: { hours: body.hours },
    });
    return { mutedUntil: until };
  });

  app.get('/api/me/status', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const [row] = await db.select({ mutedUntil: users.mutedUntil, availability: users.availability })
      .from(users).where(eq(users.id, user.id)).limit(1);
    return { mutedUntil: row?.mutedUntil ?? null, availability: row?.availability ?? null };
  });

  // --- push ----------------------------------------------------------------

  /** The client subscribes with the key the server actually signs with, so the
   *  two can never diverge — the legacy app hard-coded a public demo key. */
  app.get('/api/push/public-key', async () => ({ publicKey: vapidPublicKey() }));

  app.post('/api/push/subscribe', { preHandler: requireAuth }, async (req) => {
    const body = pushSubscriptionSchema.parse(req.body);
    const user = currentUser(req);
    await db.insert(pushSubscriptions).values({
      userId: user.id, endpoint: body.endpoint, p256dh: body.keys.p256dh,
      auth: body.keys.auth, userAgent: body.userAgent ?? null,
    }).onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: user.id, p256dh: body.keys.p256dh, auth: body.keys.auth, disabledAt: null, failureCount: 0 },
    });
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', { preHandler: requireAuth }, async (req) => {
    const body = z.object({ endpoint: z.string().url() }).parse(req.body);
    await db.delete(pushSubscriptions).where(
      and(eq(pushSubscriptions.endpoint, body.endpoint), eq(pushSubscriptions.userId, currentUser(req).id)),
    );
    return { ok: true };
  });

  app.get('/api/groups', { preHandler: requireAuth }, async () => ({
    groups: await db.select({ id: volunteerGroups.id, slug: volunteerGroups.slug, name: volunteerGroups.name })
      .from(volunteerGroups).where(eq(volunteerGroups.active, true)),
  }));

  app.get('/api/directory', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const rows = await listUsers(user.role, { limit: 500, status: 'active' });
    return { volunteers: rows };
  });

  void isNull; void normalizePhone;
}

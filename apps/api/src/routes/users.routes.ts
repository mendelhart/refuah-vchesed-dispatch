import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import {
  changeRoleSchema, createUserSchema, pushSubscriptionSchema, resendInviteSchema,
  updateMeSchema, updateUserSchema, uuidSchema, directMessageSchema, suspendUserSchema,
} from '@rvc/shared';
import { db } from '../db/client.js';
import { pushSubscriptions, users, volunteerGroups } from '../db/schema.js';
import { actorFrom, currentUser, requireAdmin, requireAuth, requireDispatcher } from '../auth/guards.js';
import { changeRole, createUser, deactivateUser, suspendUser, reactivateUser, issueAuthToken, listUsers, sendInvitation, updateUser } from '../domain/users.service.js';
import { volunteerImpact, organizationImpact } from '../domain/impact.js';
import { loadSessionUser } from '../auth/session.js';
import { recordAudit } from '../lib/audit.js';
import { revokeAllSessionsForUser } from '../auth/session.js';
import { normalizePhone } from '../lib/phone.js';
import { channelStatus, vapidPublicKey } from '../services/providers/index.js';
import { Errors } from '../lib/errors.js';
import { isStoredPhoto, parsePhotoDataUrl } from '../lib/photo.js';
import { messageVolunteer } from '../domain/conversations.service.js';

const idParam = z.object({ id: uuidSchema });

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // --- ID card photos -------------------------------------------------------
  const photoBody = z.object({ photo: z.string().max(600_000) });
  const setPhoto = async (actorReq: Parameters<typeof actorFrom>[0], userId: string, photo: string | null) => {
    if (photo !== null) parsePhotoDataUrl(photo);
    const [row] = await db.update(users).set({ photoUrl: photo }).where(eq(users.id, userId)).returning({ id: users.id });
    if (!row) throw Errors.notFound('Person');
    await recordAudit({
      actor: actorFrom(actorReq), action: photo ? 'user.photo_set' : 'user.photo_removed', entityType: 'user', entityId: userId,
    });
  };

  app.put('/api/me/photo', { preHandler: requireAuth }, async (req) => {
    const { photo } = photoBody.parse(req.body);
    await setPhoto(req, currentUser(req).id, photo);
    return { ok: true };
  });
  app.delete('/api/me/photo', { preHandler: requireAuth }, async (req) => {
    await setPhoto(req, currentUser(req).id, null);
    return { ok: true };
  });
  app.put('/api/users/:id/photo', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { photo } = photoBody.parse(req.body);
    await setPhoto(req, id, photo);
    return { ok: true };
  });
  app.delete('/api/users/:id/photo', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await setPhoto(req, id, null);
    return { ok: true };
  });
  app.get('/api/users/:id/photo', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select({ photo: users.photoUrl }).from(users).where(eq(users.id, id)).limit(1);
    if (!row || !isStoredPhoto(row.photo)) throw Errors.notFound('Photo');
    const { mime, bytes } = parsePhotoDataUrl(row.photo);
    reply.header('Content-Type', mime).header('Cache-Control', 'private, max-age=86400');
    return reply.send(bytes);
  });

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

  // Coordinators (role 'dispatcher') may add volunteers; anything else is admin-only.
  app.post('/api/users', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    if (currentUser(req).role !== 'admin' && body.role !== 'volunteer') {
      throw Errors.forbidden('Only an admin can add coordinators or admins.');
    }
    const { user, inviteUrl, invitedVia } = await createUser(actorFrom(req), body);
    reply.status(201);
    // The invite URL is returned to the admin so they can pass it on until
    // transactional email is wired up (see docs/DEPLOYMENT.md).
    return { user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role }, inviteUrl, invitedVia };
  });

  app.get('/api/messaging/status', { preHandler: requireDispatcher }, async () => ({ channels: channelStatus() }));

  app.post('/api/users/:id/message', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = directMessageSchema.parse(req.body);
    return messageVolunteer(actorFrom(req), id, body.channel, body.body);
  });

  app.patch('/api/users/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateUserSchema.parse(req.body);
    const actor = currentUser(req);
    if (actor.role !== 'admin' && id !== actor.id) {
      const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
      if (target && target.role === 'admin') throw Errors.forbidden('Only an admin can change an admin.');
    }
    // Dispatchers may maintain the roster; only admins may change status.
    if (actor.role !== 'admin' && body.status) throw Errors.forbidden('Only administrators can change account status.');
    const updated = await updateUser(actorFrom(req), id, body as Record<string, unknown>);
    return { user: { id: updated.id, fullName: updated.fullName, status: updated.status } };
  });

  // Lost phone: clear someone's authenticator so they set it up again at next sign-in.
  app.post('/api/users/:id/mfa/reset', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.update(users).set({
      totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: [],
    }).where(eq(users.id, id)).returning({ id: users.id });
    if (!row) throw Errors.notFound('User');
    await revokeAllSessionsForUser(id);
    await recordAudit({ actor: actorFrom(req), action: 'auth.mfa_reset', entityType: 'user', entityId: id });
    return { ok: true };
  });

  app.post('/api/users/:id/role', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = changeRoleSchema.parse(req.body);
    const updated = await changeRole(actorFrom(req), id, body.role);
    return { user: { id: updated.id, role: updated.role } };
  });

  const volunteerOnlyForCoordinators = async (req: Parameters<typeof currentUser>[0], id: string, verb: string) => {
    const me = currentUser(req);
    if (me.role === 'admin') return;
    const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
    if (!target || target.role !== 'volunteer' || id === me.id) {
      throw Errors.forbidden(`Only an admin can ${verb} a coordinator or admin.`);
    }
  };
  app.post('/api/users/:id/suspend', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = suspendUserSchema.parse(req.body);
    await volunteerOnlyForCoordinators(req, id, 'pause');
    const u = await suspendUser(actorFrom(req), id, body.until ? new Date(body.until) : null, body.reason ?? null);
    return { user: { id: u.id, status: u.status, suspendedUntil: u.suspendedUntil } };
  });
  app.post('/api/users/:id/reactivate', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    await volunteerOnlyForCoordinators(req, id, 'reactivate');
    const u = await reactivateUser(actorFrom(req), id);
    return { user: { id: u.id, status: u.status } };
  });

  // Admins can remove anyone. Coordinators can remove volunteers only.
  app.post('/api/users/:id/deactivate', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    const me = currentUser(req);
    if (me.role !== 'admin') {
      const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
      if (!target || target.role !== 'volunteer' || id === me.id) {
        throw Errors.forbidden('Only an admin can remove a coordinator or admin.');
      }
    }
    await deactivateUser(actorFrom(req), id, body.reason);
    return { ok: true };
  });

  app.post('/api/users/:id/resend-invite', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = resendInviteSchema.parse(req.body ?? {});
    const [target] = await db.select({ id: users.id, fullName: users.fullName, email: users.email, phone: users.phone })
      .from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).limit(1);
    if (!target) throw Errors.notFound('User');
    if (body.inviteVia.includes('email') && !target.email) throw Errors.validation('No email address on file.', { field: 'inviteVia' });
    if ((body.inviteVia.includes('sms') || body.inviteVia.includes('whatsapp')) && !target.phone) {
      throw Errors.validation('No mobile number on file.', { field: 'inviteVia' });
    }
    const { url } = await issueAuthToken(id, 'invite', 60 * 24 * 7);
    await recordAudit({ actor: actorFrom(req), action: 'user.invite_resent', entityType: 'user', entityId: id });
    if (body.inviteVia.length) await sendInvitation(actorFrom(req), id, target.fullName, url, body.inviteVia);
    return { inviteUrl: url, invitedVia: body.inviteVia };
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

  /** The whole organisation's impact, shown to dispatchers and admins under Admin. */
  app.get('/api/impact', { preHandler: requireDispatcher }, async () => organizationImpact());

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

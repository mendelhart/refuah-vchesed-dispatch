import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, sql as raw } from 'drizzle-orm';
import { DEFAULT_SETTINGS, SETTING_KEYS, updateSettingSchema } from '@rvc/shared';
import { db } from '../db/client.js';
import { auditEvents, jobs, notificationDeliveries, notifications, smsEvents, users } from '../db/schema.js';
import { actorFrom, currentUser, requireAdmin, requireAuth, requireDispatcher } from '../auth/guards.js';
import { loadSettings, setSetting } from '../lib/settings.js';
import { deliveryHealth } from '../services/notification.service.js';
import { deadJobCount } from '../jobs/queue.js';
import { recordAudit } from '../lib/audit.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /** Audit search. Read-only by construction: the table rejects writes. */
  app.get('/api/audit', { preHandler: requireDispatcher }, async (req) => {
    const q = z.object({
      entityType: z.string().max(40).optional(),
      entityId: z.string().max(80).optional(),
      actorUserId: z.string().uuid().optional(),
      action: z.string().max(60).optional(),
      since: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);

    const conditions = [];
    if (q.entityType) conditions.push(eq(auditEvents.entityType, q.entityType));
    if (q.entityId) conditions.push(eq(auditEvents.entityId, q.entityId));
    if (q.actorUserId) conditions.push(eq(auditEvents.actorUserId, q.actorUserId));
    if (q.action) conditions.push(eq(auditEvents.action, q.action));
    if (q.since) conditions.push(gte(auditEvents.occurredAt, q.since));

    const rows = await db.select().from(auditEvents)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditEvents.occurredAt)).limit(q.limit);
    return { events: rows };
  });

  /** Notification delivery — the screen that makes failures impossible to miss. */
  app.get('/api/notifications/deliveries', { preHandler: requireDispatcher }, async (req) => {
    const q = z.object({
      status: z.enum(['queued', 'sent', 'delivered', 'failed', 'skipped']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);
    const rows = await db.select({
      id: notificationDeliveries.id, channel: notificationDeliveries.channel,
      status: notificationDeliveries.status, attempts: notificationDeliveries.attempts,
      lastError: notificationDeliveries.lastError, queuedAt: notificationDeliveries.queuedAt,
      sentAt: notificationDeliveries.sentAt, event: notifications.event,
      title: notifications.title, recipientName: users.fullName, tripId: notifications.tripId,
    }).from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(q.status ? eq(notificationDeliveries.status, q.status) : undefined)
      .orderBy(desc(notificationDeliveries.queuedAt)).limit(q.limit);
    return { deliveries: rows, health: await deliveryHealth() };
  });

  /** A volunteer's own notification feed (the in-app channel). */
  app.get('/api/notifications', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const rows = await db.select({
      id: notifications.id, event: notifications.event, title: notifications.title,
      body: notifications.body, tripId: notifications.tripId,
      createdAt: notifications.createdAt, readAt: notifications.readAt,
    }).from(notifications).where(eq(notifications.userId, user.id))
      .orderBy(desc(notifications.createdAt)).limit(50);
    return { notifications: rows, unread: rows.filter((r) => !r.readAt).length };
  });

  app.post('/api/notifications/read', { preHandler: requireAuth }, async (req) => {
    const body = z.object({ ids: z.array(z.string().uuid()).max(100).optional() }).parse(req.body ?? {});
    const user = currentUser(req);
    await db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.userId, user.id), raw`${notifications.readAt} is null`,
        body.ids?.length ? raw`${notifications.id} = any(${body.ids})` : raw`true`));
    return { ok: true };
  });

  app.get('/api/sms-events', { preHandler: requireDispatcher }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    const rows = await db.select({
      id: smsEvents.id, direction: smsEvents.direction, outcome: smsEvents.outcome,
      detail: smsEvents.detail, signatureValid: smsEvents.signatureValid,
      createdAt: smsEvents.createdAt, matchedUserName: users.fullName,
    }).from(smsEvents).leftJoin(users, eq(users.id, smsEvents.matchedUserId))
      .orderBy(desc(smsEvents.createdAt)).limit(q.limit);
    return { events: rows };
  });

  app.get('/api/settings', { preHandler: requireDispatcher }, async () => ({
    settings: await loadSettings(), defaults: DEFAULT_SETTINGS,
  }));

  /** Which optional screens are switched on. Everyone signed in needs this for the menu. */
  app.get('/api/features', { preHandler: requireAuth }, async () => {
    const s = await loadSettings();
    const on = (key: string) => Number(s[key] ?? 1) !== 0;
    return { announcements: on(SETTING_KEYS.featureAnnouncements) };
  });

  app.put('/api/settings/:key', { preHandler: requireAdmin }, async (req) => {
    const { key } = z.object({ key: z.string().max(80) }).parse(req.params);
    const body = updateSettingSchema.parse(req.body);
    if (!(key in DEFAULT_SETTINGS)) {
      return { error: { code: 'unknown_setting', message: `Unknown setting "${key}"` } };
    }
    const before = (await loadSettings())[key];
    await setSetting(key, body.value, currentUser(req).id);
    await recordAudit({
      actor: actorFrom(req), action: 'setting.changed', entityType: 'setting', entityId: key,
      previous: { value: before }, next: { value: body.value },
    });
    return { key, value: body.value };
  });

  /** Operational health, used by monitoring and shown on the board. */
  app.get('/api/ops/health', { preHandler: requireDispatcher }, async () => {
    const [deliveries, dead] = await Promise.all([deliveryHealth(), deadJobCount()]);
    const [jobRow] = await db.select({
      pending: raw<number>`count(*) filter (where ${jobs.status} = 'pending')::int`,
      running: raw<number>`count(*) filter (where ${jobs.status} = 'running')::int`,
      overdue: raw<number>`count(*) filter (where ${jobs.status} = 'pending' and ${jobs.runAt} < now() - interval '5 minutes')::int`,
    }).from(jobs);
    return { deliveries, jobs: { ...jobRow, dead } };
  });
}

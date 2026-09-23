import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  announcementSchema,
  audienceSchema,
  bulkAssignSchema,
  bulkOfferSchema,
  calendarRangeSchema,
  dutyShiftSchema,
  exportRequestSchema,
  sendAnnouncementSchema,
  updateTemplateSchema,
  uuidSchema,
} from '@rvc/shared';
import {
  actorFrom,
  currentUser,
  requireAdmin,
  requireAuth,
  requireDispatcher,
} from '../auth/guards.js';
import { Errors } from '../lib/errors.js';
import { getTemplate, listTemplates, revertTemplate, updateTemplate } from '../services/templates.service.js';
import { createShift, listShifts, removeShift, shiftAt } from '../domain/duty.service.js';
import { getExport, listExports, requestExport } from '../domain/exports.service.js';
import {
  createAnnouncement,
  listAnnouncements,
  previewAnnouncement,
  sendAnnouncement,
  getAnnouncementImage,
} from '../domain/announcements.service.js';
import { readFile } from '../services/files.service.js';
import { assignTrip, offerTrip, duplicateTrip, type TripActor } from '../domain/dispatch.service.js';
import { hebrewDays, restPeriodsBetween, zmanimFor } from '../lib/hebcal.js';
import { barcodeFor, findByBarcode, labelData, overdueLoans, confirmLoanBySms } from '../domain/equipment.service.js';
import { localDateString, addDaysToDateString, fromLocalDateString } from '../lib/time.js';

const idParam = z.object({ id: uuidSchema });

function tripActor(req: FastifyRequest): TripActor {
  return { user: currentUser(req), audit: actorFrom(req) };
}

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Message templates
  // -------------------------------------------------------------------------
  app.get('/api/templates', { preHandler: requireAdmin }, async () => ({
    templates: await listTemplates(),
  }));

  app.get('/api/templates/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { template: await getTemplate(id) };
  });

  app.patch('/api/templates/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateTemplateSchema.parse(req.body);
    return { template: await updateTemplate(actorFrom(req), id, body) };
  });

  app.post('/api/templates/:id/revert', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ version: z.number().int().min(1) }).parse(req.body);
    return { template: await revertTemplate(actorFrom(req), id, body.version) };
  });

  // -------------------------------------------------------------------------
  // Duty roster
  // -------------------------------------------------------------------------
  app.get('/api/duty', { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        kind: z.string().max(20).optional(),
      })
      .parse(req.query);
    const from = q.from ?? new Date();
    const to = q.to ?? new Date(from.getTime() + 28 * 86_400_000);
    return { shifts: await listShifts(from, to, q.kind), onDutyNow: await shiftAt() };
  });

  app.post('/api/duty', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = dutyShiftSchema.parse(req.body);
    const shift = await createShift(actorFrom(req), body);
    reply.status(201);
    return { shift };
  });

  app.delete('/api/duty/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    await removeShift(actorFrom(req), id);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Hebrew calendar and zmanim
  // -------------------------------------------------------------------------
  app.get('/api/calendar/zmanim', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ date: z.coerce.date().optional() }).parse(req.query);
    return { zmanim: zmanimFor(q.date ?? new Date()) };
  });

  app.get('/api/calendar/hebrew', { preHandler: requireAuth }, async (req) => {
    const q = calendarRangeSchema.parse(req.query);
    return { days: hebrewDays(q.from, q.days) };
  });

  /**
   * Shabbos and yom tov boundaries for the dispatcher board.
   *
   * The board shows these so a trip is not scheduled across a boundary by
   * accident. It is information, not enforcement — a ride that has to happen
   * during Shabbos is precisely the kind of ride this organisation exists for,
   * and the software has no business refusing it.
   */
  app.get('/api/calendar/rest-periods', { preHandler: requireAuth }, async (req) => {
    const q = z
      .object({
        from: z.coerce.date().optional(),
        days: z.coerce.number().int().min(1).max(60).default(14),
      })
      .parse(req.query);
    const from = q.from ?? new Date();
    return {
      periods: restPeriodsBetween(from, new Date(from.getTime() + q.days * 86_400_000)),
    };
  });

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------
  // Exports contain patient data, so they are admin-only (audit, Sep 2026).
  app.get('/api/exports', { preHandler: requireAdmin }, async (req) => {
    const user = currentUser(req);
    return { exports: await listExports(user.role === 'admin' ? undefined : user.id) };
  });

  app.post('/api/exports', { preHandler: requireAdmin }, async (req, reply) => {
    const body = exportRequestSchema.parse(req.body);
    const { kind, ...params } = body;
    const row = await requestExport(actorFrom(req), kind, params);
    reply.status(202);
    return { export: row };
  });

  app.get('/api/exports/:id/download', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = await getExport(id);
    if (row.status !== 'ready' || !row.fileId) {
      throw Errors.conflict(`That export is ${row.status}.`);
    }
    const user = currentUser(req);
    if (user.role !== 'admin' && row.requestedById !== user.id) {
      throw Errors.forbidden('That export belongs to someone else.');
    }
    const file = await readFile(actorFrom(req), row.fileId, `export download (${row.kind})`);
    return reply
      .type('text/csv; charset=utf-8')
      .header('cache-control', 'no-store, private')
      .header('content-disposition', `attachment; filename="${row.kind}-${localDateString(row.createdAt)}.csv"`)
      .send(file.buffer);
  });

  // -------------------------------------------------------------------------
  // Announcements
  // -------------------------------------------------------------------------
  // Previewing is a read: a dispatcher opening the screen needs the count even
  // though only an admin may send. Making the preview admin-only left the page
  // showing a 403 where the number belongs.
  app.post('/api/announcements/preview', { preHandler: requireDispatcher }, async (req) => {
    const audience = audienceSchema.parse(req.body);
    return previewAnnouncement(audience);
  });

  app.get('/api/announcements', { preHandler: requireDispatcher }, async () => ({
    announcements: await listAnnouncements(),
  }));

  // Coordinators broadcast too (simchas, reminders); the recipient-count
  // confirmation and the max-recipients ceiling still apply to everyone.
  app.post('/api/announcements', { preHandler: requireDispatcher, bodyLimit: 2_000_000 }, async (req, reply) => {
    const body = announcementSchema.parse(req.body);
    const row = await createAnnouncement(actorFrom(req), body);
    reply.status(201);
    return { announcement: row };
  });

  app.post('/api/announcements/:id/send', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = sendAnnouncementSchema.parse(req.body);
    return sendAnnouncement(actorFrom(req), id, body.confirmRecipientCount);
  });

  // Public on purpose: SMS, WhatsApp and email recipients open this link
  // without signing in. The id is a random UUID and only a picture is served.
  app.get('/api/announcements/:id/image', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const image = await getAnnouncementImage(id);
    if (!image) throw Errors.notFound('Picture');
    reply.header('Content-Type', image.mime).header('Cache-Control', 'public, max-age=604800, immutable');
    return reply.send(image.bytes);
  });

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  /**
   * Bulk assign and bulk offer.
   *
   * Each trip is processed independently and the response reports per-trip
   * outcomes. One trip whose state moved on must not abort the other nine —
   * and a bulk operation that reports "done" while having silently skipped
   * three is worse than one that fails loudly.
   */
  app.post('/api/trips/bulk/assign', { preHandler: requireDispatcher }, async (req) => {
    const body = bulkAssignSchema.parse(req.body);
    const actor = tripActor(req);
    const results: Array<{ tripId: string; ok: boolean; error?: string }> = [];
    for (const tripId of body.tripIds) {
      try {
        await assignTrip(actor, tripId, body.volunteerId, body.reason);
        results.push({ tripId, ok: true });
      } catch (err) {
        results.push({ tripId, ok: false, error: (err as Error).message });
      }
    }
    return {
      results,
      assigned: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  });

  app.post('/api/trips/bulk/offer', { preHandler: requireDispatcher }, async (req) => {
    const body = bulkOfferSchema.parse(req.body);
    const actor = tripActor(req);
    const results: Array<{ tripId: string; ok: boolean; offered?: number; error?: string }> = [];
    for (const tripId of body.tripIds) {
      try {
        const out = await offerTrip(actor, tripId, { expiresInMinutes: body.expiresInMinutes });
        results.push({ tripId, ok: true, offered: out.offered });
      } catch (err) {
        results.push({ tripId, ok: false, error: (err as Error).message });
      }
    }
    return {
      results,
      offered: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  });

  // -------------------------------------------------------------------------
  // Equipment: barcode, labels, reminders
  // -------------------------------------------------------------------------
  app.get('/api/equipment/scan/:code', { preHandler: requireDispatcher }, async (req) => {
    const { code } = z.object({ code: z.string().trim().max(40) }).parse(req.params);
    return findByBarcode(code);
  });

  app.post('/api/equipment/labels', { preHandler: requireDispatcher }, async (req) => {
    const body = z.object({ ids: z.array(uuidSchema).min(1).max(100) }).parse(req.body);
    return { labels: await labelData(body.ids) };
  });

  app.get('/api/equipment/overdue', { preHandler: requireDispatcher }, async () => ({
    loans: await overdueLoans(),
  }));

  app.post('/api/equipment/loans/:id/confirm-sms', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return confirmLoanBySms(actorFrom(req), id);
  });

  app.get('/api/equipment/barcode-for/:itemCode', { preHandler: requireDispatcher }, async (req) => {
    const { itemCode } = z.object({ itemCode: z.string().trim().max(40) }).parse(req.params);
    return { barcode: barcodeFor(itemCode) };
  });

  // -------------------------------------------------------------------------
  // Duplicate ride
  // -------------------------------------------------------------------------
  app.post('/api/trips/:id/duplicate', { preHandler: requireDispatcher }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        pickupAt: z.coerce.date().optional(),
        priority: z.string().max(20).optional(),
        passengerNotes: z.string().max(2000).optional().nullable(),
      })
      .parse(req.body ?? {});
    const trip = await duplicateTrip(tripActor(req), id, body);
    reply.status(201);
    return { trip };
  });

  // -------------------------------------------------------------------------
  // Board context: what a dispatcher needs on screen beside the trips
  // -------------------------------------------------------------------------
  app.get('/api/board/context', { preHandler: requireDispatcher }, async () => {
    const today = localDateString(new Date());
    const { unreadThreadCount } = await import('../domain/conversations.service.js');
    const { applicationCounts } = await import('../domain/applications.service.js');
    return {
      onDutyNow: await shiftAt(),
      unreadConversations: await unreadThreadCount(),
      applications: await applicationCounts(),
      overdueEquipment: (await overdueLoans()).length,
      restPeriods: restPeriodsBetween(new Date(), new Date(Date.now() + 8 * 86_400_000)),
      hebrewToday: hebrewDays(today, 1)[0],
      zmanim: zmanimFor(new Date()),
      tomorrow: addDaysToDateString(today, 1),
      nextMidnight: fromLocalDateString(addDaysToDateString(today, 1), 0).toISOString(),
    };
  });
}

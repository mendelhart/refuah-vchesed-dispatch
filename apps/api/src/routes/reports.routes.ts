import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { actorFrom, currentUser, requireDispatcher } from '../auth/guards.js';
import { recordAudit } from '../lib/audit.js';
import { requireFlag } from '../lib/flags.js';
import { departmentTotals, equipmentStatus, resolveRange, staffing, toCsv, trends } from '../domain/reports.service.js';

/** Reports (item 8). Coordinators and admins; in the 'reports' department
 *  for item 4. 404 while REPORTS_ENABLED is off. */
const on = requireFlag('reports');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z.object({ from: day.optional(), to: day.optional() });
const csv = (reply: FastifyReply, name: string, body: string) => {
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${name}"`);
  reply.header('cache-control', 'no-store');
  return body;
};

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  const pre = { preHandler: [requireDispatcher, on] };

  app.get('/api/reports/summary', pre, async (req) => {
    const q = rangeQuery.parse(req.query);
    return departmentTotals(resolveRange(q.from, q.to));
  });

  app.get('/api/reports/trends', pre, async (req) => {
    const q = rangeQuery.extend({ interval: z.enum(['day', 'week', 'month']).default('week') }).parse(req.query);
    return trends(resolveRange(q.from, q.to), q.interval);
  });

  app.get('/api/reports/staffing', pre, async (req) => {
    const q = rangeQuery.parse(req.query);
    return staffing(resolveRange(q.from, q.to));
  });

  app.get('/api/reports/equipment', pre, async (req) => equipmentStatus(currentUser(req).role === 'admin'));

  app.get('/api/reports/export.csv', pre, async (req, reply) => {
    const q = rangeQuery.extend({ report: z.enum(['summary', 'trends', 'staffing']).default('summary'), interval: z.enum(['day', 'week', 'month']).default('week') }).parse(req.query);
    const r = resolveRange(q.from, q.to);
    await recordAudit({ actor: actorFrom(req), action: 'report.exported', entityType: 'report', entityId: q.report, metadata: { from: r.from, to: r.to } });
    if (q.report === 'trends') {
      const t = await trends(r, q.interval);
      return csv(reply, `rvc-trends-${r.from}-${r.to}.csv`, toCsv(['period', 'rides', 'food', 'equipment'],
        t.periods.map((p) => [p.period, p.rides ?? 0, p.food ?? 0, p.equipment ?? 0])));
    }
    if (q.report === 'staffing') {
      const s = await staffing(r);
      return csv(reply, `rvc-staffing-${r.from}-${r.to}.csv`, toCsv(['measure', 'value'], [
        ['rides requested', s.rides.total], ['rides with a driver', s.rides.covered], ['percent with a driver', s.rides.coveredPercent ?? ''],
        ['rides never filled', s.rides.unfilled], ['median minutes to a driver', s.rides.medianMinutesToDriver ?? ''],
        ['phone duty hours', s.phoneDuty.hoursCovered], ['phone duty percent of hours', s.phoneDuty.percentOfHours],
        ['kitchen places needed', s.kitchen.placesNeeded], ['kitchen places filled', s.kitchen.placesFilled],
      ]));
    }
    const sum = await departmentTotals(r);
    return csv(reply, `rvc-summary-${r.from}-${r.to}.csv`, toCsv(['department', 'requested', 'completed', 'cancelled', 'volunteers', 'people helped'],
      Object.entries(sum.departments).map(([d, v]) => [d, v.requested, v.completed, v.cancelled, v.volunteers, v.people])));
  });
}

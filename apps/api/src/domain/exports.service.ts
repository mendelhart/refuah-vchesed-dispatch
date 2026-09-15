import { eq, sql as raw } from 'drizzle-orm';
import { EXPORT_KINDS, type ExportKind } from '@rvc/shared';
import { db } from '../db/client.js';
import { dataExports, users } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from '../lib/audit.js';
import { storeFile } from '../services/files.service.js';
import { notify } from '../services/notification.service.js';
import { renderTemplate } from '../services/templates.service.js';
import { enqueue } from '../jobs/queue.js';
import { localDateString } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { env } from '../env.js';

/**
 * Exports.
 *
 * Every export in this system is a file full of personal information, so all of
 * them go through this one path, which does four things the ad-hoc "download
 * CSV" button in the legacy app did not:
 *
 *  1. records who asked, for what, and when — before the file exists
 *  2. runs in the background, so a year of trips does not time out a request
 *  3. stores the result encrypted with an expiry date, so it deletes itself
 *  4. audits the download separately from the request
 *
 * The monthly board export is a first-class kind because it is the report the
 * organisation actually produces every month.
 */

const EXPIRY_DAYS = 7;

export async function requestExport(
  actor: AuditActor,
  kind: ExportKind,
  params: Record<string, unknown> = {},
) {
  if (!EXPORT_KINDS.includes(kind)) {
    throw Errors.validation(`kind must be one of: ${EXPORT_KINDS.join(', ')}`);
  }
  if (!actor.userId) throw Errors.unauthorized();

  const [row] = await db
    .insert(dataExports)
    .values({
      kind,
      params,
      requestedById: actor.userId,
      status: 'queued',
      expiresAt: new Date(Date.now() + EXPIRY_DAYS * 86_400_000),
    })
    .returning();

  await recordAudit({
    actor,
    action: 'export.requested',
    entityType: 'data_export',
    entityId: row!.id,
    next: { kind, params },
  });

  await enqueue('export.run', { exportId: row!.id }, { dedupeKey: `export:${row!.id}` });
  return row!;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  // A BOM, so Excel opens accented names correctly instead of as mojibake —
  // which matters when half the addresses are in French.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

async function fetchRows(kind: string, params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const from = (params.from as string) ?? '1970-01-01';
  const to = (params.to as string) ?? localDateString(new Date(Date.now() + 86_400_000));

  switch (kind) {
    case 'trips':
      return (await db.execute(raw`
        select t.reference, t.status, t.priority, t.trip_type,
               t.pickup_at, t.appointment_at, t.completed_at,
               g.name as group_name,
               t.caller_name, t.caller_phone,
               pa.line1 as pickup_line1, pa.city as pickup_city,
               da.line1 as dropoff_line1, da.city as dropoff_city,
               t.mobility_needs, u.full_name as volunteer,
               t.created_at
          from trips t
          join volunteer_groups g on g.id = t.group_id
          join addresses pa on pa.id = t.pickup_address_id
          join addresses da on da.id = t.dropoff_address_id
          left join users u on u.id = t.assigned_volunteer_id
         where t.deleted_at is null
           and t.pickup_at >= ${from}::date and t.pickup_at < ${to}::date + 1
         order by t.pickup_at
      `)) as unknown as Array<Record<string, unknown>>;

    case 'monthly_board':
      // What the organisation reports each month: volume, who drove, outcomes.
      return (await db.execute(raw`
        select to_char(t.pickup_at at time zone 'America/Toronto', 'YYYY-MM') as month,
               g.name as group_name,
               t.trip_type,
               count(*)::int as trips,
               count(*) filter (where t.status = 'completed')::int as completed,
               count(*) filter (where t.status = 'cancelled')::int as cancelled,
               count(*) filter (where t.status = 'expired')::int as unclaimed,
               count(distinct t.assigned_volunteer_id)::int as volunteers,
               count(distinct t.caller_id)::int as callers,
               round(avg(extract(epoch from (t.accepted_at - t.created_at)) / 60)::numeric, 1) as avg_minutes_to_accept
          from trips t
          join volunteer_groups g on g.id = t.group_id
         where t.deleted_at is null
           and t.pickup_at >= ${from}::date and t.pickup_at < ${to}::date + 1
         group by 1, 2, 3
         order by 1 desc, 2, 3
      `)) as unknown as Array<Record<string, unknown>>;

    case 'volunteers':
      return (await db.execute(raw`
        select u.full_name, u.email, u.phone, u.role, u.status, u.volunteer_number,
               u.capabilities, u.languages, u.service_area,
               coalesce(string_agg(distinct g.name, '; '), '') as groups,
               coalesce(string_agg(distinct st.name, '; '), '') as services,
               (select count(*) from trips t
                 where t.assigned_volunteer_id = u.id and t.status = 'completed')::int as completed_trips,
               u.created_at, u.last_login_at
          from users u
          left join user_groups ug on ug.user_id = u.id
          left join volunteer_groups g on g.id = ug.group_id
          left join volunteer_services vs on vs.user_id = u.id
          left join service_types st on st.id = vs.service_type_id
         where u.deleted_at is null
         group by u.id
         order by u.full_name
      `)) as unknown as Array<Record<string, unknown>>;

    case 'equipment_loans':
      return (await db.execute(raw`
        select e.item_code, e.barcode, e.equipment_type, ec.name as category,
               l.borrower_name, l.borrower_phone, l.borrower_address,
               l.loaned_at, l.expected_return_at, l.returned_at,
               lb.full_name as loaned_by, rb.full_name as returned_by, l.notes
          from equipment_loans l
          join equipment e on e.id = l.equipment_id
          left join equipment_categories ec on ec.id = e.category_id
          left join users lb on lb.id = l.loaned_by_id
          left join users rb on rb.id = l.returned_by_id
         where l.loaned_at >= ${from}::date and l.loaned_at < ${to}::date + 1
         order by l.loaned_at desc
      `)) as unknown as Array<Record<string, unknown>>;

    case 'audit':
      return (await db.execute(raw`
        select occurred_at, actor_name, actor_role, action, entity_type, entity_id, ip, request_id
          from audit_events
         where occurred_at >= ${from}::date and occurred_at < ${to}::date + 1
         order by occurred_at desc
         limit 100000
      `)) as unknown as Array<Record<string, unknown>>;

    case 'notification_deliveries':
      return (await db.execute(raw`
        select d.queued_at, d.channel, d.status, d.attempts, d.provider,
               d.last_error, n.event, u.full_name as recipient
          from notification_deliveries d
          join notifications n on n.id = d.notification_id
          join users u on u.id = n.user_id
         where d.queued_at >= ${from}::date and d.queued_at < ${to}::date + 1
         order by d.queued_at desc
         limit 100000
      `)) as unknown as Array<Record<string, unknown>>;

    default:
      throw new Error(`Unknown export kind: ${kind}`);
  }
}

/** Executed by the worker. */
export async function runExport(exportId: string): Promise<void> {
  const [job] = await db.select().from(dataExports).where(eq(dataExports.id, exportId)).limit(1);
  if (!job || job.status === 'ready') return;

  await db.update(dataExports).set({ status: 'running' }).where(eq(dataExports.id, exportId));

  try {
    const rows = await fetchRows(job.kind, job.params);
    const csv = toCsv(rows);
    const file = await storeFile(
      SYSTEM_ACTOR,
      Buffer.from(csv, 'utf8'),
      {
        originalName: `${job.kind}-${localDateString(new Date())}.csv`,
        sensitivity: 'restricted',
        purgeAfterDays: EXPIRY_DAYS,
        trustedContentType: 'text/csv; charset=utf-8',
      },
    );

    await db
      .update(dataExports)
      .set({
        status: 'ready',
        rowCount: rows.length,
        fileId: file.id,
        completedAt: new Date(),
      })
      .where(eq(dataExports.id, exportId));

    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: 'export.completed',
      entityType: 'data_export',
      entityId: exportId,
      next: { kind: job.kind, rowCount: rows.length },
    });

    const rendered = await renderTemplate('admin.export_ready', 'email', {
      kind: job.kind,
      rowCount: rows.length,
      downloadUrl: `${env.APP_URL}/admin/exports/${exportId}`,
      expiresIn: `${EXPIRY_DAYS} days`,
    });
    await notify({
      userId: job.requestedById,
      event: 'admin.export_ready',
      title: 'Your export is ready',
      body: rendered.body,
      subject: rendered.subject ?? 'Your export is ready',
      payload: { exportId },
    }).catch((err: unknown) => logger.warn({ err, exportId }, 'export-ready notification failed'));
  } catch (err) {
    logger.error({ err, exportId }, 'export failed');
    await db
      .update(dataExports)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500), completedAt: new Date() })
      .where(eq(dataExports.id, exportId));
  }
}

export async function listExports(requestedById?: string, limit = 50) {
  return db
    .select({
      id: dataExports.id,
      kind: dataExports.kind,
      status: dataExports.status,
      rowCount: dataExports.rowCount,
      params: dataExports.params,
      error: dataExports.error,
      createdAt: dataExports.createdAt,
      completedAt: dataExports.completedAt,
      expiresAt: dataExports.expiresAt,
      fileId: dataExports.fileId,
      requestedBy: users.fullName,
    })
    .from(dataExports)
    .innerJoin(users, eq(users.id, dataExports.requestedById))
    .where(requestedById ? eq(dataExports.requestedById, requestedById) : raw`true`)
    .orderBy(raw`${dataExports.createdAt} desc`)
    .limit(limit);
}

export async function getExport(id: string) {
  const [row] = await db.select().from(dataExports).where(eq(dataExports.id, id)).limit(1);
  if (!row) throw Errors.notFound('That export no longer exists.');
  if (row.expiresAt && row.expiresAt < new Date()) {
    throw Errors.gone('That export has expired. Request a new one.');
  }
  return row;
}

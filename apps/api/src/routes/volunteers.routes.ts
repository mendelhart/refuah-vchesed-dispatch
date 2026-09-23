import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  availabilityExceptionSchema,
  licenceSchema,
  reviewLicenceSchema,
  setAvailabilitySchema,
  setCapabilitiesSchema,
  setServicesSchema,
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
import {
  addAvailabilityException,
  buildIdCard,
  getAvailability,
  getVolunteerServices,
  listServiceTypes,
  removeAvailabilityException,
  setAvailability,
  setCapabilities,
  setVolunteerServices,
  verifyIdCard,
} from '../domain/volunteer.service.js';
import {
  getLicenceForUser,
  listLicencesForReview,
  recordLicence,
  reviewLicence,
  verifyLicence,
} from '../domain/licences.service.js';
import { storeFile, readFile } from '../services/files.service.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { and, eq, isNull, sql as raw } from 'drizzle-orm';

const idParam = z.object({ id: uuidSchema });

/**
 * A volunteer's own record.
 *
 * The `/api/me/...` routes are self-serve: a volunteer manages their own
 * availability, services and capabilities without asking anybody. That is the
 * whole point — an availability control a volunteer cannot reach is the control
 * the legacy app had, and it went unread by the dispatch engine for years.
 *
 * The `/api/volunteers/:id/...` equivalents let a dispatcher do the same during
 * a phone call. Both write the same rows and both are audited with the actor,
 * so "she says she told you she was away" is answerable.
 */
export async function volunteerRoutes(app: FastifyInstance): Promise<void> {
  // --- catalogue -----------------------------------------------------------
  app.get('/api/services', { preHandler: requireAuth }, async () => ({
    services: await listServiceTypes(),
  }));

  // --- my availability -----------------------------------------------------
  app.get('/api/me/availability', { preHandler: requireAuth }, async (req) =>
    getAvailability(currentUser(req).id),
  );

  app.put('/api/me/availability', { preHandler: requireAuth }, async (req) => {
    const body = setAvailabilitySchema.parse(req.body);
    const windows = await setAvailability(actorFrom(req), currentUser(req).id, body.windows);
    return { windows, unrestricted: windows.length === 0 };
  });

  app.post('/api/me/availability/exceptions', { preHandler: requireAuth }, async (req, reply) => {
    const body = availabilityExceptionSchema.parse(req.body);
    const row = await addAvailabilityException(actorFrom(req), currentUser(req).id, body);
    reply.status(201);
    return { exception: row };
  });

  app.delete('/api/me/availability/exceptions/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    await removeAvailabilityException(actorFrom(req), currentUser(req).id, id);
    return { ok: true };
  });

  // --- my services and capabilities ---------------------------------------
  app.get('/api/me/services', { preHandler: requireAuth }, async (req) => ({
    services: await getVolunteerServices(currentUser(req).id),
  }));

  app.put('/api/me/services', { preHandler: requireAuth }, async (req) => {
    const body = setServicesSchema.parse(req.body);
    return { services: await setVolunteerServices(actorFrom(req), currentUser(req).id, body.services) };
  });

  app.get('/api/me/capabilities', { preHandler: requireAuth }, async (req) => {
    const [row] = await db
      .select({ capabilities: users.capabilities })
      .from(users)
      .where(eq(users.id, currentUser(req).id))
      .limit(1);
    return { capabilities: row?.capabilities ?? [] };
  });

  app.put('/api/me/capabilities', { preHandler: requireAuth }, async (req) => {
    const body = setCapabilitiesSchema.parse(req.body);
    return {
      capabilities: await setCapabilities(actorFrom(req), currentUser(req).id, body.capabilities),
    };
  });

  // --- my ID card ----------------------------------------------------------
  app.get('/api/me/id-card', { preHandler: requireAuth }, async (req) => ({
    card: await buildIdCard(currentUser(req).id),
  }));

  /**
   * Public card check.
   *
   * Unauthenticated on purpose: the person scanning it is a receptionist at a
   * hospital desk, not a user of this system. It returns a name and whether the
   * card is current, and nothing else — no phone number, no email, no groups.
   */
  app.get('/api/id-card/verify/:token', async (req) => {
    const { token } = z.object({ token: z.string().trim().min(8).max(64) }).parse(req.params);
    return verifyIdCard(token);
  });

  // --- my licence ----------------------------------------------------------
  app.get('/api/me/licence', { preHandler: requireAuth }, async (req) => ({
    licence: await getLicenceForUser(currentUser(req).id),
  }));

  /**
   * A phone photograph of a licence is several megabytes, and the server's
   * global bodyLimit is 1MB — so without a per-route limit this answered 413
   * before any of the friendly validation ran. The client downscales before
   * uploading; this is the ceiling, not the target.
   */
  app.put('/api/me/licence', { preHandler: requireAuth, bodyLimit: 14_000_000 }, async (req) => {
    const body = licenceSchema.parse(req.body);
    const actor = actorFrom(req);
    const me = currentUser(req);

    const frontFileId = body.frontImage
      ? (await storeFile(actor, decodeImage(body.frontImage), {
          originalName: 'licence-front',
          sensitivity: 'restricted',
        })).id
      : null;
    const backFileId = body.backImage
      ? (await storeFile(actor, decodeImage(body.backImage), {
          originalName: 'licence-back',
          sensitivity: 'restricted',
        })).id
      : null;

    await recordLicence(actor, {
      userId: me.id,
      licenceNumber: body.licenceNumber,
      province: body.province,
      country: body.country,
      expiresOn: body.expiresOn,
      frontFileId,
      backFileId,
    });

    return {
      // Re-read rather than projecting the write: the status panel renders the
      // provider and review fields, and a partial object there would blank the
      // one field on this screen that must never be wrong.
      licence: await getLicenceForUser(me.id),
      // Said plainly, every time, so nobody infers a check that did not happen.
      note: 'Your licence is on file for an administrator to review. Nothing has been verified automatically.',
    };
  });

  // --- administration ------------------------------------------------------
  app.get('/api/licences/pending', { preHandler: requireAdmin }, async () => ({
    licences: await listLicencesForReview(),
  }));

  app.post('/api/licences/:id/review', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = reviewLicenceSchema.parse(req.body);
    return { licence: await reviewLicence(actorFrom(req), id, body.decision, body.notes) };
  });

  app.post('/api/licences/:id/verify', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    return verifyLicence(actorFrom(req), id);
  });

  /**
   * Serves a licence image.
   *
   * Admin only, one image per request, and every read is written to the audit
   * trail with the reason the caller gave. A licence photograph is the most
   * sensitive object in this database.
   */
  app.get('/api/files/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ reason: z.string().trim().max(200).default('administrative review') }).parse(req.query);
    const file = await readFile(actorFrom(req), id, q.reason);
    return reply
      .type(file.contentType)
      .header('cache-control', 'no-store, private')
      .header('content-disposition', `inline; filename="${file.originalName ?? 'file'}"`)
      .send(file.buffer);
  });

  // --- dispatcher acting for a volunteer ----------------------------------
  app.get('/api/volunteers/:id/availability', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return getAvailability(id);
  });

  app.put('/api/volunteers/:id/availability', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = setAvailabilitySchema.parse(req.body);
    const windows = await setAvailability(actorFrom(req), id, body.windows);
    return { windows, unrestricted: windows.length === 0 };
  });

  app.put('/api/volunteers/:id/services', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = setServicesSchema.parse(req.body);
    return { services: await setVolunteerServices(actorFrom(req), id, body.services) };
  });

  app.put('/api/volunteers/:id/capabilities', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = setCapabilitiesSchema.parse(req.body);
    return { capabilities: await setCapabilities(actorFrom(req), id, body.capabilities) };
  });

  /**
   * The consolidated volunteer screen.
   *
   * One query rather than the six the legacy app made per row: who they are,
   * what they do, when they are free, and what they have driven. At 500
   * volunteers the N+1 version is the page that takes eleven seconds.
   */
  app.get('/api/volunteers/overview', { preHandler: requireDispatcher }, async (req) => {
    const q = z
      .object({
        search: z.string().trim().max(80).optional(),
        groupSlug: z.string().trim().max(60).optional(),
        serviceSlug: z.string().trim().max(60).optional(),
        status: z.string().trim().max(20).default('active'),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);

    const rows = (await db.execute(raw`
      select u.id, u.full_name, u.phone, u.email, u.role, u.status,
             u.volunteer_number, u.capabilities, u.languages, u.service_area,
             u.muted_until, u.suspended_until, u.suspension_reason, u.last_offered_at, u.notification_preference,
             coalesce(array_agg(distinct g.slug) filter (where g.slug is not null), '{}') as group_slugs,
             coalesce(array_agg(distinct g.name) filter (where g.name is not null), '{}') as group_names,
             coalesce(array_agg(distinct st.slug) filter (where st.slug is not null), '{}') as service_slugs,
             (select count(*) from availability_rules ar where ar.user_id = u.id)::int as availability_rules,
             (select count(*) from trips t
               where t.assigned_volunteer_id = u.id and t.status = 'completed')::int as completed_trips,
             (select max(t.completed_at) from trips t
               where t.assigned_volunteer_id = u.id and t.status = 'completed') as last_trip_at,
             (select count(*) from trips t
               where t.assigned_volunteer_id = u.id
                 and t.status in ('assigned','accepted','en_route','in_progress'))::int as open_trips,
             (select l.status from driver_licences l
               where l.user_id = u.id and l.deleted_at is null limit 1) as licence_status
        from users u
        left join user_groups ug on ug.user_id = u.id
        left join volunteer_groups g on g.id = ug.group_id
        left join volunteer_services vs on vs.user_id = u.id
        left join service_types st on st.id = vs.service_type_id
       where u.deleted_at is null
         and (${q.status}::text = 'all' or u.status = ${q.status})
         and (${q.search ?? null}::text is null
              or u.full_name ilike '%' || ${q.search ?? null} || '%'
              or u.email ilike '%' || ${q.search ?? null} || '%'
              or u.phone like '%' || ${q.search ?? null} || '%')
       group by u.id
      having (${q.groupSlug ?? null}::text is null
              or ${q.groupSlug ?? null} = any(array_agg(distinct g.slug)))
         and (${q.serviceSlug ?? null}::text is null
              or ${q.serviceSlug ?? null} = any(array_agg(distinct st.slug)))
       order by u.full_name
       limit ${q.limit}
    `)) as unknown as Array<Record<string, unknown>>;

    return { volunteers: rows };
  });

  app.get('/api/volunteers/:id/card', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    if (!row) throw Errors.notFound('That volunteer is no longer on file.');
    return { card: await buildIdCard(id) };
  });
}

/** Accepts a data: URL or bare base64 and returns the bytes. */
function decodeImage(input: string): Buffer {
  const comma = input.indexOf(',');
  const base64 = input.startsWith('data:') && comma > -1 ? input.slice(comma + 1) : input;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    throw Errors.validation('That image could not be read. Try taking the photo again.');
  }
  return buffer;
}

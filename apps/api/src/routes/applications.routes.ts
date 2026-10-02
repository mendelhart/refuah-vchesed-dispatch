import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  applicationSchema,
  licenceSchema,
  requestInfoSchema,
  reviewApplicationSchema,
  uuidSchema,
} from '@rvc/shared';
import { actorFrom, requireAdmin, requireDispatcher } from '../auth/guards.js';
import { Errors } from '../lib/errors.js';
import { env } from '../env.js';
import {
  CONSENT_TEXT,
  CONSENT_VERSION,
  applicationCounts,
  approveApplication,
  getApplication,
  listApplications,
  rejectApplication,
  requestMoreInformation,
  submitApplication,
} from '../domain/applications.service.js';
import { listServiceTypes } from '../domain/volunteer.service.js';
import { recordLicence } from '../domain/licences.service.js';
import { storeFile } from '../services/files.service.js';
import { SYSTEM_ACTOR } from '../lib/audit.js';
import { db } from '../db/client.js';
import { volunteerGroups } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashToken, constantTimeEquals } from '../lib/crypto.js';

const idParam = z.object({ id: uuidSchema });

/**
 * Volunteer signup.
 *
 * The POST is the only unauthenticated write endpoint in the entire API, which
 * makes it the one that has to be hardest. Its protections, in order:
 *
 *  1. Its own rate limit, per IP, far tighter than the global one.
 *  2. A honeypot field a human never fills and a naive bot always does.
 *  3. A minimum completion time — a form submitted two seconds after it loaded
 *     was not typed by a person.
 *  4. Nothing it writes can reach the dispatch system without an administrator
 *     approving it.
 *
 * It also never confirms or denies that a phone number is already known, so it
 * cannot be used to enumerate the volunteer roster.
 */
export async function applicationRoutes(app: FastifyInstance): Promise<void> {
  // --- public --------------------------------------------------------------
  app.get('/api/public/signup-options', async () => {
    if (!env.PUBLIC_SIGNUP_ENABLED) throw Errors.forbidden('Volunteer signup is closed at the moment.');
    const [services, groups] = await Promise.all([
      listServiceTypes(),
      db.select({ slug: volunteerGroups.slug, name: volunteerGroups.name }).from(volunteerGroups).where(eq(volunteerGroups.active, true)),
    ]);
    return {
      services: services.map((s) => ({ slug: s.slug, name: s.name, description: s.description })),
      groups,
      consent: { version: CONSENT_VERSION, text: CONSENT_TEXT },
    };
  });

  app.post(
    '/api/public/volunteer-applications',
    {
      config: {
        rateLimit: {
          // Read per request rather than captured at boot, so the limit can be
          // tuned without a restart — and so the limiter itself is testable.
          max: () => env.SIGNUP_MAX_PER_IP_PER_HOUR,
          timeWindow: '1 hour',
        },
      },
    },
    async (req, reply) => {
      const antiAbuse = z
        .object({
          /** Honeypot. Hidden in the form; a human never sees or fills it. */
          website: z.string().max(200).optional(),
          /** Milliseconds the form was open before submission. */
          elapsedMs: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.body ?? {});

      if (antiAbuse.website) {
        // Answer as if it worked. Telling a bot it was detected only teaches it.
        reply.status(202);
        return { reference: 'RVC-A-000000-000', received: true };
      }
      if (antiAbuse.elapsedMs !== undefined && antiAbuse.elapsedMs < 3000) {
        throw Errors.validation('That was submitted before the form finished loading. Please try again.');
      }

      const body = applicationSchema.parse(req.body);
      const ownership = z.object({ ownershipToken: z.string().min(40).max(100).optional(), ownershipReference: z.string().max(30).optional() }).parse(req.body);
      const result = await submitApplication({
        ...body, ...ownership,
        submittedIp: req.ip,
        submittedUserAgent:
          typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });

      reply.status(201);
      return { reference: result.reference, received: true, ...(result.ownershipToken ? { ownershipToken: result.ownershipToken } : {}) };
    },
  );

  /**
   * Licence upload attached to an application in progress.
   *
   * Takes the application's own reference rather than an id, because the
   * applicant has the reference and no session. It only ever adds a document to
   * an application that is still open, and returns nothing about it.
   */
  app.post(
    '/api/public/volunteer-applications/:reference/licence',
    {
      // Same reason as PUT /api/me/licence: a licence photograph does not fit
      // in the 1MB global body limit.
      bodyLimit: 14_000_000,
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (req) => {
      if (!env.PUBLIC_SIGNUP_ENABLED) throw Errors.forbidden('Volunteer signup is closed at the moment.');
      const token = z.string().min(40).max(100).safeParse(req.headers['x-application-token']);
      if (!token.success) throw Errors.notFound('We could not find an open application with that link.');
      const { reference } = z.object({ reference: z.string().trim().max(30) }).parse(req.params);
      const body = licenceSchema.parse(req.body);

      const { volunteerApplications } = await import('../db/schema.js');
      const { and, isNull, inArray } = await import('drizzle-orm');
      const [application] = await db
        .select({ id: volunteerApplications.id, tokenHash: volunteerApplications.ownershipTokenHash, expiresAt: volunteerApplications.ownershipExpiresAt })
        .from(volunteerApplications)
        .where(
          and(
            eq(volunteerApplications.reference, reference),
            isNull(volunteerApplications.deletedAt),
            inArray(volunteerApplications.status, ['submitted', 'info_requested']),
          ),
        )
        .limit(1);
      if (!application?.tokenHash || !application.expiresAt || application.expiresAt <= new Date() ||
          !constantTimeEquals(hashToken(token.data), application.tokenHash)) throw Errors.notFound('We could not find an open application with that link.');

      const decode = (v: string): Buffer => {
        const comma = v.indexOf(',');
        return Buffer.from(v.startsWith('data:') && comma > -1 ? v.slice(comma + 1) : v, 'base64');
      };

      const frontFileId = body.frontImage
        ? (await storeFile(SYSTEM_ACTOR, decode(body.frontImage), { originalName: 'licence-front', sensitivity: 'restricted' })).id
        : null;
      const backFileId = body.backImage
        ? (await storeFile(SYSTEM_ACTOR, decode(body.backImage), { originalName: 'licence-back', sensitivity: 'restricted' })).id
        : null;

      await recordLicence(SYSTEM_ACTOR, {
        applicationId: application.id,
        licenceNumber: body.licenceNumber,
        province: body.province,
        country: body.country,
        expiresOn: body.expiresOn,
        frontFileId,
        backFileId,
      });

      return { received: true };
    },
  );

  // --- review --------------------------------------------------------------
  app.get('/api/applications', { preHandler: requireDispatcher }, async (req) => {
    const q = z
      .object({
        status: z.string().max(20).default('submitted'),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    return {
      applications: await listApplications(q.status, q.limit),
      counts: await applicationCounts(),
    };
  });

  app.get('/api/applications/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return getApplication(actorFrom(req), id);
  });

  app.post('/api/applications/:id/request-info', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = requestInfoSchema.parse(req.body);
    return requestMoreInformation(actorFrom(req), id, body.message);
  });

  app.post('/api/applications/:id/reject', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = reviewApplicationSchema.parse(req.body ?? {});
    return rejectApplication(actorFrom(req), id, {
      notes: body.notes ?? undefined,
      message: body.message ?? undefined,
    });
  });

  /** Approval creates the volunteer. Admin only — it is the trust boundary. */
  app.post('/api/applications/:id/approve', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = reviewApplicationSchema.parse(req.body ?? {});
    return approveApplication(actorFrom(req), id, {
      role: body.role,
      groupSlugs: body.groupSlugs,
      serviceSlugs: body.serviceSlugs,
      notes: body.notes ?? null,
    });
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createLiftAssistSchema, createPackageSchema, liftAssistAudienceSchema, liftAssistInviteSchema, liftAssistRespondSchema,
  proofOfDeliverySchema, uuidSchema,
} from '@rvc/shared';
import { actorFrom, currentUser, requireAuth, requireDispatcher } from '../auth/guards.js';
import { Errors } from '../lib/errors.js';
import { requireFlag } from '../lib/flags.js';
import { getTrip } from '../domain/trips.query.js';
import {
  cancelLiftAssist, createLiftAssist, createPackageDelivery, getLiftAssist, getPackage, inviteHelpers, isLiftHelper,
  listLiftAssists, previewLiftAudience, recordDelivery, respond, setLead, setLiftHelper,
} from '../domain/deliveries.service.js';

/** Item 6. Packages: 404 while PACKAGE_DELIVERY_ENABLED is off. Lift assist:
 *  404 while LIFT_ASSIST_ENABLED is off. Role guards run first. */
const pkg = requireFlag('packageDelivery');
const lift = requireFlag('liftAssist');
const idParam = z.object({ id: uuidSchema });

export async function deliveryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/packages', { preHandler: [requireDispatcher, pkg], config: { idempotent: true } }, async (req, reply) => {
    const body = createPackageSchema.parse(req.body);
    const tripId = await createPackageDelivery({ user: currentUser(req), audit: actorFrom(req) }, body);
    reply.status(201);
    return { trip: await getTrip(currentUser(req), tripId), package: await getPackage(currentUser(req), tripId) };
  });

  app.get('/api/trips/:id/package', { preHandler: [requireAuth, pkg] }, async (req) => {
    const found = await getPackage(currentUser(req), idParam.parse(req.params).id);
    if (!found) throw Errors.notFound('Package');
    return { package: found };
  });

  app.post('/api/trips/:id/package/delivered', { preHandler: [requireAuth, pkg] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = proofOfDeliverySchema.parse(req.body);
    await recordDelivery(actorFrom(req), currentUser(req), id, body.receivedBy, body.note ?? null);
    return { package: await getPackage(currentUser(req), id) };
  });

  // --- lift assist -----------------------------------------------------------
  app.get('/api/lift-assist/helper', { preHandler: [requireAuth, lift] }, async (req) => ({
    willing: await isLiftHelper(currentUser(req).id),
  }));
  app.put('/api/lift-assist/helper', { preHandler: [requireAuth, lift] }, async (req) => {
    const { willing } = z.object({ willing: z.boolean() }).parse(req.body);
    await setLiftHelper(actorFrom(req), currentUser(req).id, willing);
    return { willing };
  });

  app.get('/api/lift-assist', { preHandler: [requireAuth, lift] }, async (req) => ({
    requests: await listLiftAssists(currentUser(req)),
  }));
  app.post('/api/lift-assist', { preHandler: [requireDispatcher, lift], config: { idempotent: true } }, async (req, reply) => {
    const id = await createLiftAssist(actorFrom(req), createLiftAssistSchema.parse(req.body));
    reply.status(201);
    return { request: await getLiftAssist(currentUser(req), id) };
  });
  app.get('/api/lift-assist/:id', { preHandler: [requireAuth, lift] }, async (req) => ({
    request: await getLiftAssist(currentUser(req), idParam.parse(req.params).id),
  }));
  app.post('/api/lift-assist/:id/preview', { preHandler: [requireDispatcher, lift] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = liftAssistAudienceSchema.parse(req.body ?? {});
    return previewLiftAudience(id, body.userIds);
  });
  app.post('/api/lift-assist/:id/invite', { preHandler: [requireDispatcher, lift] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = liftAssistInviteSchema.parse(req.body);
    return inviteHelpers(actorFrom(req), id, body.userIds, body.audienceHash);
  });
  app.post('/api/lift-assist/:id/respond', { preHandler: [requireAuth, lift] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { accept } = liftAssistRespondSchema.parse(req.body);
    return respond(actorFrom(req), id, currentUser(req).id, accept);
  });
  app.post('/api/lift-assist/:id/lead', { preHandler: [requireDispatcher, lift] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { userId } = z.object({ userId: uuidSchema }).parse(req.body);
    await setLead(actorFrom(req), id, userId);
    return { ok: true };
  });
  app.post('/api/lift-assist/:id/cancel', { preHandler: [requireDispatcher, lift] }, async (req) => {
    await cancelLiftAssist(actorFrom(req), idParam.parse(req.params).id);
    return { ok: true };
  });
}

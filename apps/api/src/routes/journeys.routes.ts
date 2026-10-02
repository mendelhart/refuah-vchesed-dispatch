import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createJourneySchema, replacePassengersSchema, returnReadySchema, uuidSchema } from '@rvc/shared';
import { actorFrom, currentUser, requireAuth, requireDispatcher } from '../auth/guards.js';
import { requireFlag } from '../lib/flags.js';
import { Errors } from '../lib/errors.js';
import type { TripActor } from '../domain/dispatch.service.js';
import {
  awaitingReturn, createJourney, getJourney, journeyForTrip, listPassengers, replacePassengers, returnReady,
} from '../domain/journeys.service.js';

/** Round trips, extra stops and passengers. 404 everywhere while
 *  MULTI_LEG_TRIPS_ENABLED is off; role guards run first. */
const idParam = z.object({ id: uuidSchema });
const actor = (req: FastifyRequest): TripActor => ({ user: currentUser(req), audit: actorFrom(req) });
const on = requireFlag('multiLegTrips');

export async function journeyRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/journeys', { preHandler: [requireDispatcher, on], config: { idempotent: true } }, async (req, reply) => {
    const body = createJourneySchema.parse(req.body);
    const id = await createJourney(actor(req), body);
    reply.status(201);
    return { journey: await getJourney(id) };
  });

  app.get('/api/journeys/awaiting-return', { preHandler: [requireDispatcher, on] }, async () => ({
    journeys: await awaitingReturn(),
  }));

  app.get('/api/journeys/:id', { preHandler: [requireDispatcher, on] }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { journey: await getJourney(id) };
  });

  app.post('/api/journeys/:id/return-ready', { preHandler: [requireDispatcher, on], config: { idempotent: true } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = returnReadySchema.parse(req.body ?? {});
    const tripId = await returnReady(actor(req), id, body.pickupAt);
    reply.status(201);
    return { tripId, journey: await getJourney(id) };
  });

  // Signed-in: a driver sees only where their own leg sits.
  app.get('/api/trips/:id/journey', { preHandler: [requireAuth, on] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const found = await journeyForTrip(currentUser(req), id);
    if (!found) throw Errors.notFound('Journey');
    return found;
  });

  app.get('/api/trips/:id/passengers', { preHandler: [requireDispatcher, on] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const rows = await listPassengers(id);
    return {
      passengers: rows.map((p) => ({ name: p.name, mobilityNeeds: p.mobility_needs ?? [], seats: Number(p.seats), notes: p.notes })),
    };
  });

  app.put('/api/trips/:id/passengers', { preHandler: [requireDispatcher, on] }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = replacePassengersSchema.parse(req.body);
    await replacePassengers(actor(req), id, body.passengers);
    return { ok: true };
  });
}

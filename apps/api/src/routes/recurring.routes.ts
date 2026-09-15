import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  endRecurringRideSchema,
  recurringRideSchema,
  updateRecurringRideSchema,
  uuidSchema,
} from '@rvc/shared';
import { actorFrom, currentUser, requireDispatcher } from '../auth/guards.js';
import {
  createRecurringRide,
  endRecurringRide,
  getRecurringRide,
  listRecurringRides,
  materialiseDueRides,
  updateRecurringRide,
} from '../domain/recurring.service.js';
import type { TripActor } from '../domain/dispatch.service.js';

const idParam = z.object({ id: uuidSchema });

function tripActor(req: FastifyRequest): TripActor {
  return { user: currentUser(req), audit: actorFrom(req) };
}

export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/recurring-rides', { preHandler: requireDispatcher }, async (req) => {
    const q = z.object({ status: z.string().max(20).optional() }).parse(req.query);
    return { rides: await listRecurringRides(q.status) };
  });

  app.get('/api/recurring-rides/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { ride: await getRecurringRide(id) };
  });

  app.post('/api/recurring-rides', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = recurringRideSchema.parse(req.body);
    const ride = await createRecurringRide(actorFrom(req), body);
    reply.status(201);
    return { ride };
  });

  app.patch('/api/recurring-rides/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = updateRecurringRideSchema.parse(req.body);
    return { ride: await updateRecurringRide(actorFrom(req), id, patch as Record<string, unknown>) };
  });

  app.post('/api/recurring-rides/:id/end', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = endRecurringRideSchema.parse(req.body);
    return endRecurringRide(tripActor(req), id, body);
  });

  /**
   * Runs the materialiser now rather than waiting for the daily job.
   *
   * Exists because the first question after setting up a standing ride is
   * "where is it?" — and the honest answer, that it appears when the horizon
   * reaches it, is easier to accept when you can also just press the button.
   */
  app.post('/api/recurring-rides/materialise', { preHandler: requireDispatcher }, async () => {
    return materialiseDueRides();
  });
}

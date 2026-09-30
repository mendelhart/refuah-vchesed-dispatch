import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  assignTripSchema,
  cancelTripSchema,
  claimTripSchema,
  createTripSchema,
  listTripsSchema,
  offerTripSchema,
  reassignTripSchema,
  simpleTransitionSchema,
  updateTripSchema,
  uuidSchema,
} from '@rvc/shared';
import { actorFrom, currentUser, requireAuth, requireDispatcher } from '../auth/guards.js';
import { Errors } from '../lib/errors.js';
import {
  advanceTrip,
  archiveTrip,
  assignTrip,
  cancelTrip,
  claimTrip,
  createTrip,
  offerTrip,
  reassignTrip,
  returnToPending,
  updateTrip,
  type TripActor,
} from '../domain/dispatch.service.js';
import { boardSummary, eligibleVolunteers, getTrip, listTrips } from '../domain/trips.query.js';
import { normalizeOfferCode } from '../lib/offer-code.js';
import { tripHistory } from '../domain/trip-history.js';

function tripActor(req: FastifyRequest): TripActor {
  return { user: currentUser(req), audit: actorFrom(req) };
}

const idParam = z.object({ id: uuidSchema });

/**
 * Trip routes.
 *
 * There is deliberately no `PATCH /trips/:id { status }`. Each state change is
 * its own endpoint mapping to one state-machine transition, so "who is allowed
 * to do this, from which state" is answered in one place rather than inferred
 * from a request body.
 */
export async function tripRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/trips', { preHandler: requireAuth }, async (req) => {
    const query = listTripsSchema.parse(req.query);
    const result = await listTrips(currentUser(req), {
      scope: query.scope,
      status: query.status,
      groupSlug: query.groupSlug,
      search: query.search,
      from: query.from,
      to: query.to,
      limit: query.limit,
      cursor: query.cursor,
    });
    return { items: result.items, nextCursor: result.nextCursor };
  });

  app.get('/api/trips/summary', { preHandler: requireDispatcher }, async (req) =>
    boardSummary(currentUser(req)),
  );

  app.get('/api/trips/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { trip: await getTrip(currentUser(req), id) };
  });

  app.get('/api/trips/:id/history', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { events: await tripHistory(id) };
  });

  app.get('/api/trips/:id/eligible-volunteers', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { volunteers: await eligibleVolunteers(id) };
  });

  app.post('/api/trips', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = createTripSchema.parse(req.body);
    const trip = await createTrip(tripActor(req), {
      isTest: body.isTest,
      callerId: body.callerId ?? null,
      callerName: body.callerName ?? null,
      callerPhone: body.callerPhone ?? null,
      callbackNumber: body.callbackNumber ?? null,
      pickup: body.pickup,
      dropoff: body.dropoff,
      pickupEntrance: body.pickupEntrance ?? null,
      pickupParking: body.pickupParking ?? null,
      dropoffEntrance: body.dropoffEntrance ?? null,
      dropoffParking: body.dropoffParking ?? null,
      pickupAt: body.pickupAt,
      appointmentAt: body.appointmentAt ?? null,
      tripType: body.tripType,
      priority: body.priority,
      groupSlug: body.groupSlug,
      assignmentMode: body.assignmentMode,
      mobilityNeeds: body.mobilityNeeds,
      passengerNotes: body.passengerNotes ?? null,
    });
    reply.status(201);
    return { trip: await getTrip(currentUser(req), trip.id) };
  });

  app.patch('/api/trips/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateTripSchema.parse(req.body);
    await updateTrip(tripActor(req), id, body as Record<string, unknown>);
    return { trip: await getTrip(currentUser(req), id) };
  });

  // --- transitions --------------------------------------------------------

  app.post('/api/trips/:id/offer', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = offerTripSchema.parse(req.body ?? {});
    const result = await offerTrip(tripActor(req), id, body);
    return { ...result, trip: await getTrip(currentUser(req), id) };
  });

  app.post('/api/trips/:id/assign', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = assignTripSchema.parse(req.body);
    await assignTrip(tripActor(req), id, body.volunteerId, body.reason);
    return { trip: await getTrip(currentUser(req), id) };
  });

  app.post('/api/trips/:id/reassign', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = reassignTripSchema.parse(req.body);
    await reassignTrip(tripActor(req), id, body.volunteerId, body.reason);
    return { trip: await getTrip(currentUser(req), id) };
  });

  /**
   * Accept. The response distinguishes "you have it" from "someone else got
   * there first" — the losing volunteer gets a clear answer rather than a
   * silent no-op.
   */
  app.post('/api/trips/:id/claim', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = claimTripSchema.parse(req.body ?? {});
    const outcome = await claimTrip(tripActor(req), {
      tripId: id,
      code: body.offerToken ? (normalizeOfferCode(body.offerToken) ?? undefined) : undefined,
      channel: 'app',
    });

    if (!outcome.ok) {
      const messages: Record<string, string> = {
        already_taken: 'Another volunteer accepted this trip first. Thank you for responding.',
        expired: 'This offer has expired.',
        not_your_offer:
          currentUser(req).role === 'volunteer'
            ? 'This trip was not offered to you.'
            : 'This trip was not offered to you. To give it to a volunteer, use Assign.',
        not_offered: 'This trip is no longer available.',
        unknown_code: 'That acceptance code is not valid.',
      };
      reply.status(409);
      return {
        error: {
          code: outcome.reason ?? 'conflict',
          message: messages[outcome.reason ?? ''] ?? 'This trip is no longer available.',
        },
      };
    }
    return { trip: await getTrip(currentUser(req), id), claimed: true };
  });

  /** Accept straight from an SMS/push deep link, where only the code is known. */
  app.post('/api/offers/accept', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ code: z.string().min(4).max(40) }).parse(req.body);
    const code = normalizeOfferCode(body.code);
    if (!code) throw Errors.validation('That acceptance code is not in the right format.');
    const outcome = await claimTrip(tripActor(req), { code, channel: 'app' });
    if (!outcome.ok) {
      reply.status(409);
      const message = outcome.reason === 'not_your_offer'
        ? 'This acceptance code belongs to another volunteer. Coordinators give a trip to someone with Assign.'
        : 'This trip is no longer available.';
      return { error: { code: outcome.reason ?? 'conflict', message } };
    }
    return { tripId: outcome.tripId, reference: outcome.reference, claimed: true };
  });

  app.post('/api/trips/:id/en-route', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = simpleTransitionSchema.parse(req.body ?? {});
    await advanceTrip(tripActor(req), id, 'start_en_route', body.note);
    return { trip: await getTrip(currentUser(req), id) };
  });

  app.post('/api/trips/:id/start', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = simpleTransitionSchema.parse(req.body ?? {});
    await advanceTrip(tripActor(req), id, 'start_trip', body.note);
    return { trip: await getTrip(currentUser(req), id) };
  });

  app.post('/api/trips/:id/complete', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = simpleTransitionSchema.parse(req.body ?? {});
    await advanceTrip(tripActor(req), id, 'complete', body.note);
    return { trip: await getTrip(currentUser(req), id) };
  });

  app.post('/api/trips/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = cancelTripSchema.parse(req.body);
    await cancelTrip(tripActor(req), id, body.reason);
    return { trip: await getTrip(currentUser(req), id) };
  });

  app.post('/api/trips/:id/return-to-pending', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = cancelTripSchema.parse(req.body);
    await returnToPending(tripActor(req), id, body.reason);
    return { trip: await getTrip(currentUser(req), id) };
  });

  app.delete('/api/trips/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = cancelTripSchema.parse(req.body ?? { reason: 'archived' });
    await archiveTrip(tripActor(req), id, body.reason);
    return { ok: true };
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  callerAddressSchema,
  callerSchema,
  callerSearchSchema,
  updateCallerSchema,
  uuidSchema,
} from '@rvc/shared';
import { actorFrom, requireDispatcher } from '../auth/guards.js';
import {
  createCaller,
  deleteCaller,
  getCallerProfile,
  listCallers,
  removeCallerAddress,
  saveCallerAddress,
  searchCallers,
  updateCaller,
} from '../domain/callers.service.js';

const idParam = z.object({ id: uuidSchema });

/**
 * The caller directory.
 *
 * Every route here is dispatcher-and-above. A volunteer has no reason to query
 * a searchable list of the people this organisation drives, and giving them one
 * would make every volunteer account a privacy incident waiting to happen.
 */
export async function callerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/callers/search', { preHandler: requireDispatcher }, async (req) => {
    const q = callerSearchSchema.parse(req.query);
    return { results: await searchCallers(actorFrom(req), q.q, q.limit) };
  });

  app.get('/api/callers', { preHandler: requireDispatcher }, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    return { callers: await listCallers(q.limit, q.offset) };
  });

  app.get('/api/callers/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return getCallerProfile(actorFrom(req), id);
  });

  app.post('/api/callers', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = callerSchema.parse(req.body);
    const caller = await createCaller(actorFrom(req), body);
    reply.status(201);
    return { caller };
  });

  app.patch('/api/callers/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateCallerSchema.parse(req.body);
    return { caller: await updateCaller(actorFrom(req), id, body) };
  });

  app.delete('/api/callers/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deleteCaller(actorFrom(req), id);
    return { ok: true };
  });

  app.post('/api/callers/:id/addresses', { preHandler: requireDispatcher }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = callerAddressSchema.parse(req.body);
    const saved = await saveCallerAddress(actorFrom(req), id, body);
    reply.status(201);
    return { address: saved };
  });

  app.delete(
    '/api/callers/:id/addresses/:addressId',
    { preHandler: requireDispatcher },
    async (req) => {
      const { id, addressId } = z
        .object({ id: uuidSchema, addressId: uuidSchema })
        .parse(req.params);
      await removeCallerAddress(actorFrom(req), id, addressId);
      return { ok: true };
    },
  );
}

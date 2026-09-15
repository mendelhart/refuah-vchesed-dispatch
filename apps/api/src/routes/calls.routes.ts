import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { startCallSchema } from '@rvc/shared';
import { actorFrom, currentUser, requireAuth } from '../auth/guards.js';
import { listCalls, startCall } from '../domain/calls.service.js';

export async function callRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/calls', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
  }, async (req) => {
    const body = startCallSchema.parse(req.body);
    const { call, counterpartyName } = await startCall(currentUser(req), actorFrom(req), body);
    return {
      call: { id: call.id, status: call.status, counterpartyName },
      message: 'Your phone will ring in a moment; answer it and we will connect the call.',
    };
  });

  app.get('/api/calls', { preHandler: requireAuth }, async (req) => {
    const q = z.object({
      direction: z.enum(['inbound', 'outbound']).optional(),
      status: z.string().max(30).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);
    return { calls: await listCalls(currentUser(req), q) };
  });
}

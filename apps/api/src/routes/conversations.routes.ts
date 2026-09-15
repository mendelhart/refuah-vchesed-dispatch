import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listThreadsSchema, replyThreadSchema, threadStatusSchema, uuidSchema } from '@rvc/shared';
import { actorFrom, currentUser, requireDispatcher } from '../auth/guards.js';
import {
  attachThreadToTrip,
  claimThread,
  getThread,
  listThreads,
  markRead,
  releaseThread,
  replyToThread,
  setThreadStatus,
  unreadThreadCount,
} from '../domain/conversations.service.js';

const idParam = z.object({ id: uuidSchema });

/**
 * The SMS console.
 *
 * Dispatcher-and-above throughout. Conversations contain callers' words about
 * their own medical appointments; they are not volunteer-visible, and a
 * volunteer's own messages reach them through the app's notification feed
 * rather than through this queue.
 */
export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/conversations', { preHandler: requireDispatcher }, async (req) => {
    const q = listThreadsSchema.parse(req.query);
    const threads = await listThreads({
      status: q.status,
      ownerId: q.mine ? currentUser(req).id : undefined,
      limit: q.limit,
    });
    return { threads, unread: await unreadThreadCount() };
  });

  app.get('/api/conversations/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const result = await getThread(id);
    // Opening a conversation is reading it; a separate "mark read" click is a
    // step nobody performs, and then the queue count never goes down.
    await markRead(actorFrom(req), id);
    return result;
  });

  app.post('/api/conversations/:id/reply', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = replyThreadSchema.parse(req.body);
    return replyToThread(actorFrom(req), id, body.body);
  });

  app.post('/api/conversations/:id/claim', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { thread: await claimThread(actorFrom(req), id) };
  });

  app.post('/api/conversations/:id/release', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    return { thread: await releaseThread(actorFrom(req), id) };
  });

  app.post('/api/conversations/:id/status', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = threadStatusSchema.parse(req.body);
    return { thread: await setThreadStatus(actorFrom(req), id, body.status) };
  });

  app.post('/api/conversations/:id/attach', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ tripId: uuidSchema.nullable() }).parse(req.body);
    return { thread: await attachThreadToTrip(actorFrom(req), id, body.tripId) };
  });
}

import type { FastifyInstance } from 'fastify';

import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { authRoutes } from './auth.routes.js';
import { tripRoutes } from './trips.routes.js';
import { userRoutes } from './users.routes.js';
import { callRoutes } from './calls.routes.js';
import { adminRoutes } from './admin.routes.js';
import { miscRoutes } from './misc.routes.js';
import { webhookRoutes } from './webhooks.routes.js';
import { eventRoutes } from './events.routes.js';
import { callerRoutes } from './callers.routes.js';
import { recurringRoutes } from './recurring.routes.js';
import { conversationRoutes } from './conversations.routes.js';
import { volunteerRoutes } from './volunteers.routes.js';
import { applicationRoutes } from './applications.routes.js';
import { opsRoutes } from './ops.routes.js';
import { dataFixRoutes } from './datafix.routes.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    try {
      await db.execute(raw`select 1`);
      return { status: 'ok', time: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'degraded', reason: 'database unreachable' });
    }
  });

  await app.register(authRoutes);
  await app.register(tripRoutes);
  await app.register(userRoutes);
  await app.register(callRoutes);
  await app.register(adminRoutes);
  await app.register(miscRoutes);
  await app.register(webhookRoutes);
  await app.register(eventRoutes);
  await app.register(callerRoutes);
  await app.register(recurringRoutes);
  await app.register(conversationRoutes);
  await app.register(volunteerRoutes);
  await app.register(applicationRoutes);
  await app.register(opsRoutes);
  await app.register(dataFixRoutes);
}

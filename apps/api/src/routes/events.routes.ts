import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { env } from '../env.js';
import { requireAuth, currentUser } from '../auth/guards.js';
import { logger } from '../lib/logger.js';

/**
 * Realtime updates over Server-Sent Events.
 *
 * The dispatcher board must reflect an acceptance the moment it happens, and
 * polling every few seconds from a dozen browsers is both wasteful and laggy.
 * SSE over Postgres LISTEN/NOTIFY needs no extra infrastructure: a database
 * trigger publishes on `rvc_events`, this process holds one listener, and each
 * connected browser gets a filtered stream.
 *
 * Payloads carry only ids and a status — never trip content — so the stream is
 * a signal to refetch through the normal, access-controlled endpoints rather
 * than a second, unscoped way to read data.
 */
type Listener = (payload: string) => void;
const listeners = new Set<Listener>();
let connection: postgres.Sql | null = null;

export async function startEventBridge(): Promise<void> {
  if (connection) return;
  connection = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  await connection.listen('rvc_events', (payload) => {
    for (const l of listeners) {
      try { l(payload); } catch { /* a dead client must not break the others */ }
    }
  });
  logger.info('realtime event bridge listening on rvc_events');
}

export async function stopEventBridge(): Promise<void> {
  listeners.clear();
  if (connection) { await connection.end({ timeout: 2 }).catch(() => {}); connection = null; }
}

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events/stream', { preHandler: requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    const isDispatcher = user.role === 'dispatcher' || user.role === 'admin';
    const groupIds = new Set(user.groups.map((g) => g.id));

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`retry: 5000\n\n`);
    reply.raw.write(`event: ready\ndata: {"ok":true}\n\n`);

    const listener: Listener = (payload) => {
      try {
        const evt = JSON.parse(payload) as {
          type: string; id: string; groupId?: string; assignedVolunteerId?: string | null;
        };
        // Volunteers only hear about trips in their groups or assigned to them.
        if (!isDispatcher) {
          const relevant =
            (evt.groupId && groupIds.has(evt.groupId)) || evt.assignedVolunteerId === user.id;
          if (!relevant) return;
        }
        reply.raw.write(`event: ${evt.type}\ndata: ${payload}\n\n`);
      } catch { /* ignore malformed payloads */ }
    };
    listeners.add(listener);

    const heartbeat = setInterval(() => {
      try { reply.raw.write(`: ping\n\n`); } catch { /* closed */ }
    }, 25_000);

    const cleanup = () => { clearInterval(heartbeat); listeners.delete(listener); };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    await new Promise<void>((resolve) => req.raw.on('close', () => resolve()));
  });
}

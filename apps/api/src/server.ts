import { randomUUID } from 'node:crypto';
import { applyViewAs } from './auth/view-as.js';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { DatabaseRateLimitStore } from './lib/rate-limit-store.js';
import { ZodError } from 'zod';
import { env, isProd } from './env.js';
import { logger } from './lib/logger.js';
import { AppError, Errors, isAppError } from './lib/errors.js';
import { resolveSession } from './auth/session.js';
import { captureException } from './lib/monitoring.js';
import { registerRoutes } from './routes/index.js';
import { registerIdempotency } from './lib/idempotency.js';
import { registerDepartmentScope } from './lib/departments.js';

/**
 * The HTTP surface.
 *
 * Cross-cutting concerns live here so no route has to remember them:
 * session resolution, error shaping, rate limiting, security headers, and the
 * raw-body capture that Twilio signature validation needs.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify v5 takes a ready-made pino instance as `loggerInstance`, which
    // keeps our redaction rules (see lib/logger.ts) rather than building its
    // own. The cast keeps the instance's logger generic at Fastify's default
    // so route modules can be typed with a plain `FastifyInstance`.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1_000_000,
    genReqId: () => randomUUID(),
    // In tests the logger itself is set to 'error', which suppresses per-request
    // lines without needing Fastify's deprecated toggle.
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // the API serves JSON; the web app sets its own
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: isProd ? [env.APP_URL] : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });

  await app.register(rateLimit, {
    global: true,
    store: DatabaseRateLimitStore,
    skipOnError: false,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.user?.id ?? req.ip,
    /**
     * Three exemptions, all for requests that are not what this limit is for.
     *
     * Webhooks are authenticated by signature and must not be throttled away.
     *
     * `/api/events/stream` is one long-lived SSE connection per open dispatcher
     * board. It is authenticated, it is inherently persistent, and a browser
     * that reconnects after a network blip spends a token each time — from the
     * same budget as the dispatcher's actual work. Counting it meant a busy
     * morning could exhaust the limit and start 429ing ordinary requests,
     * including `/api/auth/me`, which the web app then read as a sign-out.
     *
     * Health checks are the third. The limiter keeps its counters in Postgres,
     * so with the database down it failed every request with a 500 before
     * /health could run and answer its documented 503 (found by
     * scripts/outage-drill.sh). Only the plain liveness check (one
     * `select 1`) is exempt; /health/deep runs several queries and stays
     * limited. The handler itself is unchanged.
     */
    allowList: (req) =>
      req.url.startsWith('/webhooks/') || req.url.startsWith('/api/events/stream') ||
      req.routeOptions?.url === '/health',
    // Must be an AppError, not a bare object: the shared error handler reads
    // `statusCode` off what it is given, so returning a plain object turned
    // every throttled request into a 500 "internal error".
    errorResponseBuilder: () => Errors.rateLimited(),
  });

  /**
   * Twilio signs the exact bytes it posted, so the raw body must survive
   * parsing. Fastify's default form parser discards it.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      try {
        const params = new URLSearchParams(body as string);
        done(null, Object.fromEntries(params.entries()));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // --- session ------------------------------------------------------------
  app.addHook('onRequest', async (req) => {
    const token = req.cookies?.[env.SESSION_COOKIE_NAME];
    if (!token) return;
    try {
      const user = await resolveSession(token);
      if (user) req.user = user;
    } catch (err) {
      req.log.error({ err }, 'session resolution failed');
    }
    // Two-step sign-in owed: only the sign-in endpoints answer until it is done.
    if (req.user?.mfaPending) {
      // Judge by the ROUTE that matched, not the raw URL: an encoded or
      // oddly-slashed URL (/api/%74rips, //api/trips) that still routes to a
      // real handler must not slip past a prefix check on the raw string.
      const path = req.routeOptions?.url ?? (req.url.split('?')[0] ?? '');
      const open = path === '/api/auth/me' || path === '/api/auth/logout' || path.startsWith('/api/auth/mfa/');
      if (path.startsWith('/api/') && !open) {
        throw new AppError(403, 'mfa_required', 'Finish two-step sign-in first.');
      }
      return;
    }
    await applyViewAs(req);
  });

  // --- one error shape ----------------------------------------------------
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return reply.status(422).send({
        error: {
          code: 'validation_failed',
          message: details[0]?.message ?? 'Some of these details need fixing.',
          details,
          requestId: req.id,
        },
      });
    }

    if (isAppError(error)) {
      if (error.logLevel === 'error') req.log.error({ err: error, code: error.code }, error.message);
      else req.log.warn({ code: error.code, path: req.url }, error.message);
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          requestId: req.id,
        },
      });
    }

    const status = (error as { statusCode?: number })?.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'unhandled error');
      captureException(error, { requestId: req.id, method: req.method, url: req.url });
      return reply.status(500).send({
        error: {
          code: 'internal_error',
          // Never leak internals to the client; the requestId ties this to the log.
          message: 'Something went wrong on our side. The team has been notified.',
          requestId: req.id,
        },
      });
    }
    req.log.warn({ err: error }, 'request error');
    return reply
      .status(status)
      .send({ error: { code: 'request_error', message: (error as Error)?.message ?? 'Request failed', requestId: req.id } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url}` } });
  });

  // Off unless IDEMPOTENCY_KEYS_ENABLED; see lib/idempotency.ts.
  registerIdempotency(app);
  // Off unless DEPARTMENT_SCOPING_ENABLED; see lib/departments.ts.
  registerDepartmentScope(app);

  await registerRoutes(app);

  return app;
}

export { AppError, Errors };

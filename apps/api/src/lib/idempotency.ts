import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { AppError, Errors } from './errors.js';

/**
 * Request idempotency.
 *
 * A phone on a bad connection sends the same request twice: the user taps
 * again, or the browser retries after the answer was lost. For a request that
 * creates or sends something, that is a duplicate trip or a duplicate message.
 *
 * A client that cares sends an `Idempotency-Key` header (any unique string per
 * user intent, e.g. one UUID per form submission). The first request with that
 * key runs; any repeat from the same person gets the first answer back, with
 * `Idempotent-Replayed: true`, and nothing runs twice.
 *
 *   same key, same request, first still running   -> 409 in_progress
 *   same key, same request, first finished        -> the stored answer
 *   same key, different request                   -> 422
 *
 * Two switches, both required:
 *   - IDEMPOTENCY_KEYS_ENABLED=true (default off: the header is ignored and
 *     every request behaves exactly as before), and
 *   - the route opts in with `config: { idempotent: true }`. Routes are opted
 *     in one by one, for requests that create or send something. Sign-in,
 *     password and two-step routes never opt in: their requests and answers
 *     hold secrets that must not be stored.
 * Requests without the header are never affected. Only signed-in POST, PUT,
 * PATCH and DELETE take part.
 *
 * The check runs after the route's own guards, so a refused request (401,
 * 403) never claims a key, and a replay is only given to someone the guard
 * still lets through.
 *
 * Only successful (2xx) JSON answers are stored. Anything else releases the
 * key, so a corrected form can be sent again with the same key and a request
 * that failed on our side can be retried.
 *
 * A request still unanswered after ABANDONED_AFTER_SECONDS is treated as dead
 * (the process was killed) and one retry may take it over. The work and the
 * stored answer are not one transaction, so a request genuinely running that
 * long could run twice; the window is set well above any normal request.
 *
 * Stored answers expire after 24 hours. They are purged as new keys arrive and
 * by the daily cleanup.tokens job, so nothing here outlives about a day even
 * if the flag is later turned off.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const TTL_HOURS = 24;
/** A claim older than this with no answer belongs to a request that died. */
const ABANDONED_AFTER_SECONDS = 300;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

declare module 'fastify' {
  interface FastifyRequest {
    idempotencyClaim?: string;
  }
  interface FastifyContextConfig {
    /** Opt this route in to Idempotency-Key handling (lib/idempotency.ts). */
    idempotent?: boolean;
  }
}

type ExistingKey = {
  id: string;
  request_hash: string;
  status: 'in_progress' | 'done';
  response_code: number | null;
  response_body: unknown;
  abandoned: boolean;
};

function requestHash(req: FastifyRequest): string {
  const route = req.routeOptions?.url ?? req.url;
  return createHash('sha256')
    .update(JSON.stringify([req.method, route, req.params ?? null, req.query ?? null, req.body ?? null]))
    .digest('hex');
}

async function purgeSome(): Promise<void> {
  await db.execute(raw`
    delete from idempotency_keys
     where id in (select id from idempotency_keys where expires_at < now() limit 200)
  `);
}

/** Deletes every expired stored answer. Called by the cleanup.tokens job. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const rows = await db.execute<{ id: string }>(raw`delete from idempotency_keys where expires_at < now() returning id`);
  return rows.length;
}

async function claim(req: FastifyRequest, key: string, hash: string): Promise<string | null> {
  const userId = req.user!.id;
  const route = req.routeOptions?.url ?? req.url;
  const inserted = await db.execute<{ id: string }>(raw`
    insert into idempotency_keys (user_id, key, method, route, request_hash, expires_at)
    values (${userId}, ${key}, ${req.method}, ${route}, ${hash}, now() + make_interval(hours => ${TTL_HOURS}))
    on conflict (user_id, key) do nothing
    returning id
  `);
  return inserted[0]?.id ?? null;
}

async function existing(userId: string, key: string): Promise<ExistingKey | null> {
  const rows = await db.execute<ExistingKey>(raw`
    select id, request_hash, status, response_code, response_body,
           (status = 'in_progress' and claimed_at < now() - make_interval(secs => ${ABANDONED_AFTER_SECONDS})) as abandoned
      from idempotency_keys
     where user_id = ${userId} and key = ${key} and expires_at > now()
  `);
  return rows[0] ?? null;
}

/** Takes over a claim whose request died before answering. One winner. */
async function reclaim(id: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(raw`
    update idempotency_keys set claimed_at = now()
     where id = ${id} and status = 'in_progress'
       and claimed_at < now() - make_interval(secs => ${ABANDONED_AFTER_SECONDS})
    returning id
  `);
  return rows.length > 0;
}

async function release(id: string): Promise<void> {
  await db.execute(raw`delete from idempotency_keys where id = ${id} and status = 'in_progress'`);
}

async function store(id: string, code: number, body: unknown): Promise<void> {
  await db.execute(raw`
    update idempotency_keys
       set status = 'done', response_code = ${code}, response_body = ${JSON.stringify(body)}::jsonb
     where id = ${id}
  `);
}

async function onPreHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!env.IDEMPOTENCY_KEYS_ENABLED) return;
  if (!MUTATING.has(req.method) || !req.user) return;
  const header = req.headers[IDEMPOTENCY_HEADER];
  if (header === undefined) return;
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || !KEY_PATTERN.test(key)) {
    throw Errors.validation('Idempotency-Key must be 8 to 200 letters, digits or . _ : -');
  }

  const hash = requestHash(req);
  await purgeSome();
  const claimed = await claim(req, key, hash);
  if (claimed) {
    req.idempotencyClaim = claimed;
    return;
  }

  // An expired row still holds the unique slot until it is purged.
  const prior = await existing(req.user.id, key);
  if (!prior) {
    await db.execute(raw`delete from idempotency_keys where user_id = ${req.user.id} and key = ${key} and expires_at <= now()`);
    const retry = await claim(req, key, hash);
    if (retry) {
      req.idempotencyClaim = retry;
      return;
    }
    throw Errors.conflict('This request is already being handled. Wait a moment, then check before trying again.');
  }
  if (prior.request_hash !== hash) {
    throw Errors.validation('This Idempotency-Key was already used for a different request.');
  }
  if (prior.status === 'done') {
    reply.header(REPLAYED_HEADER, 'true');
    await reply.status(prior.response_code ?? 200).send(prior.response_body);
    return reply;
  }
  if (prior.abandoned && (await reclaim(prior.id))) {
    req.idempotencyClaim = prior.id;
    return;
  }
  throw new AppError(409, 'in_progress', 'This request is already being handled. Wait a moment, then check before trying again.');
}

/** Records the answer to a claimed key, or releases the key when the answer
 *  must not be replayed. Exported for tests. */
export async function settleClaim(id: string, code: number, payload: unknown): Promise<void> {
  let body: unknown;
  let storable = code >= 200 && code < 300;
  if (storable) {
    try {
      body = typeof payload === 'string' ? JSON.parse(payload) : payload === undefined || payload === null || payload === '' ? null : undefined;
    } catch {
      body = undefined;
    }
    // Only JSON answers can be replayed faithfully; anything else (a file, a
    // stream) is released rather than replayed wrongly.
    if (body === undefined) storable = false;
  }
  if (storable) await store(id, code, body);
  else await release(id);
}

async function onSend(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  const id = req.idempotencyClaim;
  if (!id) return payload;
  req.idempotencyClaim = undefined;
  try {
    await settleClaim(id, reply.statusCode, payload);
  } catch (err) {
    req.log.error({ err }, 'could not record idempotency result');
  }
  return payload;
}

/**
 * Must be called before the routes are registered. For each route that opts
 * in, the check is appended after the route's own preHandlers (its guards).
 */
export function registerIdempotency(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    if (!route.config?.idempotent) return;
    const own = route.preHandler === undefined ? [] : Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];
    route.preHandler = [...own, onPreHandler];
  });
  app.addHook('onSend', onSend);
}

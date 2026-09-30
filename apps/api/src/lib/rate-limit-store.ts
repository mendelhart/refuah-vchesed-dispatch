import { createHash } from 'node:crypto';
import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';

/** Atomic fixed-window counters survive restarts. Store only hashed identifiers. */
export class DatabaseRateLimitStore {
  constructor(private readonly options: { timeWindow?: number; path?: string; prefix?: string; routeInfo?: { method?: string | string[]; url?: string } } = {}) {}

  incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow = this.options.timeWindow ?? 60_000): void {
    const scope = `${this.options.prefix ?? ''}:${this.options.routeInfo?.method ?? ''}:${this.options.routeInfo?.url ?? this.options.path ?? 'global'}:${timeWindow}:${key}`;
    const hash = createHash('sha256').update(scope).digest('hex');
    void db.execute<{ current: number; ttl: number }>(raw`
      insert into rate_limit_buckets (key_hash, hits, expires_at)
      values (${hash}, 1, clock_timestamp() + ${timeWindow} * interval '1 millisecond')
      on conflict (key_hash) do update set
        hits = case when rate_limit_buckets.expires_at <= clock_timestamp() then 1 else rate_limit_buckets.hits + 1 end,
        expires_at = case when rate_limit_buckets.expires_at <= clock_timestamp()
          then clock_timestamp() + ${timeWindow} * interval '1 millisecond' else rate_limit_buckets.expires_at end
      returning hits::int as current,
        greatest(0, extract(epoch from (expires_at - clock_timestamp())) * 1000)::int as ttl
    `).then((rows) => callback(null, [...rows][0]))
      .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  child(options: { timeWindow?: number; path?: string; prefix?: string; routeInfo?: { method?: string | string[]; url?: string } }): DatabaseRateLimitStore {
    return new DatabaseRateLimitStore(options);
  }
}

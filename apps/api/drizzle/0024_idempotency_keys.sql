-- 0024: request idempotency keys (additive only).
--
-- A client that may send the same request twice (a double tap, a retry after
-- a dropped connection) sends an `Idempotency-Key` header; the server runs the
-- request once and replays the stored answer to any repeat. Used only when
-- IDEMPOTENCY_KEYS_ENABLED=true and only on routes that opt in. New table;
-- nothing existing is touched.
--
-- Personal data: response_body can hold what the original response held (for
-- example a created trip). Rows expire after 24 hours and are purged as new
-- keys arrive and by the daily cleanup.tokens job.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "key" text NOT NULL,
  "method" text NOT NULL,
  "route" text NOT NULL,
  "request_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
  "response_code" integer,
  "response_body" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "claimed_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_user_key_uq" ON idempotency_keys ("user_id", "key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_idx" ON idempotency_keys ("expires_at");

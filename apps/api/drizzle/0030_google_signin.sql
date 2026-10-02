-- 0030: Google sign-in. Additive only: two new tables; nothing existing is
-- touched, and password sign-in is unchanged. Used only when
-- GOOGLE_SIGNIN_ENABLED is true and GOOGLE_CLIENT_ID is set.
--
-- google_signin_approvals: the people an administrator has approved to sign
-- in with Google. A row names the account and the exact Google address; both
-- must still match at sign-in. Revoking keeps the row (revoked_at) so the
-- history stays. Personal data: an email address per approved person.
--
-- google_signin_nonces: one-time values that tie a Google answer to the
-- browser that asked for it; each is used once and expires in ten minutes.
-- Only a hash is stored. Rows older than a day are removed as new ones are made.
CREATE TABLE IF NOT EXISTS google_signin_approvals (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "email" text NOT NULL CHECK (email = lower(email)),
  "approved_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "revoked_by_id" uuid REFERENCES users(id) ON DELETE SET NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS google_signin_approvals_live_email
  ON google_signin_approvals (email) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS google_signin_approvals_live_user
  ON google_signin_approvals (user_id) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS google_signin_nonces (
  "nonce_hash" text PRIMARY KEY,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz
);

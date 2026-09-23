-- Two-step sign-in (authenticator app) for coordinators and admins.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_pending_secret" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_last_step" bigint;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_recovery_hashes" text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
-- Existing sessions stay signed in (false). New sign-ins by coordinators and
-- admins start true until the code is entered or set up.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "mfa_pending" boolean NOT NULL DEFAULT false;

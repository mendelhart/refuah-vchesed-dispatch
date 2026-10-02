-- 0029: email builder. Additive only: two new tables; nothing existing is
-- touched. Used only when EMAIL_BUILDER_ENABLED is true.
--
-- email_designs holds the current design; every save also writes a row in
-- email_design_versions, so any earlier version can be looked at or brought
-- back. Blocks are JSON (heading, text, button, image, divider) checked by
-- the API before they are stored. No personal data: designs hold wording,
-- and merge fields are filled in only when a test is sent.
CREATE TABLE IF NOT EXISTS email_designs (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "subject" text NOT NULL,
  "blocks" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "created_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "updated_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "archived_at" timestamptz
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS email_design_versions (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "design_id" uuid NOT NULL REFERENCES email_designs(id) ON DELETE CASCADE,
  "version" integer NOT NULL,
  "name" text NOT NULL,
  "subject" text NOT NULL,
  "blocks" jsonb NOT NULL,
  "saved_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "saved_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("design_id", "version")
);

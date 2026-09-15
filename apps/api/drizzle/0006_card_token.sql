-- ============================================================================
-- 0006 — an opaque token behind the ID card's QR code.
--
-- The card's verification link previously carried the volunteer number, which
-- is printed on the front of the badge in large type. Anyone who photographed
-- one card could then walk the numbers and confirm every volunteer in the
-- organisation. The QR now carries an unguessable value instead; the number
-- stays on the card for a human to read out.
-- ============================================================================

ALTER TABLE "users" ADD COLUMN "card_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_card_token_uq" ON "users" ("card_token") WHERE "card_token" IS NOT NULL;
--> statement-breakpoint

-- Existing volunteers get one immediately; the application also assigns on
-- demand, so this is belt and braces for a roster migrated before the deploy.
--
-- gen_random_bytes() lives in pgcrypto, which is not assumed to be installed
-- (gen_random_uuid() has been core since Postgres 13, which is why the rest of
-- the schema needs no extension). Two UUIDs give 32 hex characters of core
-- CSPRNG output, which is more than enough and needs nothing added.
UPDATE "users"
   SET "card_token" = replace(gen_random_uuid()::text, '-', '')
                      || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)
 WHERE "card_token" IS NULL AND "deleted_at" IS NULL;

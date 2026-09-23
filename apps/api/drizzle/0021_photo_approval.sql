-- Volunteer photo changes wait for a dispatcher/admin to approve them.
-- pending_photo_action: 'set' (pending_photo holds the new image) or 'remove'.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pending_photo" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pending_photo_action" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pending_photo_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_pending_photo_chk" CHECK (
  pending_photo_action IS NULL
  OR (pending_photo_action = 'set' AND pending_photo IS NOT NULL)
  OR (pending_photo_action = 'remove' AND pending_photo IS NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_pending_photo_idx" ON "users" ("pending_photo_at") WHERE pending_photo_action IS NOT NULL;

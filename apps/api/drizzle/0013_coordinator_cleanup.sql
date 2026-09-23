-- Owner decisions, Sep 23 2026.
-- 1. Retire the old combined channel settings: "text + app" becomes App;
--    "email" and "everything" become SMS. Someone with no phone number cannot
--    be texted, so they get App instead.
UPDATE "users" SET "notification_preference" = 'push' WHERE "notification_preference" = 'both';
--> statement-breakpoint
UPDATE "users" SET "notification_preference" = 'sms'
  WHERE "notification_preference" IN ('email', 'all') AND "phone" IS NOT NULL AND "phone" <> '';
--> statement-breakpoint
UPDATE "users" SET "notification_preference" = 'push'
  WHERE "notification_preference" IN ('email', 'all');
--> statement-breakpoint
-- 2. Remove the leftover admin account that never had a password set. Matched
--    on id, address and "no password" together so nothing else can be caught.
DELETE FROM "sessions" WHERE "user_id" = '96536475-fa43-4595-96ab-5be8dbe19289'
  AND EXISTS (SELECT 1 FROM "users" WHERE "id" = '96536475-fa43-4595-96ab-5be8dbe19289' AND "email" = 'mendelhart@gmail.com' AND "password_hash" IS NULL);
--> statement-breakpoint
DELETE FROM "auth_tokens" WHERE "user_id" = '96536475-fa43-4595-96ab-5be8dbe19289'
  AND EXISTS (SELECT 1 FROM "users" WHERE "id" = '96536475-fa43-4595-96ab-5be8dbe19289' AND "email" = 'mendelhart@gmail.com' AND "password_hash" IS NULL);
--> statement-breakpoint
UPDATE "users"
  SET "status" = 'deactivated', "deleted_at" = now(), "email" = "email" || '.deleted.20260923', "phone" = NULL
  WHERE "id" = '96536475-fa43-4595-96ab-5be8dbe19289' AND "email" = 'mendelhart@gmail.com' AND "password_hash" IS NULL;

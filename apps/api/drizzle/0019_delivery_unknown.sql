-- A provider call that timed out may or may not have sent the message.
-- 'unknown' records exactly that, instead of retrying into a duplicate.
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_status_chk";
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_status_chk"
  CHECK (status IN ('queued','sent','delivered','failed','skipped','unknown'));

-- 'sending' marks a delivery whose provider call is in flight, so a worker
-- that dies mid-call leaves a row that reads as "outcome unknown", not "never tried".
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_status_chk";
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_status_chk"
  CHECK (status IN ('queued','sending','sent','delivered','failed','skipped','unknown'));

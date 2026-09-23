-- Which network carried each message, and why WhatsApp fell back to SMS.
ALTER TABLE "notification_deliveries" ADD COLUMN "carried_by" text;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "fallback_reason" text;

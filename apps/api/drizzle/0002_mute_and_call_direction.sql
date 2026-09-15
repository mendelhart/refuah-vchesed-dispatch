ALTER TABLE "calls" ADD COLUMN "direction" text DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "counterparty_name" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "muted_until" timestamp with time zone;
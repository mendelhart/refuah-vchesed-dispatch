-- Voice calls become a channel and a preference.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_notification_pref_chk";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_notification_pref_chk"
  CHECK (notification_preference IN ('sms', 'push', 'whatsapp', 'voice', 'email', 'both', 'all', 'none'));
--> statement-breakpoint
ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_channel_chk";
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_chk"
  CHECK (channel IN ('sms', 'push', 'email', 'whatsapp', 'voice', 'inapp'));
--> statement-breakpoint
-- What happened on a voice call: accepted, declined, taken, no_choice,
-- no_answer, busy, voicemail, failed.
ALTER TABLE "notification_deliveries" ADD COLUMN "voice_outcome" text;

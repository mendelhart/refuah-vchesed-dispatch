-- ============================================================================
-- 0005 — widen the channel and preference vocabularies.
--
-- The 0001 constraints were written when SMS, push and the in-app feed were the
-- only channels. Email and WhatsApp are now first-class, so the enumerations
-- catch up. They stay as CHECK constraints rather than becoming free text:
-- a typo in a channel name should fail the write, not create a delivery row
-- nothing will ever pick up.
-- ============================================================================

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_notification_pref_chk";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_notification_pref_chk"
  CHECK (notification_preference IN ('sms', 'push', 'whatsapp', 'email', 'both', 'all', 'none'));
--> statement-breakpoint

ALTER TABLE "notification_deliveries" DROP CONSTRAINT IF EXISTS "notification_deliveries_channel_chk";
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_chk"
  CHECK (channel IN ('sms', 'push', 'email', 'whatsapp', 'inapp'));
--> statement-breakpoint

-- Conversations can carry the same channels as notifications.
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_channel_chk"
  CHECK (channel IN ('sms', 'whatsapp'));
--> statement-breakpoint

-- Announcement channels are stored as an array; every element must be a real
-- channel, checked the same way.
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_channels_chk"
  CHECK (channels <@ ARRAY['sms', 'push', 'email', 'whatsapp', 'inapp']::text[]);

-- Volunteers can be added with only a name and a mobile number.
-- Email stays unique among live users when present (users_email_live_uq).
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

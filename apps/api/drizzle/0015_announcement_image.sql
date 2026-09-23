-- Optional picture on a broadcast (simcha invite, flyer). Stored as a data URL, like ID photos.
ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "image_data" text;

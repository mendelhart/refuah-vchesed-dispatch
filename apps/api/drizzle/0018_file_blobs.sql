-- File bytes stored in Postgres (FILE_STORAGE_DRIVER=db), so the database
-- backup also covers uploaded files on hosts with an ephemeral disk.
CREATE TABLE IF NOT EXISTS "stored_file_blobs" (
  "storage_key" text PRIMARY KEY NOT NULL,
  "content_type" text NOT NULL,
  "body" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

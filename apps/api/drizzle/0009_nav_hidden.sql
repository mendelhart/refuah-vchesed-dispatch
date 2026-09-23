-- Per-user menu preferences: which sidebar/feature-list entries this person
-- has hidden. Dispatcher simplification: each dispatcher keeps only the
-- screens they actually use in view. Empty = show everything.
ALTER TABLE "users" ADD COLUMN "nav_hidden" text[] DEFAULT '{}'::text[] NOT NULL;

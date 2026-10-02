-- Additive only. Existing applications have no token and fail closed until a
-- reviewer issues a new scoped request-more-information link.
ALTER TABLE volunteer_applications ADD COLUMN ownership_token_hash text;
--> statement-breakpoint
ALTER TABLE volunteer_applications ADD COLUMN ownership_expires_at timestamptz;

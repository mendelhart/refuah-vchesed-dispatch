-- Additive roster only. Never creates accounts, credentials, dispatch enrolment or messages.
CREATE TABLE IF NOT EXISTS volunteer_roster_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 source_key text NOT NULL UNIQUE,
 member_number text NOT NULL UNIQUE CHECK (member_number ~ '^RVC[0-9]{4}$'),
 full_name text NOT NULL,
 yiddish_name text,
 source_status text NOT NULL CHECK (source_status = 'Active'),
 unit_number text,
 plate text,
 data jsonb NOT NULL,
 source_refs jsonb NOT NULL,
 review_state text NOT NULL DEFAULT 'candidate' CHECK (review_state IN ('candidate','held','reviewed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE volunteer_roster_drafts IS 'Inert source roster for admin draft artwork. No users/vehicles/auth/service/notification effects.';
-- Member namespace RVC#### is separate from users V####; no user sequence change.

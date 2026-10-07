-- Private preparation only. No token, public access, users or dispatch effects.
CREATE TABLE card_preparations (
 roster_id uuid PRIMARY KEY REFERENCES volunteer_roster_drafts(id),
 unit_number text NOT NULL CHECK (unit_number ~ '^[0-9]{1,3}$' AND unit_number::integer BETWEEN 1 AND 999),
 fields jsonb NOT NULL,
 verification_state text NOT NULL DEFAULT 'unissued' CHECK (verification_state IN ('unissued','active','lost','revoked','inactive')),
 groups jsonb NOT NULL DEFAULT '[]'::jsonb,
 revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX card_preparations_unit_unique ON card_preparations ((unit_number::integer));
COMMENT ON TABLE card_preparations IS 'Saved private card preparation. Hospital verification is not active; no issuance or dispatch side effects.';

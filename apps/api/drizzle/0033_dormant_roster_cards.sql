-- Empty dormant issuance store. No inserts, backfill, users or operational vehicle changes.
CREATE TABLE roster_verification_cards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 roster_id uuid NOT NULL REFERENCES volunteer_roster_drafts(id),
 kind text NOT NULL CHECK(kind IN ('volunteer','vehicle')),
 token_cipher text NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('active','lost','revoked','inactive')),
 active_confirmed boolean NOT NULL DEFAULT false,
 public_name text NOT NULL,
 unit_number text NOT NULL CHECK(unit_number ~ '^[0-9]{1,3}$' AND unit_number::integer BETWEEN 1 AND 999),
 public_photo text,
 expires_at timestamptz NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL DEFAULT 1
);
CREATE TABLE roster_card_status_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 card_id uuid NOT NULL REFERENCES roster_verification_cards(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 state text NOT NULL CHECK(state IN ('active','lost','revoked','inactive')),
 created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE roster_verification_cards IS 'Isolated approved card issuance. No operational account or dispatch effects.';

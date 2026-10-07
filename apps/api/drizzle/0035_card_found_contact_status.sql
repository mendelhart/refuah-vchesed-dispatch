-- Keep all existing records. Reporter contact stays in the private admin inbox.
ALTER TABLE roster_card_reports ADD COLUMN phone text;
ALTER TABLE roster_card_reports ADD COLUMN preferred_contact_method text CHECK (preferred_contact_method IN ('phone','text','WhatsApp','email'));
ALTER TABLE roster_verification_cards DROP CONSTRAINT roster_verification_cards_state_check;
ALTER TABLE roster_verification_cards ADD CONSTRAINT roster_verification_cards_state_check CHECK (state IN ('active','lost','revoked','inactive','suspended'));
ALTER TABLE roster_card_status_events DROP CONSTRAINT roster_card_status_events_state_check;
ALTER TABLE roster_card_status_events ADD CONSTRAINT roster_card_status_events_state_check CHECK (state IN ('active','lost','revoked','inactive','suspended'));

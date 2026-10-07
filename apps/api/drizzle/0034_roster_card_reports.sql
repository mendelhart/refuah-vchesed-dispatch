-- Reporter-entered data only. No outbound communications or automatic identity verification.
CREATE TABLE roster_card_reports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 card_id uuid REFERENCES roster_verification_cards(id),
 reporter_name text NOT NULL,
 organization_type text NOT NULL,
 organization_name text NOT NULL,
 contact text NOT NULL,
 report_type text NOT NULL,
 message text NOT NULL,
 identity_status text NOT NULL DEFAULT 'unverified' CHECK(identity_status='unverified'),
 created_at timestamptz NOT NULL DEFAULT now()
);

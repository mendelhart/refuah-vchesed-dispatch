-- 0026: departments and who belongs to them. Additive only: two new tables
-- and four rows in the new departments table; nothing existing is touched.
--
-- Departments are separate from roles. A coordinator who belongs to one or
-- more departments works only within them; a coordinator who belongs to none
-- keeps exactly today's access. Admins always see everything. Enforced only
-- when DEPARTMENT_SCOPING_ENABLED=true. No personal data beyond who belongs.
CREATE TABLE IF NOT EXISTS departments (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS department_members (
  "department_id" uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "added_by_id" uuid REFERENCES users(id) ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("department_id", "user_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "department_members_user_idx" ON department_members ("user_id");--> statement-breakpoint
INSERT INTO departments (slug, name) VALUES
  ('rides', 'Rides'),
  ('food', 'Food'),
  ('equipment', 'Equipment'),
  ('reports', 'Reports')
ON CONFLICT (slug) DO NOTHING;

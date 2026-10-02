# Gap build progress (items 1-9 of the October 1, 2026 handoff)

An implementation record. Each entry says what was verified and how; nothing
here is live until the owner approves and it is merged and enabled.

## Item 1. Foundation (branch `feat/1-foundation`)

Verified locally on Postgres 16 with the full API suite, lint and typecheck.

1. Permission matrix (`permission-matrix.test.ts`): reads all 188 routes from
   the server and probes each as anonymous, volunteer, dispatcher and admin.
   Every non-public route refuses anonymous (401); every coordinator and admin
   route refuses a volunteer with the role guard's own 403; 28 admin-only
   routes refuse a dispatcher the same way; no route answers a probe with a
   5xx. It found one 500 (empty vehicle PATCH), now a 422.
2. Idempotency keys (`lib/idempotency.ts`, migration 0024, additive): needs
   both `IDEMPOTENCY_KEYS_ENABLED` (default off) and a route that opts in;
   only `POST /api/trips` opts in so far. Runs after the route's guards;
   stores only successful answers; sign-in and password routes never take
   part. 17 tests: double submit, six simultaneous duplicates (one trip), key
   reuse with a different request, per-person keys, refused and invalid
   requests not using the key, 5xx release, abandoned-request takeover after
   5 minutes, 24-hour expiry and daily purge. The web app does not send the
   header yet.
3. Staging: `npm run db:seed:staging` and `docs/STAGING.md`. Invented data
   only; refuses production, remote hosts, databases with real people
   (including phone-only accounts, callers and passengers) and half-seeded
   databases.
4. Fake messaging: `fake-messaging.test.ts` fails if any channel in CI is not
   the in-memory provider. Existing behaviour unchanged.
5. Outage drill: `scripts/outage-drill.sh`, 8 of 8 checks pass. Found that
   `/health` answered 500, not 503, with the database down (rate limiter ran
   first); plain `/health` is now outside the limiter (`/health/deep` is not).
   Refuses non-throwaway database names and databases with real people. `docs/OUTAGE_DRILL.md` covers
   alerts (Sentry, uptime) and the free-hours limit; both stay off.
6. Privacy text: draft updated in `docs/drafts/` with the agreed facts (no
   two-step sign-in, no automatic backups, licence optional and encrypted).
   Not published; needs the owner's answers in brackets.

Note for later items: every branch that adds a migration must give its
journal entry a `when` later than everything already applied in production
when it is merged, not when it is branched; drizzle skips older ones.

Open for the owner: whether to turn on Sentry and an uptime check (and how
often); the privacy draft's bracketed answers. Not done here: the axe
accessibility checks in CI (item 2, next).

## Infrastructure

- CI and the local database now run Postgres 18, the version Aiven runs in
  production. docker-compose uses a new volume (`db18-data`), so an existing
  local PG16 volume is left alone.
- Nightly backup (`.github/workflows/backup.yml`):
  - built for Aiven PG18: pg_dump 18 with Aiven's CA certificate
  - the restore is checked in a throwaway PG18 container
  - encrypted with gpg and stored in a private bucket
  - never uploaded as a workflow artifact, because this repository is public
  - does nothing until its seven `BACKUP_*` secrets are set
- Uptime check (`.github/workflows/uptime.yml`): hourly in the daytime, on
  GitHub's own scheduler. The URL is kept in the `UPTIME_URL` secret. See
  OUTAGE_DRILL.md.

## Item 2. Accessibility

- An axe (WCAG 2.1 AA) audit runs at phone width on 34 pages, in light and
  dark mode.
- Every page is checked for sideways scrolling at 360 px and with 200% text,
  plus one test that the keyboard focus ring is visible.
- Colour-contrast fixes: secondary text is darker, the red text is a darker
  red, and toasts meet 4.5:1.

## Item 3. Journeys (`MULTI_LEG_TRIPS_ENABLED`)

- Covers round trips (including "ride home when they call"), extra stops and
  several passengers. Seat counts are checked when a driver is suggested,
  assigned or reassigned.
- Migration 0025 adds new tables only.

## Item 4. Departments (`DEPARTMENT_SCOPING_ENABLED`)

- Rides, food, equipment and reports. A coordinator listed in a department
  works only there; one listed nowhere keeps full access.
- The rule is enforced on the server for every route. The menu hides what
  they cannot use.
- Migration 0026.

## Item 5. Food operations (`FOOD_OPS_ENABLED`)

- Stock, vendors, kitchen preparation slots with volunteer sign-up, and
  distribution runs.
- Shopping lists are sent once, to a previewed list of people.
- Migration 0027.

## Item 6. Packages and lift assist (`PACKAGE_DELIVERY_ENABLED`, `LIFT_ASSIST_ENABLED`)

- A package delivery is an equipment-delivery trip with the package
  described and a proof of delivery.
- Lift assist asks a few chosen, free helpers by name, once. The first yes
  leads, and the request closes when full.
- Migration 0028.

## Item 7. Languages (`LANGUAGES_ENABLED`, default English only)

- French and Hebrew catalogs for the sign-in page, menus, home and settings.
  Hebrew runs right to left.
- Both translations are drafts that need a fluent reviewer (see
  LANGUAGES.md).

## Item 8. Reports (`REPORTS_ENABLED`)

- Totals per department, trends by day, week or month, staffing (rides that
  got a driver, typical wait, phone duty, kitchen places) and equipment
  status.
- CSV downloads with no personal data and spreadsheet formulas neutralised.
- Test rides are left out. Borrower names appear for admins only.
- No migration.

## Item 9. Email builder and Google sign-in

- **Email builder** (`EMAIL_BUILDER_ENABLED`, migration 0029):
  - blocks: heading, paragraph, button, picture, line
  - merge fields from a fixed list, with a live preview
  - every save is a version that can be brought back, and two people cannot
    overwrite each other
  - "Send me a test" goes only to your own address and always through the
    fake email provider
  - there is no route that sends to anyone else
- **Google sign-in** (`GOOGLE_SIGNIN_ENABLED` + `GOOGLE_CLIENT_ID`,
  migration 0030): **needs Mendel's OK with the exact diff before merging.**
  - only administrator-approved, existing, active accounts can use it
  - password sign-in is unchanged
  - no client secret, no Google script, and no change to the content
    security policy
  - see GOOGLE_SIGNIN.md

Migration journal `when` values: 0024 to 0030 are 1790743200000 to
1790743800000. Each is later than the one before it and later than
everything on main at 1e8478c.

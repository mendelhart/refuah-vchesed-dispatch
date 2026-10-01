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

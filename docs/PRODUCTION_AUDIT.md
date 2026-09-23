# Refuah V'Chesed Dispatch: Production Audit

Audit and hardening pass against the "Production Hardening Command" (sections 1-31), September 23, 2026. Repo `mendelhart/refuah-vchesed-dispatch`, branch `main`. The live API (`rvc-api` on Render) deploys from `main` automatically. The owner approved deploying each batch as it passed.

## Executive Summary

**Architecture.** Keep it. It is one Fastify API, Postgres as the only source of truth, a Postgres job queue using `FOR UPDATE SKIP LOCKED`, and a React PWA. Critical paths are enforced in SQL: compare-and-set claims, partial unique indexes, CHECK constraints and append-only audit triggers. Nothing found in this audit needs Redis, microservices or a rewrite. Every fix is small and local.

**Real defects found and fixed:**
- Coordinators/admins could accept a trip with a volunteer's code, and it was recorded as the volunteer's claim (F-06).
- Inbound SMS/WhatsApp idempotency was check-then-insert, so two concurrent redeliveries could both act (F-02).
- A provider timeout was treated as "failed" and retried, so the same message could be sent twice. A late "failed" callback could overwrite "delivered" (F-10a/b).
- Two workers could send the same notification (F-10c).
- A slow job worker could overwrite a newer run's result, and a job that crashes the worker looped forever (F-11a/b).
- Overlapping standing-ride runs could create and offer the same ride twice (F-14).
- The offline cache of a volunteer's rides (passenger address and phone) outlived logout on the phone (F-16).
- Uploaded licence photos were on ephemeral disk and were lost on every Render restart (F-03).
- Encryption had no key ids or rotation path (F-04).
- `SENTRY_DSN` did nothing because `@sentry/node` wasn't installed, and there was no operational health check (F-05).

**Production blockers, all needing the owner:**
1. Nightly backups do not run. The GitHub secrets `BACKUP_DATABASE_URL` and `BACKUP_PASSPHRASE` are not set, and every nightly run fails.
2. No error alerting. There is no Sentry DSN and no uptime monitor, so nobody is told when the API is down.
3. Render deploys every push, even when CI fails (see F-19).

**Remaining risks:**
- The recovery point is 24 hours at best (nightly dump, no PITR).
- The Render free tier sleeps after inactivity: the first request is slow and the in-process worker pauses.
- SMS/WhatsApp sending is in test mode (`MESSAGING_TEST_MODE=true`, Twilio on hold), so real delivery is untested in production.
- 2FA is off by owner decision until a domain is connected.

## Findings

Severity is the spec's rating or mine. Status "CI" means covered by a test that ran green in GitHub Actions. "CI pending" means the test was pushed but its run had not finished when this was written.

| ID | Sev | Category | Files / route | Problem | Impact | Fix | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| F-02 | HIGH | Webhooks | `routes/webhooks.routes.ts` `handleInboundText` | Seen-check then insert. Concurrent redeliveries both ran the command | Double accept/decline, duplicate replies | Insert a `processing` row keyed by provider id first; only the winner acts; a failed attempt is retryable; forged requests can't burn a real sid | `sms-webhook.test.ts` (duplicate, concurrent, retry, forged) | Fixed, CI |
| F-03 | HIGH | Files/DR | `providers/objectstore.ts`, `files.service.ts`, migration 0018, `render.yaml` | Licence images on local disk; Render free disk is ephemeral and not in any backup | Images lost on every deploy/restart | `db` object-store driver (`stored_file_blobs`), so files ride in the Postgres backup. Live with `FILE_STORAGE_DRIVER=db`. `files:check` consistency report. Missing object gives a clear 404 | `file-storage.test.ts` | Fixed, CI, live |
| F-04 | HIGH | Crypto | `lib/crypto.ts`, `lib/key-rotation.ts`, `db/rotate-keys.ts` | No key id on ciphertext and no rotation path | A key compromise couldn't be handled without downtime/data loss | `v2.<keyId>` values, decrypt-only `FIELD_ENCRYPTION_OLD_KEYS`, non-destructive `keys:rotate`, legacy values still read. `docs/KEY_ROTATION.md` | `key-rotation.test.ts` | Fixed, CI |
| F-05 | HIGH | Monitoring | `lib/monitoring.ts`, `lib/health-checks.ts`, `routes/index.ts`, `jobs/worker.ts` | `@sentry/node` not installed; no deep health | Silent failures | Installed Sentry. `/health/deep` checks the database, worker heartbeat, stuck/dead jobs, standing rides, storage, delivery and signature failure spikes, and unassigned rides near pickup (503 on critical). Worker reports dead jobs. Runbook | `health-checks.test.ts` | Fixed in code, CI. **Alerts need a DSN and an uptime monitor** |
| F-06 | HIGH | AuthZ | `domain/dispatch.service.ts` `claimTrip`, `POST /api/trips/:id/claim` | A coordinator/admin holding a volunteer's offer code could accept, recorded as the volunteer's own claim | False attribution, bypass of Assign audit | The claim path is only ever a volunteer accepting their own offer, for every role; others are told to use Assign; unused 'dispatcher' claim channel removed | `claim-authz.test.ts` | Fixed, CI |
| F-07 | verify | Dispatch | claim SQL | Atomic acceptance | - | Verified correct (compare-and-set plus `trip_offers_one_accepted_uq`) | `concurrency.test.ts`: accept vs cancel, accept vs expiry, losers superseded | Verified, CI |
| F-08 | verify | Privacy | all `:id` routes | IDOR/BOLA | - | No hole found | `idor.test.ts` | Verified, CI |
| F-09 | LOW | Auth | `server.ts` MFA-pending gate | Gate matched the raw URL; an encoded or double-slash path could slip past | Only relevant once 2FA is on | Gate uses the matched route (`routeOptions.url`) | `mfa.test.ts` | Fixed, CI |
| F-10a | MED | Notifications | `notification.service.ts`, migration 0019 | Provider timeout marked failed and retried | Duplicate SMS/calls | New `unknown` state, never auto-retried; counted in health | `delivery-semantics.test.ts` | Fixed, CI |
| F-10b | MED | Notifications | status callback | Late `failed` callback overwrote `delivered` | Wrong status on dashboards/escalation | State only moves forward | same | Fixed, CI |
| F-10c | MED | Notifications | migration 0020 | Two workers could both send a queued delivery | Duplicate messages | Claim `queued -> sending` before the provider call; a `sending` row seen again becomes `unknown` | same | Fixed, CI |
| F-11a | MED | Jobs | `jobs/queue.ts` `completeJob/failJob` | A reclaimed slow worker could settle the job over the newer run | Lost or duplicated work | Only the lock holder can settle | `job-queue.test.ts` | Fixed, CI |
| F-11b | MED | Jobs | `reclaimStalledJobs` | A job that crashes the worker every time was requeued forever | Infinite loop, starved queue | Dead after `max_attempts` | same (two workers, dedupe, backoff then dead, crash reclaim) | Fixed, CI |
| F-12 | LOW | Availability/UX | `MyAvailability.tsx`, `docs/DATABASE.md` | Overnight hours must be two windows; the UI error didn't say how | Volunteers unable to enter night shifts | Error text and help explain 22:00-00:00 + 00:00-02:00. Engine unchanged (verified correct) | `availability-edges.test.ts` (midnight, overnight, Sat->Sun wrap, both DST changes, exceptions, emergency) | Fixed, CI |
| F-13 | verify | Targeting | `domain/targeting.ts` | Order and reasons | - | Verified. Emergency never relaxes group; reasons are fixed phrases that never carry private notes | `targeting.test.ts` (+2) | Verified, CI |
| F-14 | MED | Recurring | `recurring.service.ts` `materialiseDueRides` | Select-then-insert. Scheduled job and "run now" could both create and offer the same date | Duplicate trips and offers | Claim `(ride, date)` via unique index before creating; release on failure | `recurring.test.ts` overlapping runs | Fixed, CI |
| F-15 | verify | Calendar | `lib/hebcal.ts` | Shabbos/yom tov boundaries | - | Verified over 14 months incl. 3-day yom tov; Montreal location/timezone explicit | `rest-periods.test.ts` | Verified, CI |
| F-16 | HIGH (privacy) | PWA | `service-worker.js` cache, `lib/auth.tsx`, `lib/api.ts`, `lib/offline.ts` | Offline ride cache (address, phone) survived logout and ended sessions | Next user of a shared phone could read it | Cache wiped on logout, on login and on any 401. Offline banner says the data is a saved copy | typecheck + web unit; offline read already in `pwa.spec.ts` | Fixed. **Manual phone check recommended** |
| F-17 | MED | E2E | `apps/web/e2e/offer-flow.spec.ts` | No browser test of offer -> accept -> race -> complete -> cancel | Core flow unguarded in UI | Added | offer-flow (2 tests x phone/desktop) | CI pending (first run failed on test data; fixed in 302fedb) |
| F-18 | LOW | Supply chain | `ci.yml`, `.github/dependabot.yml` | No vulnerability gate or update strategy | Unnoticed vulnerable deps | `npm audit --omit=dev --audit-level=high` in CI (0 found; 6 moderate in dev-only tools); Dependabot weekly/monthly, capped | CI | Fixed |
| F-19 | HIGH | CI/CD | Render service settings | Render deploys on commit, even if CI fails | A broken build can go live | **Not changed.** Render's "After CI Checks Pass" would never deploy while the Fly `deploy` job (left as is by owner instruction) fails on every push. Fix: remove or disable the Fly workflow, then set `autoDeployTrigger: checksPass` | - | Open |
| F-20 | HIGH | Backup | `.github/workflows/backup.yml`, `docs/BACKUP_AND_RESTORE.md` | Backups not running (secrets unset); RPO 24h; no PITR | Data loss on failure | Documented honestly; PITR listed as a paid enhancement | - | Open (owner) |
| F-22 | LOW | Audit | `auth/session.ts` | Failed/locked-out logins were not audited | Brute force invisible after the fact | `auth.login_failed` / `auth.login_locked` against real accounts only; never passwords or unknown identifiers | `auth.test.ts` | Fixed, CI |
| F-23a | LOW | API | `GET /health/deep` | Public unless `HEALTH_CHECK_TOKEN` is set | Exposes operational counts (no personal data) | Set `HEALTH_CHECK_TOKEN` on Render and use `?token=` in the uptime monitor | - | Open (owner, config) |
| F-23b | LOW | API | `GET /api/announcements/:id/image` | Unauthenticated, cached publicly | Anyone with the UUID can view an announcement picture | Acceptable if announcement images are non-sensitive; otherwise require auth | - | Open (decision) |
| F-25 | verify | Twilio/WAHA | `webhooks.routes.ts`, `env.ts` | Signatures | - | Twilio signature on every webhook; skip flag refused in production; WAHA HMAC-SHA512 with timing-safe compare, unsigned refused in production | `sms-webhook.test.ts`, new `waha-signature.test.ts` | Verified |
| F-26 | MED | Retention | `docs/SECURITY.md` | Trips, caller records, licence images of departed volunteers, rejected applications and audit events have no defined retention (kept indefinitely) | More personal data held than needed | **Flagged, not invented.** The organisation must set a policy | - | Open (policy) |

## Fixed
F-02, F-03, F-04, F-05 (code), F-06, F-09, F-10a/b/c, F-11a/b, F-12, F-14, F-16, F-17, F-18, F-22. Migrations added: 0018 (file blobs), 0019 (delivery `unknown`), 0020 (delivery `sending`). They apply on deploy and are already live.

## Verified Safe
- Atomic acceptance and losers superseded (F-07).
- Object-level authorization across trips, logs, notifications, availability and admin-only surfaces (F-08). Pausing a user ends their session.
- Targeting order: group, service, capability, availability, conflict, snooze. Priority relaxation; "no rules = no restriction" (F-13).
- Availability at midnight, overnight, DST and exceptions (F-12). Shabbos/yom tov boundaries (F-15).
- Webhook signature checks (F-25).
- Account lockout independent of IP; identical errors for unknown account and wrong password.
- Every route without a `preHandler` was reviewed: login/logout/me, invite and password reset (rate-limited), public signup options, card verify, push public key, health, and signed webhooks.
- Request body limit 1 MB (licence upload route 14 MB); global rate limit; zod validation on inputs; parameterised SQL (drizzle `sql` template); no shell execution from request data.
- Performance: indexes exist for every hot path (trips status/pickup/group/assignee/open, offers per volunteer/trip/expiry, deliveries pending/status/provider id, audit by entity/actor/action/time, jobs claim/dedupe, availability by user). Trip lists are paginated (`limit + 1`). The CI load test (5 accounts x 4 phones, about 1 req/s, p95 < 1.5 s) passes. Query plans were **not** captured against production-sized data.

## Remaining Work
- **HIGH (owner):** set backup secrets (F-20); create a Sentry DSN and an uptime monitor (F-05); resolve the Fly job, then gate Render on CI (F-19).
- **MEDIUM:** define a retention policy (F-26); PITR when budget allows; manually test offline and logout on a real phone (F-16); test real SMS/WhatsApp delivery once Twilio/WAHA credentials exist.
- **LOW:** set `HEALTH_CHECK_TOKEN` (F-23a); decide announcement image privacy (F-23b); re-enable 2FA after a domain is connected; add a "test ride" flag so test data doesn't trip the unassigned-ride warning.

## Test Results
All tests run in GitHub Actions against Postgres 16 with real migrations. No local database was available in the audit environment, so full suites were not run locally. Locally: `tsc --noEmit` for api and web on every commit, `vitest` for web units and for the database-free `rest-periods` and `waha-signature` files.

- `npm run test --workspace=@rvc/api`: **337 passed (33 files)** at `fb3681a`.
- `npm test --workspace=@rvc/web`: **15 passed**.
- `npm test --workspace=@rvc/migrate`: **126 passed**.
- `eslint . --max-warnings=0`, typecheck, build, and the API/web Docker image builds: green.
- `./scripts/e2e.sh` (Playwright, phone and desktop) at `fb3681a`: 55 passed, 4 failed. All 4 were the new offer-flow tests: pickups collided with the test volunteer's earlier ride, and the refusal wording differed. Fixed in `302fedb`; result below.
- `npm audit --omit=dev`: 0 vulnerabilities.

BROWSER_RESULT_PLACEHOLDER

## Deployment Readiness
- **Code:** ready for the current single-instance, free-tier deployment. Known defects above are fixed with tests.
- **Infrastructure:** Render free tier sleeps and has no persistent disk (handled by the db file driver). A paid instance is needed for always-on dispatch and for reliable timers (offer expiry, escalation). Render deploys without waiting for CI (F-19).
- **Security:** authz, signatures, lockout, encryption with rotation, and audit are all in place. 2FA is off by decision. `HEALTH_CHECK_TOKEN` is unset.
- **Backup/DR:** **not ready.** Backups are not running until secrets are set. The best case is 24 h RPO with no PITR. Encryption keys must be in the owner's vault.
- **Monitoring:** **not ready.** Checks exist, but no one is alerted without a Sentry DSN and an uptime monitor.
- **Operational:** SMS/WhatsApp are in test mode, so volunteers receive in-app/push only. Real-channel delivery needs credentials and a live test.

## Final response (§31)
1. Files changed: 66 (see `git diff --stat 61f898d^..HEAD`), about 3,000 lines, mostly tests and docs.
2. Tests added: `delivery-semantics`, `job-queue`, `availability-edges`, `rest-periods`, `idor`, `claim-authz` (extended), `waha-signature`, `offer-flow.spec.ts` (e2e), plus additions to `sms-webhook`, `concurrency`, `mfa`, `targeting`, `recurring`, `auth`, `file-storage`, `key-rotation`, `health-checks`.
3-4. See Test Results.
5. Critical findings fixed: F-02, F-03, F-04, F-05 (code), F-06, F-16.
6. Remaining: HIGH F-19, F-20 and F-05 alerting; MEDIUM F-26 plus real-channel and phone tests; LOW F-23a/b.
7. Not verifiable here: production query plans, real SMS/WhatsApp delivery, backup restore on live data (backups not running), Sentry alerts.
8. Manual production tests: logout/offline on a phone; one real restore drill once backups run; a real SMS round trip when Twilio is on.
9. Deployment actions: migrations 0018-0020 applied automatically. Owner still needs to set `BACKUP_DATABASE_URL`, `BACKUP_PASSPHRASE`, `SENTRY_DSN` and `HEALTH_CHECK_TOKEN`, and add an uptime monitor.
10. Architecture preserved: yes. No new services, no Redis, no framework changes, no dispatch or calendar rule changes.

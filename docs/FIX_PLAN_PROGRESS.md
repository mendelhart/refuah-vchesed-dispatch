# Approved fix plan progress - September 30, 2026

This is an implementation record, not a claim that the app is production-ready.

1. Keep-awake: NOT ENABLED. The blueprint has two free web services. 18 h/day x 31 days x 2 = 1,116 hours versus 750 shared hours. Live September usage is 298.75/750 hours. API-only 18.25h/day leaves about 184h/month for the frontend, which is not bounded, so it remains off.
2. Immediate ordered catch-up on boot added; persisted queue already supported overdue jobs. Timed and queue tests cover expired offers and pauses. Claimed batches are explicitly sorted by due time and ID; SQL RETURNING order is not assumed. Expired offers are no longer sent stale reminders.
3. Admin in-app/push alert records plus independent Board polling added. Database outage cannot persist a push; the Board shows a failed-check warning. Actual push delivery still depends on VAPID configuration; no channel activated.
4. Admin full backup added under side menu > Admin > Full backup (removed from the Board per Sept 30 owner steering): consistent pg_dump custom archive, scrypt + AES-256-GCM encryption, restore utility, audit and 7-day download reminder. A download is not a verified offsite copy. Render field-encryption keys are still needed for restored licence content. Memory limit is 128 MB and pg_dump timeout 120 seconds.
5. Expiry countdown added, based on the previously verified October 22 date. Confirmed against live Render September 30; replacement DBs require updating the setting.
6. Generated HEALTH_CHECK_TOKEN added to blueprint. No existing production key changed.
7. New personal retention is fail-closed. Engine implemented with positive explicit periods required, per-row audit and shared-address isolation. Isolated test covers an old completed trip sharing a clinic address; an additional isolated test covers rejected applications and a removed user sharing a licence image with an active user. Owner approved activation September 30 at 2:03am; enabled in branch blueprint, not yet released. Existing traffic retention is unchanged. Owner confirmed 12 months for all three classes September 30 at 2:01am. Branch configuration uses 12 calendar months for each, with UTC month-end clamping; activation approved September 30 at 2:03am and enabled in branch blueprint; live release pending.
8. Privacy draft in docs/drafts only. Current public notice unchanged; new wording requires owner review.
9. Announcement pictures require sign-in and private/no-store cache headers.
10. Atomic DB-backed rate limits survive process restarts; hashed keys and expired counter cleanup added. Migration 0022.
11. Admin password reset links added; Copy, native Text and Share buttons. WhatsApp opens the phone's share chooser (or copy fallback), not an automatic send. Links expire after one hour.
12. Added timed catch-up tests and fake-clock pause test. Existing escalation/reminder tests pass; a Date-only fake-clock test exercises reminder, escalation and offer expiry without sleeping; pause expiry covered separately.
13. 50-offer simultaneous-accept conflict test added to API suite, run in CI. Exactly one accepted ride and one assignment.
14. Added phone browser tests for private admin controls, reset-link creation and volunteer mutation restrictions. Phone browser test submits a volunteer photo request, approves from the roster and verifies the volunteer receives the approved photo. API photo tests pass.
15. Test-ride flag added in create form, schema and DB migration 0023; excluded from health warnings, Board counts and impact totals. Existing rides remain non-test.
16. In-app confirmation dialogs replace listed roster/contact/address/duty pop-ups. Other photo/ride-decline pop-ups were outside this batch.
17. Coordinator phone bottom navigation now points to More instead of Settings; Settings remains under profile. Settings is also under profile for coordinators; phone roster and approval UI inspected.
18. Volunteer getting-started includes offers/accepting, availability, profile and ID card.
19. Extracted volunteer roster components, recurring form model, contact filter model and signup form model. Typecheck and web-model tests pass; also extracted VolunteerDrawer, RecurringWeekdayPicker, ContactCard and signup steps without changing their behavior.
20. Removed unused Fly config files; documented dispatcher means Coordinator.

Separate nightly backup credentials were requested securely, not installed. No live deletion has occurred. No paid plan, two-factor activation or real messaging activation is included.

Latest test status: first batch CI passed at 4e1f425. Second batch focused API tests (22), phone browser tests (30), typecheck and lint pass; second full CI pending. Restore rehearsal with test data passed including binary blobs and audit records. Production offsite backup remains unverified. Render live billing: 298.75/750 hours used September 30; DB expiry confirmed October 22, 2026.

Retention activation: owner confirmed the final mapping and switching it on September 30, 2:03am. Blueprint now sets PERSONAL_RETENTION_ENABLED=true and all three *_MONTHS values to 12. On the first successful cleanup job after release, all already-eligible records are scrubbed, with audit events. Live backlog not verified. Main and live Render still unchanged until release.

# Approved fix plan progress - September 30, 2026

This is an implementation record, not a claim that the app is production-ready.

1. Keep-awake: NOT ENABLED. The blueprint has two free web services. 18 h/day x 31 days x 2 = 1,116 hours versus 750 shared hours. API-only ping needs live workspace usage checked before enabling.
2. Immediate ordered catch-up on boot added; persisted queue already supported overdue jobs. Timed and queue tests cover expired offers and pauses. Urgency reprioritization still needs review.
3. Admin in-app/push alert records plus independent Board polling added. Database outage cannot persist a push; the Board shows a failed-check warning. Actual push delivery still depends on VAPID configuration; no channel activated.
4. Admin full backup added under side menu > Admin > Full backup (removed from the Board per Sept 30 owner steering): consistent pg_dump custom archive, scrypt + AES-256-GCM encryption, restore utility, audit and 7-day download reminder. A download is not a verified offsite copy. Render field-encryption keys are still needed for restored licence content. Memory limit is 128 MB and pg_dump timeout 120 seconds.
5. Expiry countdown added, based on the previously verified October 22 date. Revalidate against live Render before rollout; replacement DBs require updating the setting.
6. Generated HEALTH_CHECK_TOKEN added to blueprint. No existing production key changed.
7. New personal retention is fail-closed. Engine and address isolation NOT FINISHED. Existing traffic retention is unchanged. No proposed 90d/12mo/2yr policy is enabled.
8. Privacy draft in docs/drafts only. Current public notice unchanged; new wording requires owner review.
9. Announcement pictures require sign-in and private/no-store cache headers.
10. Atomic DB-backed rate limits survive process restarts; hashed keys and expired counter cleanup added. Migration 0022.
11. Admin password reset links added; Copy, native Text and Share buttons. WhatsApp opens the phone's share chooser (or copy fallback), not an automatic send. Links expire after one hour.
12. Added timed catch-up tests and fake-clock pause test. Existing escalation/reminder tests pass; fake-clock coverage for every timed flow is still incomplete.
13. 50-offer simultaneous-accept conflict test added to API suite, run in CI. Exactly one accepted ride and one assignment.
14. Added phone browser tests for private admin controls, reset-link creation and volunteer mutation restrictions. Photo-approval browser flow still pending; API photo tests pass.
15. Test-ride flag added in create form, schema and DB migration 0023; excluded from health warnings, Board counts and impact totals. Existing rides remain non-test.
16. In-app confirmation dialogs replace listed roster/contact/address/duty pop-ups. Other photo/ride-decline pop-ups were outside this batch.
17. Coordinator phone bottom navigation now points to More instead of Settings; Settings remains under profile. Wider menu cleanup still pending phone review.
18. Volunteer getting-started includes offers/accepting, availability, profile and ID card.
19. Extracted volunteer roster components, recurring form model, contact filter model and signup form model. Typecheck and web-model tests pass; further component extraction can continue without behavior changes.
20. Removed unused Fly config files; documented dispatcher means Coordinator.

Separate nightly backup credentials were requested securely, not installed. No data deletion, paid plan, two-factor activation or real messaging activation is included.

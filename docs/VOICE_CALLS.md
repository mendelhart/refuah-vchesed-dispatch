# Voice-call channel (design - not built)

Status: design for review. Nothing here is implemented yet. Needs Twilio
credentials (account SID, auth token, a voice-capable number) before it can run.

## Goal

Everything SMS does for a volunteer today also works as an automated phone
call: the volunteer hears the trip, presses a key (or says "yes") to accept,
and gets the same confirmation, reminders and cancellations. Useful for older
drivers who don't read texts while driving, and as a last resort when an offer
is going unanswered.

## Channels after this change

| Channel  | Carrier                  | Fallback                                  |
|----------|--------------------------|-------------------------------------------|
| WhatsApp | WAHA (org's own server)  | SMS via Twilio, once Twilio is configured |
| SMS      | Twilio                   | none (push + in-app always run alongside) |
| Voice    | Twilio Voice             | SMS after the call fails or goes unanswered |
| Push     | Web Push                 | -                                         |

## Volunteer preference

- New value `voice` for `notification_preference`, set by the volunteer
  (profile) or by a dispatcher (People / Volunteers).
- Optional quiet hours for calls (default: no calls 22:00-07:00 unless the trip
  is marked urgent). Texts are not affected.
- Calls are never the only carrier: push + in-app always go too, and an
  unanswered call falls back to SMS (below).

## Call flow (offer)

1. Dispatch offers a trip. For volunteers who prefer `voice`, a
   `notification_deliveries` row with channel `voice` is queued, like SMS.
2. The worker places an outbound call through Twilio (`calls.create`) with
   `machineDetection=DetectMessageEnd`, a status callback, and a 30s ring timeout.
3. When answered by a person, Twilio fetches TwiML from
   `POST /webhooks/twilio/voice-offer/:deliveryId` (signature-checked like the
   SMS webhook). The call says, in English (French/Yiddish recordings later):

   > "Hello Yaakov, this is Refuah V'Chesed dispatch. Trip 1 2 4 7.
   > Pickup Côte-des-Neiges, at 2:30 this afternoon, going to the Jewish
   > General Hospital. Needs: walker.
   > Press 1 or say yes to take this trip. Press 2 or say no to pass.
   > Press 9 to hear it again."

   Uses `<Gather input="dtmf speech" numDigits="1" speechTimeout="auto"
   hints="yes,no,repeat">`. No names or addresses of the passenger beyond area
   and hospital are read out (same privacy rule as the SMS offer text).
4. The Gather result posts to `/webhooks/twilio/voice-offer/:deliveryId/answer`:
   - `1` / "yes": calls the same `claimTrip()` the SMS path uses with channel
     `voice`, verified by the called number matching the volunteer. Says
     "Confirmed, trip 1247 is yours. Details are coming by text." and the
     normal confirmation notification goes out.
   - Trip already taken: "Another volunteer took this trip first. Thank you."
   - `2` / "no": marks the offer declined.
   - `9` / "repeat": replays (max 2 repeats).
   - Nothing heard: repeats once, then "We'll send the details by text" and hangs up.
5. Voicemail / answering machine: leave a 10-second message ("Refuah V'Chesed
   has a trip for you, details by text") and treat as unanswered.

## Retry and fallback

- Unanswered, busy, failed or voicemail: one retry after 2 minutes (setting:
  `voice.retry_minutes`), then fall back to SMS with the normal offer text.
  The delivery row records `carried_by = 'sms'` and `fallback_reason`
  (reusing the columns added for WhatsApp).
- If the offer is accepted by someone else before the retry, the retry is
  cancelled (job checks offer status first).
- Urgent trips skip the retry and fall back to SMS immediately after the first
  failed call.

## Other events by voice

- Trip assigned / reassigned / cancelled for a `voice` volunteer: short call
  ("Trip 1247 has been cancelled. You don't need to go.") plus SMS always -
  critical events keep their SMS guarantee.
- Offer reminders: not by voice (too intrusive); reminders stay SMS/push.
- Shift reminders: optional, off by default.

## Logging and dispatcher view

- Each call is a delivery row (channel `voice`, provider `twilio`, Twilio
  CallSid, status from the call-status webhook: ringing, answered,
  no-answer, busy, failed, voicemail) plus the key pressed / speech heard.
- Trip timeline on the dispatcher board shows "Called Yaakov - no answer -
  texted instead" so dispatchers know exactly who heard what.

## Cost and limits

- Twilio outbound voice to Canadian numbers is billed per minute (check the
  current nonprofit rate before launch); a typical offer call is under 1 minute.
- Setting `voice.max_calls_per_offer_round` (default 10) caps how many people
  one broadcast can ring, so a big broadcast doesn't make dozens of calls at
  once. Voice volunteers beyond the cap get SMS.

## Build plan (after Twilio credentials exist)

1. `CallingProvider.placeAnnouncementCall()` in the Twilio adapter + memory
   double for tests (about 1h).
2. `voice` channel in notify/deliver, preference value, quiet hours (1-2h).
3. Voice webhooks: offer TwiML, answer handling via `claimTrip`, status
   callback, retry/fallback job (2-3h).
4. UI: preference option in profile and People, timeline entries (1h).
5. Tests: accept by keypress, accept by speech, taken-first, no-answer ->
   retry -> SMS, voicemail, signature rejection (1-2h).

Total about 6-9h. Can be built and tested fully with the in-memory provider
before Twilio is connected; going live needs the credentials and one real test
call to a volunteer's phone.

## Decisions needed

1. Languages for the spoken message (English only first, or also French /
   Yiddish recordings?).
2. Quiet hours for calls (proposed 22:00-07:00, urgent trips excepted).
3. Should voice be offered to every volunteer, or only switched on by a
   dispatcher for specific people?

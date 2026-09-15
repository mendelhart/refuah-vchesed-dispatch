# What this system does

Refuah V'Chesed is a Montreal charity. Volunteers drive patients to medical
appointments, lend out medical equipment, and bring meals to people in hospital.
This application is how that work is organised.

It is written for the people doing the work, not for developers. If you are here
to change the code, start with [ARCHITECTURE.md](ARCHITECTURE.md).

Three roles use it: **dispatchers**, who take the calls and find the drivers;
**volunteers**, who do the driving; and **administrators**, who look after the
roster, the messages the system sends, and the settings that govern it. An
administrator can do everything a dispatcher can.

---

## The core idea

Somebody rings. They need a ride to the Jewish General at two o'clock on
Thursday. The dispatcher writes that down as a **trip**, and then the trip needs
a volunteer.

There are two ways to find one.

**Broadcast it.** The system works out who should be asked, sends each of them a
message with their own private acceptance link, and the first person to accept
gets it. Everyone else is told immediately that it is gone — nobody drives to a
trip they did not get. If nobody answers within the window, the dispatchers are
warned before it runs out, and the trip goes back on the board rather than
quietly disappearing.

**Assign it.** The dispatcher rings somebody they know is free and assigns the
trip to them directly. That is recorded exactly the same way as an accepted
offer.

Everything else in the product exists to make one of those two things happen
faster, more fairly, or with fewer phone calls.

Every trip has a reference like `RVC-260914-0007` — the organisation's initials,
the date in Montreal, and a number. It is what everybody says out loud. It is not
a password: knowing a reference gets you nothing.

---

## What a dispatcher does in a day

### Taking a call

The dispatcher opens the board and creates a trip. If the caller has rung before,
typing part of their name or their phone number finds them, and the pickup
address, the entrance to use and where to park all come back with them — the
organisation does not re-interview somebody who calls three times a week for
dialysis.

A trip records:

- who is travelling and how to reach them, plus a **callback number** when the
  best number for this particular ride is a ward desk rather than the patient;
- where from and where to, with entrance and parking notes for each end;
- when to collect them, and separately when the appointment actually is;
- what they need — wheelchair, stretcher, walker, oxygen, someone to accompany
  them;
- anything else the driver should know, in plain words;
- which volunteer group it belongs to, and how urgent it is.

Urgency is not decoration. It decides how long volunteers have to answer:
half an hour for a routine ride, ten minutes for an urgent one, five for an
emergency. Use the word you mean. If everything is urgent, nothing is.

### Finding a driver

Pressing **Offer** does not text everybody. The system asks only the people who
could actually take this trip: members of that group, who have said they do this
kind of work, who can handle what the passenger needs, who are free at that hour
according to their own availability, who are not already on another trip around
that time, and who have not asked for quiet.

It also decides who to ask *first*: the standing ride's usual driver, then people
who have driven this passenger before, then whoever has been asked least
recently. That last one matters — without it the same six names carry the whole
roster and eventually stop answering.

If nobody qualifies, the system says why, in numbers: *"Nobody can be offered
this trip right now — 4 not available at this time; 2 already on another trip at
this time."* That is the answer to the question dispatchers used to have to
guess at.

The trip screen shows who was asked, who was passed over and for what reason,
and what each person has replied.

### While it is happening

The board updates itself. When a volunteer accepts, the row changes on every
open screen within a second or two — nobody refreshes anything.

A volunteer moves the trip along as they go: on the way, passenger aboard, done.
A dispatcher can do any of it on their behalf, which is what happens when
somebody rings in rather than tapping.

If a volunteer falls through, **Reassign** moves the trip to somebody else and
keeps the history. **Return to pending** puts it back on the board without
cancelling it. **Cancel** needs a reason, always, because in three weeks
somebody will ask why that ride did not happen.

Trips whose pickup time has passed and which are not finished are flagged as
overdue. That is the number to watch: it means somebody may be standing outside a
hospital.

### Calling people

A dispatcher can ring the passenger or the assigned volunteer from inside the
app, and a volunteer can ring the passenger for a trip currently assigned to
them. The system rings *you* first, then connects you. Neither side sees the
other's number, and nobody has to hand out their mobile. The call log shows who
called whom, when, for how long, and whether it connected.

### The message console

Volunteers and callers reply to the organisation's texts with real sentences: *I
can take it but I'll be ten minutes late.* *She isn't ready, can you push it an
hour.* *Wrong number, please stop texting me.*

Those arrive in **Messages** as conversations. Each has a status, an unread
count, and an owner — a dispatcher claims a conversation so two people do not
answer the same person. Replying sends a text back. A conversation can be pinned
to a trip so the exchange shows up beside the job.

Conversations are dispatcher-only. They contain callers talking about their own
medical appointments.

### The rest of the board

Beside the trips, a dispatcher sees who is on phone duty right now, how many
conversations are unread, how many volunteer applications are waiting, how many
pieces of equipment are overdue, today's Hebrew date, and the Shabbos and yom tov
boundaries for the coming week. That last one is not decoration either: a trip
offered at ten to seven on a Friday evening in December is an offer nobody can
accept.

---

## What a volunteer experiences

### Being asked

A text, a push notification, or both, depending on what they have chosen. It
says what kind of trip it is, roughly where from and where to, when, and what the
passenger needs. It carries a link that accepts the trip in one tap, and a short
code they can text back — `YES ABCDE-FGHJK` — if they would rather reply to the
message.

**It does not say who the passenger is, or exactly where they live.** Before
anyone has accepted, a volunteer sees the street and the city — "Avenue Bernard,
Montreal → Chemin de la Côte-Sainte-Catherine" — which is enough to judge the
journey. A broadcast goes to dozens of people and most of them will not take it;
they have no need to know that the person at number 1234 has dialysis on Thursday
and will not be home.

The code in the text belongs to that volunteer and that offer only. It cannot be
passed on, it stops working when somebody else accepts, and it expires with the
offer.

### Accepting

Whoever gets there first gets the trip, whether they tapped the link, opened the
app, or replied to the text. The others are told straight away that it has gone,
and thanked. There is no situation where two people believe they have the same
ride.

The moment they accept, the full details arrive: the passenger's name and number,
the exact address with the unit, the entrance, where to park, and the notes.

If the offer is not answered, a single reminder goes out partway through the
window, to the same people, with the same deadline. Not a second broadcast —
being texted twice about the same ride is how people start ignoring the texts.

### Doing the trip

The volunteer's screen shows today's work. They tap "on my way", "passenger
aboard" and "completed" as they go, and can ring the passenger through the app
without exchanging numbers. If something goes wrong, they can cancel their own
trip — with a reason — and it goes back to the dispatchers.

### Saying when they are free

A volunteer sets their own weekly availability in a grid, and can add dated
exceptions — away next week, free this Sunday evening even though Sundays are
usually off. They choose which kinds of work they do (rides, equipment delivery,
hospital food, phone duty, visits) and what they can handle physically
(wheelchair, stretcher, walker, oxygen, accompanying someone).

**A volunteer who has not set any availability is treated as always available.**
Nothing goes quiet because somebody has not filled in a form.

They can also snooze: quiet for the next few hours or days, from the app or by
texting `STOP 2H` or `STOP 1D`. A snooze stops *offers*. It does not stop being
told that a trip they already accepted has been cancelled — that is not the same
thing, and treating it as the same thing is how somebody drives to a hospital for
a passenger who is no longer there.

A plain `STOP` is the phone network's own opt-out. It is permanent, it cannot be
undone from inside this system, and the volunteer has to text `START` to their
carrier to undo it. That is exactly why the temporary version exists.

### Their own record

**My record** shows the trips they have driven, how many, since when, and what is
coming up. There are no leaderboards, no streaks and no badges. Ranking
volunteers against each other is the wrong incentive for this kind of work, and a
streak punishes the person who takes a month off.

**My ID card** is a badge to show at a hospital reception desk: name, volunteer
number, the organisation, and a QR code. Scanning it opens a page that says
whether the card is current — and nothing else. No phone number, no email, no
list of the trips they have driven.

**My licence** is where a volunteer uploads a photograph of their driving
licence. The app says plainly what happens next: it goes on file for an
administrator to look at. Nothing is verified automatically. See below.

---

## What an administrator manages

### People joining

Anyone can fill in the public signup form. What they submit is an **application**
— not an account. An applicant cannot log in, cannot be offered a trip, and does
not appear in any list of volunteers.

Applications arrive in a review queue. An administrator can ask for more
information, reject, or approve. **Approving is the moment a volunteer exists**:
in one step it creates the account, puts them in the groups and services they
asked for, applies the availability they gave, assigns their permanent volunteer
number, moves across any licence they uploaded, and sends them an invitation to
set a password. Rejecting or approving both notify the applicant.

Administrators can also create an account directly, which produces an invitation
link to pass on.

Removing somebody is **deactivate**, with a reason. It ends every session they
have open, frees their email and phone number for reuse, and leaves all of their
history intact — trips they drove still show their name. It refuses if they still
have live trips, and says how many: reassign those first. For a holiday or an
illness, do not deactivate. Either mark them inactive or let them snooze.

### Standing rides

Dialysis on Monday, Wednesday and Friday. Physiotherapy every second Tuesday.
These are a large share of the work, and re-entering them by hand dozens of times
a month is how mistakes happen.

A **standing ride** is set up once: the journey, the passenger, the days, the
time, how far ahead to offer it, and optionally the driver who usually does it. A
background job turns each occurrence into an ordinary trip a couple of weeks
ahead, and from then on it behaves exactly like any other trip on the board.

A ride that falls during Shabbos or yom tov is still created, so a dispatcher can
see it and decide — but it is not broadcast. The software does not rule on
whether such a ride may happen. It simply will not text forty people about it
without a person deciding first.

Ending a standing ride stops future occurrences, and offers to cancel the ones
already on the board.

### Equipment

Wheelchairs, walkers, hospital beds, crutches. Each item has a code and a
barcode; scanning or typing the code finds it. Lending records who has it, how to
reach them, and when it is due back. An item cannot be lent to two people.

Borrowers get a text a couple of days before an item is due, and a chase once a
week if it is late — weekly, not daily, because daily texts about a wheelchair
get a family to block the number, and then the wheelchair is gone for good.

### Phone duty

Somebody has to answer the organisation's line. The **duty roster** says who,
when. Two people cannot be booked onto the same kind of duty at the same time —
the system refuses and says who already has it — because two people believing
they are on the phone is the same failure as nobody being on it. Whoever is next
on gets a reminder an hour before their shift, and the board shows who is on
right now.

### Broadcasts

An announcement goes to a group of volunteers chosen by a filter: these groups,
these services, people who have done at least N trips, people free right now.

Bulk messaging is deliberately not a convenience. One click reaches everybody,
costs real money per message, and cannot be recalled. So the recipient count is
shown before anything is sent and **has to be confirmed**; if the roster changed
between drafting and sending, the send is refused and the new number is shown. A
broadcast that silently grew from forty people to five hundred because a filter
was wrong is not recoverable.

Snoozed volunteers are left out of broadcasts. A broadcast is by definition not
urgent enough to override somebody's evening.

### The words the system says

Every message — the offer text, the confirmation, the reminder, the application
acknowledgement, the equipment chase — is a template an administrator can edit,
with `{{placeholders}}` for the details. Editing one keeps the previous version,
so a change that breaks a message can be traced and put back.

### Exports

Trips, volunteers, the monthly board report, equipment loans, the audit log,
delivery failures. An export is requested, runs in the background, and is
downloaded as a spreadsheet. Every one of them is a file full of personal
information, so: the request is recorded, the file is stored encrypted, the
download is recorded separately, and the file deletes itself after a week.

### Settings

Dispatch policy is settings, not code. The offer windows, when escalation
happens, how many volunteers one round asks, how far ahead standing rides are
created, retention windows, the daily call limit, how long a session lasts. An
administrator changes these at runtime. Nobody deploys anything to make an offer
window longer during an outage.

### Seeing what happened

**Audit** is a searchable record of who did what: every trip transition, every
role change, every deactivation, every caller lookup, every licence image opened.
It cannot be edited or deleted by anybody, including an administrator, including
whoever holds the database password.

**Notifications** shows every message the system tried to send and what became of
it, including the ones that failed and why. "Did she get the offer?" is a screen,
not a guess.

---

## Driver's licences: read this before you rely on it

**This system does not check driver's licences.** It stores a photograph and a
number so a person can look at them, and it records that a person did.

There is no service that will tell software whether a Quebec licence is valid,
so the app does not pretend there is. The statuses mean exactly what they say:

- **Pending review** — uploaded, nobody has looked yet.
- **On file** — an administrator has looked at the image. *That is all it means.*
  It is not a statement that the licence is valid, current, or the licence of the
  person holding it.
- **Verified** — reserved for a real verification service, under contract, that
  has confirmed it and returned a reference. With no such service configured,
  nothing can ever reach this status.
- **Rejected** — an administrator said no.
- **Expired** — the expiry date recorded on it has passed. That is arithmetic,
  and the system is allowed to assert it.

Checking that a volunteer may legally drive remains a thing a human being does.
The organisation's vetting process is not replaced by this screen.

---

## Words you will hear

| Word | Means |
| --- | --- |
| **Trip** | One journey: a ride, an equipment delivery, or a hospital meal run |
| **Reference** | `RVC-260914-0007` — the trip's name. Not a password |
| **Group** | Chaim V'Chesed, Chesed on the Go, Misamchem. A trip belongs to one; volunteers may be in several |
| **Offer** | Asking one volunteer to take one trip. A durable record, not just a text message |
| **Round** | One broadcast. Re-broadcasting starts a new round and kills the old codes |
| **Claim** | A volunteer accepting an offer |
| **Escalation** | The warning to dispatchers that an offer is going unanswered, sent *before* it expires |
| **Expiry** | The offer window ran out with nobody accepting. The trip goes back to the dispatchers |
| **Snooze** | A volunteer asking for quiet for a while. Suppresses offers, never consequences |
| **Standing ride** | A repeating journey that turns itself into ordinary trips |
| **Caller** | The person who rings, and the person travelling |
| **Thread** | One SMS conversation with one phone number |
| **Application** | Somebody who has asked to volunteer and has not been approved yet |

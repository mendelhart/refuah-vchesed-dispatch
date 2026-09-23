import type { TemplateChannel, TemplateKey, TemplateLocale } from '@rvc/shared';

/**
 * The built-in message catalogue.
 *
 * These are the texts the organisation starts with and the fallback if a row is
 * ever deactivated. Administrators edit the database rows, not this file.
 *
 * Two rules the wording follows, learned from the legacy system's messages:
 *
 *  1. An SMS says what it is, what to do, and when it stops working — in that
 *     order, in the first two lines, because that is all a locked phone shows.
 *  2. A message never contains a caller's name, full address, or phone number
 *     before the trip is claimed. An offer goes to many people; everything in it
 *     has been seen by everyone who was asked.
 */

export interface TemplateDefinition {
  key: TemplateKey;
  channel: TemplateChannel;
  locale: TemplateLocale;
  subject?: string;
  body: string;
  description: string;
  variables: string[];
}

const OFFER_VARS = [
  'reference',
  'priorityTag',
  'fromArea',
  'toArea',
  'when',
  'needs',
  'acceptUrl',
  'smsCode',
  'expiresClock',
];

const TRIP_VARS = [
  'reference',
  'when',
  'fromArea',
  'toArea',
  'fullPickup',
  'fullDropoff',
  'callerName',
  'callbackNumber',
  'volunteerName',
  'appUrl',
  'notes',
];

export const DEFAULT_TEMPLATES: TemplateDefinition[] = [
  // ---- Dispatch: offers -----------------------------------------------------
  {
    key: 'trip.offered',
    channel: 'sms',
    locale: 'en',
    description: 'Sent to each targeted volunteer when a trip is broadcast.',
    variables: OFFER_VARS,
    body: `{{priorityTag}}Trip {{reference}}
{{fromArea}} → {{toArea}}
{{when}}
Needs: {{needs}}

Accept: {{acceptUrl}}
Or reply: YES {{smsCode}}
Expires {{expiresClock}}`,
  },
  {
    key: 'trip.offered',
    channel: 'whatsapp',
    locale: 'en',
    description: 'WhatsApp version of the offer.',
    variables: OFFER_VARS,
    body: `*{{priorityTag}}Trip {{reference}}*
{{fromArea}} → {{toArea}}
{{when}}
Needs: {{needs}}

Accept: {{acceptUrl}}
Or reply: YES {{smsCode}}
Expires {{expiresClock}}`,
  },
  {
    key: 'trip.offered',
    channel: 'push',
    locale: 'en',
    description: 'Push notification for an offer.',
    variables: OFFER_VARS,
    body: `{{fromArea}} → {{toArea}}, {{when}}. Tap to accept.`,
  },
  {
    key: 'trip.offer_reminder',
    channel: 'sms',
    locale: 'en',
    description: 'Sent partway through the offer window if nobody has answered.',
    variables: OFFER_VARS,
    body: `Still open: trip {{reference}}
{{fromArea}} → {{toArea}}, {{when}}
Accept: {{acceptUrl}}
Expires {{expiresClock}}`,
  },

  // ---- Dispatch: outcomes ---------------------------------------------------
  {
    key: 'trip.claimed',
    channel: 'sms',
    locale: 'en',
    description: 'Confirmation to the volunteer who won the claim. First message with full details.',
    variables: TRIP_VARS,
    body: `You have trip {{reference}}.
Pick up {{when}}
From: {{fullPickup}}
To: {{fullDropoff}}
Caller: {{callerName}} {{callbackNumber}}
Details: {{appUrl}}`,
  },
  {
    key: 'trip.claim_lost',
    channel: 'sms',
    locale: 'en',
    description: 'Sent to volunteers who answered a moment too late.',
    variables: ['reference', 'volunteerName'],
    body: `Trip {{reference}} was taken by someone else. Thank you for answering — you will get the next one.`,
  },
  {
    key: 'trip.assigned',
    channel: 'sms',
    locale: 'en',
    description: 'A coordinator assigned this trip directly.',
    variables: TRIP_VARS,
    body: `You have been assigned trip {{reference}}.
Pick up {{when}}
From: {{fullPickup}}
To: {{fullDropoff}}
Caller: {{callerName}} {{callbackNumber}}
Details: {{appUrl}}`,
  },
  {
    key: 'trip.reassigned',
    channel: 'sms',
    locale: 'en',
    description: 'Sent to the volunteer a trip was taken away from.',
    variables: ['reference', 'when', 'reason'],
    body: `Trip {{reference}} ({{when}}) has been reassigned and is no longer yours. {{reason}}`,
  },
  {
    key: 'trip.cancelled',
    channel: 'sms',
    locale: 'en',
    description: 'The trip will not happen.',
    variables: ['reference', 'when', 'reason'],
    body: `Trip {{reference}} on {{when}} is CANCELLED. {{reason}}
Please do not travel.`,
  },
  {
    key: 'trip.expired',
    channel: 'sms',
    locale: 'en',
    description: 'Offer window closed with no answer — informational, to the group.',
    variables: ['reference', 'when'],
    body: `Trip {{reference}} ({{when}}) is still unclaimed and has gone back to the dispatcher.`,
  },
  {
    key: 'trip.completed',
    channel: 'sms',
    locale: 'en',
    description: 'Thank-you after a completed trip.',
    variables: ['reference', 'volunteerName', 'tripCount'],
    body: `Thank you for trip {{reference}}. That is {{tripCount}} rides you have driven for Refuah V'Chesed.`,
  },
  {
    key: 'trip.escalated',
    channel: 'sms',
    locale: 'en',
    description: 'Sent to coordinators when an offer goes unanswered.',
    variables: ['reference', 'when', 'offered', 'minutes', 'appUrl'],
    body: `No answer on trip {{reference}} ({{when}}) after {{minutes}} min — {{offered}} asked.
{{appUrl}}`,
  },

  // ---- SMS conversation -----------------------------------------------------
  {
    key: 'sms.accept_confirmed',
    channel: 'sms',
    locale: 'en',
    description: 'Reply to a successful YES.',
    variables: TRIP_VARS,
    body: `Confirmed — trip {{reference}} is yours.
Pick up {{when}}
From: {{fullPickup}}
To: {{fullDropoff}}
Caller: {{callerName}} {{callbackNumber}}`,
  },
  {
    key: 'sms.accept_too_late',
    channel: 'sms',
    locale: 'en',
    description: 'Reply when the offer was already taken or has expired.',
    variables: ['reference'],
    body: `That trip has already been taken. Thank you for answering.`,
  },
  {
    key: 'sms.accept_invalid',
    channel: 'sms',
    locale: 'en',
    description: 'Reply to a missing, unrecognised or non-matching code.',
    variables: [],
    body: `We could not match that to an open offer. Reply YES followed by the code in your trip message, or use the link in it.`,
  },
  {
    key: 'sms.decline_confirmed',
    channel: 'sms',
    locale: 'en',
    description: 'Reply to NO / PASS.',
    variables: ['reference'],
    body: `Thank you — noted. We will not count on you for trip {{reference}}.`,
  },
  {
    key: 'sms.help',
    channel: 'sms',
    locale: 'en',
    description: 'Reply to HELP.',
    variables: ['orgPhone'],
    body: `Refuah V'Chesed dispatch.
YES <code> — accept a trip
NO <code> — decline
STOP 2H / STOP 1D — pause offers
Anything else reaches a dispatcher. Urgent: {{orgPhone}}`,
  },
  {
    key: 'sms.unknown_sender',
    channel: 'sms',
    locale: 'en',
    description: 'Reply to a number we do not recognise. Deliberately says nothing about anyone.',
    variables: [],
    body: `Thank you for your message. Somebody will read it shortly.`,
  },
  {
    key: 'sms.muted',
    channel: 'sms',
    locale: 'en',
    description: 'Confirmation that offers are paused.',
    variables: ['untilClock'],
    body: `Offers paused until {{untilClock}}. Trips you have already accepted will still reach you. Reply START to resume.`,
  },

  // ---- Volunteer lifecycle --------------------------------------------------
  {
    key: 'volunteer.application_received',
    channel: 'email',
    locale: 'en',
    subject: `We received your application — Refuah V'Chesed`,
    description: 'Auto-reply to a submitted signup form.',
    variables: ['fullName', 'reference', 'orgName'],
    body: `Hello {{fullName}},

Thank you for offering to volunteer with {{orgName}}. We have your application — reference {{reference}} — and somebody will review it and get back to you.

If anything changes, reply to this email and mention your reference.

{{orgName}}`,
  },
  {
    key: 'volunteer.application_received',
    channel: 'sms',
    locale: 'en',
    description: 'Short confirmation by text.',
    variables: ['fullName', 'reference', 'orgName'],
    body: `Thank you {{fullName}} — {{orgName}} has your volunteer application ({{reference}}). We will be in touch.`,
  },
  {
    key: 'volunteer.application_approved',
    channel: 'email',
    locale: 'en',
    subject: `Welcome to Refuah V'Chesed`,
    description: 'Application approved; carries the invitation link.',
    variables: ['fullName', 'inviteUrl', 'orgName', 'expiresIn'],
    body: `Hello {{fullName}},

Your application has been approved. Set your password and finish your profile here:

{{inviteUrl}}

The link works for {{expiresIn}}. Once you are in, tell us when you are available and which kinds of help you want to be asked about — that is what decides which requests reach you.

{{orgName}}`,
  },
  {
    key: 'volunteer.application_approved',
    channel: 'sms',
    locale: 'en',
    description: 'Approval by text with the invitation link.',
    variables: ['fullName', 'inviteUrl', 'orgName'],
    body: `{{fullName}}, your {{orgName}} volunteer application is approved. Set your password: {{inviteUrl}}`,
  },
  {
    key: 'volunteer.application_rejected',
    channel: 'email',
    locale: 'en',
    subject: `About your application — Refuah V'Chesed`,
    description: 'Application declined. Kept short and without a reason by default.',
    variables: ['fullName', 'orgName', 'message'],
    body: `Hello {{fullName}},

Thank you for offering to help. We are not able to take your application forward at this time.

{{message}}

We are grateful you asked.

{{orgName}}`,
  },
  {
    key: 'volunteer.application_info_requested',
    channel: 'email',
    locale: 'en',
    subject: `One more thing about your application — Refuah V'Chesed`,
    description: 'Reviewer needs something before deciding.',
    variables: ['fullName', 'message', 'resumeUrl', 'orgName'],
    body: `Hello {{fullName}},

Before we can finish reviewing your application we need one thing:

{{message}}

You can add it here: {{resumeUrl}}

{{orgName}}`,
  },
  {
    key: 'volunteer.invitation',
    channel: 'email',
    locale: 'en',
    subject: `Your Refuah V'Chesed account`,
    description: 'Administrator created an account directly.',
    variables: ['fullName', 'inviteUrl', 'orgName', 'expiresIn'],
    body: `Hello {{fullName}},

An account has been created for you at {{orgName}}. Set your password here:

{{inviteUrl}}

The link works for {{expiresIn}}.

{{orgName}}`,
  },
  {
    key: 'volunteer.password_reset',
    channel: 'email',
    locale: 'en',
    subject: `Reset your Refuah V'Chesed password`,
    description: 'Password reset link.',
    variables: ['fullName', 'resetUrl', 'expiresIn', 'orgName'],
    body: `Hello {{fullName}},

Use this link to set a new password:

{{resetUrl}}

It works for {{expiresIn}}. If you did not ask for this, you can ignore it — nothing has changed.

{{orgName}}`,
  },
  {
    key: 'volunteer.welcome',
    channel: 'email',
    locale: 'en',
    subject: `You are set up — Refuah V'Chesed`,
    description: 'Sent after a volunteer sets their password.',
    variables: ['fullName', 'appUrl', 'orgName'],
    body: `Hello {{fullName}},

You are all set. Two things worth doing now:

1. Open {{appUrl}} on your phone and add it to your home screen, so offers arrive as notifications instead of only as texts.
2. Set your availability and the kinds of help you want to be asked about.

{{orgName}}`,
  },

  // ---- Administration -------------------------------------------------------
  {
    key: 'admin.application_submitted',
    channel: 'email',
    locale: 'en',
    subject: `New volunteer application — {{fullName}}`,
    description: 'Tells administrators an application is waiting.',
    variables: ['fullName', 'reference', 'phone', 'services', 'reviewUrl'],
    body: `{{fullName}} applied to volunteer.

Reference: {{reference}}
Phone: {{phone}}
Interested in: {{services}}

Review: {{reviewUrl}}`,
  },
  {
    key: 'admin.delivery_failures',
    channel: 'email',
    locale: 'en',
    subject: `Message delivery failures — Refuah V'Chesed`,
    description: 'Daily digest when notifications could not be delivered.',
    variables: ['failed', 'window', 'dashboardUrl'],
    body: `{{failed}} notifications failed to deliver in the last {{window}}.

{{dashboardUrl}}

A failed offer means a volunteer was never asked.`,
  },
  {
    key: 'admin.export_ready',
    channel: 'email',
    locale: 'en',
    subject: `Your export is ready`,
    description: 'An export finished and can be downloaded.',
    variables: ['kind', 'rowCount', 'downloadUrl', 'expiresIn'],
    body: `Your {{kind}} export is ready — {{rowCount}} rows.

{{downloadUrl}}

The download expires in {{expiresIn}}. It contains personal information; please handle it accordingly.`,
  },

  // ---- Equipment ------------------------------------------------------------
  {
    key: 'equipment.loan_confirmed',
    channel: 'sms',
    locale: 'en',
    description: 'Confirms an item was lent out.',
    variables: ['itemName', 'borrowerName', 'dueDate', 'orgName'],
    body: `{{borrowerName}}: {{orgName}} has lent you a {{itemName}}. Please return it by {{dueDate}}. Refuah shleima.`,
  },
  {
    key: 'equipment.due_reminder',
    channel: 'sms',
    locale: 'en',
    description: 'Sent a few days before an item is due back.',
    variables: ['itemName', 'borrowerName', 'dueDate', 'orgPhone'],
    body: `Reminder: the {{itemName}} is due back on {{dueDate}}. If you still need it, call {{orgPhone}} — we can extend it.`,
  },
  {
    key: 'equipment.overdue',
    channel: 'sms',
    locale: 'en',
    description: 'Sent when an item is past its due date.',
    variables: ['itemName', 'borrowerName', 'dueDate', 'daysOverdue', 'orgPhone'],
    body: `The {{itemName}} was due back on {{dueDate}} ({{daysOverdue}} days ago). Somebody else is waiting for it. Please call {{orgPhone}}.`,
  },
  {
    key: 'equipment.returned',
    channel: 'sms',
    locale: 'en',
    description: 'Acknowledges a return.',
    variables: ['itemName', 'borrowerName', 'orgName'],
    body: `Thank you — {{orgName}} has the {{itemName}} back.`,
  },

  // ---- Announcements and duty ----------------------------------------------
  {
    key: 'announcement.broadcast',
    channel: 'sms',
    locale: 'en',
    description: 'Wrapper for an administrator broadcast.',
    variables: ['title', 'message', 'orgName'],
    body: `{{orgName}}: {{title}}
{{message}}`,
  },
  {
    key: 'announcement.broadcast',
    channel: 'email',
    locale: 'en',
    subject: `{{title}}`,
    description: 'Email version of a broadcast.',
    variables: ['title', 'message', 'orgName'],
    body: `{{message}}

{{orgName}}`,
  },
  {
    key: 'duty.shift_reminder',
    channel: 'sms',
    locale: 'en',
    description: 'Reminds whoever is next on the phone roster.',
    variables: ['startClock', 'endClock', 'kind', 'orgPhone'],
    body: `Reminder: you are on {{kind}} duty from {{startClock}} to {{endClock}}. Calls to {{orgPhone}} will reach you.`,
  },
];

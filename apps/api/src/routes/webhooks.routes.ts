import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, isNull, sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calls, organizationInfo, smsEvents, tripOffers, trips, users } from '../db/schema.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from '../lib/phone.js';
import { hashToken } from '../lib/crypto.js';
import { normalizeOfferCode } from '../lib/offer-code.js';
import { claimTrip } from '../domain/dispatch.service.js';
import { recordSmsStatusCallback } from '../services/notification.service.js';
import { recordInbound } from '../domain/conversations.service.js';
import { renderTemplate } from '../services/templates.service.js';
import { formatClock } from '../lib/time.js';
import { callingProvider, smsProvider, twimlDial, twimlError } from '../services/providers/index.js';
import { smsProvider as sms } from '../services/providers/index.js';
import type { AuthenticatedUser } from '../auth/session.js';

/**
 * Twilio webhooks.
 *
 * Rules that apply to every route in this file:
 *
 *  1. The signature is validated before anything in the body is read or
 *     trusted. An unsigned request is recorded and rejected — it is never
 *     allowed to change state.
 *  2. The sending phone number is evidence of identity, not proof of
 *     authorisation. Acceptance additionally requires the volunteer's own
 *     single-use offer code.
 *  3. Every inbound message is written to `sms_events` whatever the outcome,
 *     including rejected ones, so abuse is visible.
 */

function publicUrl(req: FastifyRequest): string {
  // Twilio signs the URL it called, including query string.
  return `${env.API_PUBLIC_URL}${req.raw.url ?? req.url}`;
}

function formParams(req: FastifyRequest): Record<string, string> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) out[k] = typeof v === 'string' ? v : String(v ?? '');
  return out;
}

function signatureOf(req: FastifyRequest): string | undefined {
  const header = req.headers['x-twilio-signature'];
  return Array.isArray(header) ? header[0] : header;
}

/** The system identity used when a webhook acts on a volunteer's behalf. */
const WEBHOOK_ACTOR: AuthenticatedUser = {
  id: '00000000-0000-0000-0000-000000000000',
  sessionId: 'webhook',
  email: 'system@refuahvchesed',
  fullName: 'SMS gateway',
  role: 'admin',
  status: 'active',
  phone: null,
  groups: [],
  notificationPreference: 'none',
  mustChangePassword: false,
};

const HELP_TEXT =
  "Refuah V'Chesed: reply YES followed by the code in your trip message to accept, " +
  'or NO to decline. Open the app for full details.';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Inbound SMS
  // -------------------------------------------------------------------------
  app.post('/webhooks/twilio/sms', async (req, reply) => {
    const params = formParams(req);
    const valid = smsProvider.validateWebhookSignature({
      signature: signatureOf(req),
      url: publicUrl(req),
      params,
    });

    if (!valid) {
      logger.warn({ ip: req.ip }, 'rejected unsigned Twilio SMS webhook');
      await db
        .insert(smsEvents)
        .values({
          direction: 'inbound',
          fromNumber: params.From ?? null,
          toNumber: params.To ?? null,
          body: (params.Body ?? '').slice(0, 500),
          providerSid: params.MessageSid ?? null,
          signatureValid: false,
          outcome: 'rejected_signature',
          detail: `from ip ${req.ip}`,
        })
        .onConflictDoNothing();
      // 403 and no TwiML: a forged request gets nothing back, and in particular
      // never causes us to send an SMS to an attacker-chosen number.
      return reply.status(403).type('text/plain').send('invalid signature');
    }

    const from = normalizePhone(params.From ?? '');
    const body = (params.Body ?? '').trim();
    const sid = params.MessageSid ?? null;

    // Twilio retries on timeout; the unique index on provider_sid makes this
    // idempotent so a redelivery cannot accept a second trip.
    if (sid) {
      const [seen] = await db
        .select({ id: smsEvents.id })
        .from(smsEvents)
        .where(eq(smsEvents.providerSid, sid))
        .limit(1);
      if (seen) return reply.type('text/xml').send('<Response/>');
    }

    const reply2 = (text: string) =>
      reply.type('text/xml').send(`<Response><Message>${escapeXml(text)}</Message></Response>`);

    const record = async (
      outcome: string,
      detail: string,
      matchedUserId?: string | null,
      matchedOfferId?: string | null,
    ) => {
      await db
        .insert(smsEvents)
        .values({
          direction: 'inbound',
          fromNumber: from,
          toNumber: params.To ?? null,
          body: body.slice(0, 500),
          providerSid: sid,
          signatureValid: true,
          matchedUserId: matchedUserId ?? null,
          matchedOfferId: matchedOfferId ?? null,
          outcome,
          detail,
        })
        .onConflictDoNothing();
    };

    if (!from) {
      await record('unmatched', 'unparseable sender');
      return reply.type('text/xml').send('<Response/>');
    }

    // Exact E.164 match on a live user. No "last ten digits" fuzzy matching.
    const [sender] = await db
      .select({ id: users.id, fullName: users.fullName, status: users.status })
      .from(users)
      .where(and(eq(users.phone, from), isNull(users.deletedAt)))
      .limit(1);

    const upper = body.toUpperCase();
    const isAccept = /^(YES|Y|ACCEPT|OK)\b/.test(upper);
    const isDecline = /^(NO|N|DECLINE|PASS)\b/.test(upper);
    const isHelp = /^(HELP|INFO)$/.test(upper);
    const isResume = /^(START|RESUME|UNSTOP)$/.test(upper);

    /**
     * STOP, optionally with a duration.
     *
     * Carrier-level STOP is permanent and irreversible from our side, which is
     * why volunteers in the reference product were inventing "#Mute" to get a
     * temporary pause. Offering `STOP 2H` / `STOP 1D` gives them the thing they
     * actually want — quiet this evening — without losing the channel forever.
     * A bare STOP still hands off to the carrier's own opt-out.
     */
    const stopMatch = /^(STOP|UNSUBSCRIBE|CANCEL|END|QUIT|MUTE|SNOOZE)(?:\s+(\d{1,2})\s*([HD]))?$/.exec(upper);
    if (stopMatch) {
      const amount = stopMatch[2] ? Number(stopMatch[2]) : null;
      const unit = stopMatch[3];
      if (sender && amount && unit) {
        const until = new Date(Date.now() + amount * (unit === 'H' ? 3_600_000 : 86_400_000));
        await db.update(users).set({ mutedUntil: until }).where(eq(users.id, sender.id));
        await record('snoozed', `muted until ${until.toISOString()}`, sender.id);
        const msg = await renderTemplate('sms.muted', 'sms', { untilClock: formatClock(until) });
        return reply2(msg.body);
      }
      // Bare STOP: the carrier stops delivery whatever we do, so record it and
      // stop targeting this number rather than pretending it still works.
      await record('opt_out', 'STOP keyword', sender?.id);
      if (sender) {
        await db
          .update(users)
          .set({ notificationPreference: 'push' })
          .where(eq(users.id, sender.id));
      }
      return reply.type('text/xml').send('<Response/>');
    }

    if (isResume && sender) {
      await db.update(users).set({ mutedUntil: null }).where(eq(users.id, sender.id));
      await record('resumed', 'START keyword', sender.id);
      return reply2('Offers resumed. Thank you.');
    }

    if (!sender || sender.status !== 'active') {
      // An unrecognised number still gets a conversation: it may be a caller
      // replying about their own ride, or somebody who needs help and has this
      // number. Throwing it away is how the legacy system lost those.
      await record('unmatched', 'no active user for this number');
      await recordInbound(from, body, { providerSid: sid });
      const msg = await renderTemplate('sms.unknown_sender', 'sms', {});
      return reply2(msg.body);
    }

    if (isHelp) {
      await record('help', 'HELP keyword', sender.id);
      const [org] = await db.select().from(organizationInfo).limit(1);
      const msg = await renderTemplate('sms.help', 'sms', { orgPhone: org?.phone ?? '' });
      return reply2(msg.body);
    }

    const code = normalizeOfferCode(upper.replace(/^(YES|Y|ACCEPT|OK|NO|N|DECLINE|PASS)\s*/, ''));

    if (isDecline) {
      if (!code) {
        await record('declined_no_code', 'decline without code', sender.id);
        return reply2('To decline a specific trip, reply NO followed by the code from the message.');
      }
      const declined = await db
        .update(tripOffers)
        .set({ status: 'declined', respondedAt: new Date(), responseChannel: 'sms' })
        .where(
          and(
            eq(tripOffers.tokenHash, hashToken(code)),
            eq(tripOffers.volunteerId, sender.id),
            eq(tripOffers.status, 'pending'),
          ),
        )
        .returning({ id: tripOffers.id, tripId: tripOffers.tripId });
      if (declined.length === 0) {
        await record('declined_unknown', 'no matching pending offer', sender.id);
        const msg = await renderTemplate('sms.accept_too_late', 'sms', {});
        return reply2(msg.body);
      }
      await record('declined', 'offer declined', sender.id, declined[0]!.id);
      const [declinedTrip] = await db
        .select({ reference: trips.reference })
        .from(trips)
        .where(eq(trips.id, declined[0]!.tripId))
        .limit(1);
      const msg = await renderTemplate('sms.decline_confirmed', 'sms', {
        reference: declinedTrip?.reference ?? '',
      });
      return reply2(msg.body);
    }

    if (!isAccept) {
      /**
       * Not a command — so it is a person talking.
       *
       * "I can take it but I'll be 10 minutes late", "she isn't ready", "wrong
       * number". The legacy system replied with a help message and dropped the
       * text. Here it lands on a conversation thread that a dispatcher owns and
       * can answer, and the volunteer gets an acknowledgement that a human will
       * read it — not an automated instruction they did not ask for.
       */
      const { threadId } = await recordInbound(from, body, { providerSid: sid });
      await record('conversation', `message on thread ${threadId}`, sender.id);
      return reply.type('text/xml').send('<Response/>');
    }

    if (!code) {
      await record('accept_no_code', 'accept without code', sender.id);
      // A bare "YES" is ambiguous when somebody holds two offers, and guessing
      // is how a volunteer ends up committed to a trip they did not mean. Ask.
      const msg = await renderTemplate('sms.accept_invalid', 'sms', {});
      return reply2(msg.body);
    }

    const outcome = await claimTrip(
      {
        user: { ...WEBHOOK_ACTOR, id: sender.id, fullName: sender.fullName, role: 'volunteer' },
        audit: { userId: sender.id, name: sender.fullName, role: 'volunteer', ip: req.ip, requestId: req.id },
      },
      { code, channel: 'sms', verifiedPhone: from },
    );

    if (outcome.ok) {
      await record('accepted', `claimed ${outcome.reference}`, sender.id);
      // The confirmation with full trip detail is sent by the dispatch engine
      // as a notification; this reply is just the immediate acknowledgement.
      return reply2(`Confirmed — trip ${outcome.reference} is yours. Details are on the way.`);
    }

    const messages: Record<string, string> = {
      already_taken: 'Another volunteer accepted that trip first. Thank you for responding.',
      expired: 'That offer has expired.',
      not_your_offer: 'That code is not valid for this number.',
      unknown_code: 'That code is not recognised.',
      not_offered: 'That trip is no longer available.',
    };
    await record(`rejected_${outcome.reason}`, outcome.reason ?? 'unknown', sender.id);
    return reply2(messages[outcome.reason ?? ''] ?? 'That trip is no longer available.');
  });

  // -------------------------------------------------------------------------
  // SMS delivery status
  // -------------------------------------------------------------------------
  app.post('/webhooks/twilio/sms-status', async (req, reply) => {
    const params = formParams(req);
    if (
      !smsProvider.validateWebhookSignature({
        signature: signatureOf(req),
        url: publicUrl(req),
        params,
      })
    ) {
      return reply.status(403).send('invalid signature');
    }
    if (params.MessageSid && params.MessageStatus) {
      await recordSmsStatusCallback(params.MessageSid, params.MessageStatus, params.ErrorMessage);
    }
    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // Voice: the TwiML that bridges a masked call
  // -------------------------------------------------------------------------
  app.post('/webhooks/twilio/voice/:callId', async (req, reply) => {
    const params = formParams(req);
    if (
      !callingProvider.validateWebhookSignature({
        signature: signatureOf(req),
        url: publicUrl(req),
        params,
      })
    ) {
      logger.warn({ ip: req.ip }, 'rejected unsigned Twilio voice webhook');
      return reply.status(403).send('invalid signature');
    }

    const { callId } = req.params as { callId: string };
    const [call] = await db
      .select({ id: calls.id, status: calls.status })
      .from(calls)
      .where(eq(calls.id, callId))
      .limit(1);

    // The destination is resolved from the call record, never from a query
    // parameter — the legacy implementation dialled whatever the URL said.
    const destination = await resolveCallDestination(callId);
    if (!call || !destination) {
      logger.error({ callId }, 'voice webhook for unknown call');
      return reply.type('text/xml').send(twimlError());
    }

    await db.update(calls).set({ status: 'in_progress' }).where(eq(calls.id, callId));
    return reply.type('text/xml').send(twimlDial(destination));
  });

  app.post('/webhooks/twilio/call-status', async (req, reply) => {
    const params = formParams(req);
    if (
      !callingProvider.validateWebhookSignature({
        signature: signatureOf(req),
        url: publicUrl(req),
        params,
      })
    ) {
      return reply.status(403).send('invalid signature');
    }
    const sid = params.CallSid;
    const status = params.CallStatus;
    if (!sid || !status) return reply.status(204).send();

    const map: Record<string, string> = {
      completed: 'completed',
      failed: 'failed',
      busy: 'failed',
      canceled: 'failed',
      'no-answer': 'no_answer',
      ringing: 'ringing',
      'in-progress': 'in_progress',
    };
    const mapped = map[status] ?? status;
    await db
      .update(calls)
      .set({
        status: mapped,
        durationSeconds: params.CallDuration ? Number(params.CallDuration) : null,
        endedAt: ['completed', 'failed', 'no_answer'].includes(mapped) ? new Date() : null,
      })
      .where(eq(calls.providerSid, sid));
    return reply.status(204).send();
  });
}

/** Looks the destination up from the call row written when the call was authorised. */
async function resolveCallDestination(callId: string): Promise<string | null> {
  const rows = (await db.execute(raw`
    select coalesce(
      (select phone from users u where u.id = c.counterparty_user_id),
      (select t.caller_phone from trips t where t.id = c.trip_id and c.counterparty_type = 'caller'),
      (select ct.phone from contacts ct where ct.id = c.contact_id)
    ) as destination
    from calls c where c.id = ${callId}
  `)) as unknown as Array<{ destination: string | null }>;
  return rows[0]?.destination ?? null;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export { sms };

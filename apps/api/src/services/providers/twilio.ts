import twilio from 'twilio';
import type { CallingProvider, PlacedCall, SmsProvider, SmsSendResult } from './types.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';

const configured = Boolean(
  env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER,
);

const client = configured
  ? twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!)
  : null;

function fromNumber(): string {
  const n = (env.TWILIO_PHONE_NUMBER ?? '').trim();
  return n.startsWith('+') ? n : `+${n}`;
}

/**
 * Signature validation.
 *
 * Every Twilio webhook goes through this before anything else is read. The
 * legacy app validated nothing, which meant a forged POST could accept a trip
 * as any volunteer. `TWILIO_SKIP_SIGNATURE_VALIDATION` exists for local
 * development only and the config loader refuses it in production.
 */
function validate(args: {
  signature: string | undefined;
  url: string;
  params: Record<string, string>;
}): boolean {
  if (env.TWILIO_SKIP_SIGNATURE_VALIDATION) {
    logger.warn('twilio signature validation skipped (non-production only)');
    return true;
  }
  if (!env.TWILIO_AUTH_TOKEN || !args.signature) return false;
  try {
    return twilio.validateRequest(env.TWILIO_AUTH_TOKEN, args.signature, args.url, args.params);
  } catch (err) {
    logger.error({ err }, 'twilio signature validation threw');
    return false;
  }
}

export const twilioSmsProvider: SmsProvider = {
  name: 'twilio',
  enabled: configured,
  async send(to: string, body: string): Promise<SmsSendResult> {
    if (!client) throw new Error('Twilio is not configured');
    const message = await client.messages.create({ to, from: fromNumber(), body });
    return { providerMessageId: message.sid, provider: 'twilio' };
  },
  validateWebhookSignature: validate,
};

export const twilioCallingProvider: CallingProvider = {
  name: 'twilio',
  enabled: configured,
  async connect({ initiatorNumber, destinationNumber, callId }): Promise<PlacedCall> {
    if (!client) throw new Error('Twilio is not configured');
    // Ring the person who asked for the call first; when they answer, the TwiML
    // returned by /webhooks/twilio/voice/:callId dials the destination with the
    // organisation's number as the caller ID. Neither side sees the other's number.
    const call = await client.calls.create({
      to: initiatorNumber,
      from: fromNumber(),
      url: `${env.API_PUBLIC_URL}/webhooks/twilio/voice/${callId}`,
      method: 'POST',
      statusCallback: `${env.API_PUBLIC_URL}/webhooks/twilio/call-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 30,
    });
    void destinationNumber;
    return { providerCallId: call.sid, provider: 'twilio', status: call.status };
  },
  async announce({ to, deliveryId }): Promise<PlacedCall> {
    if (!client) throw new Error('Twilio is not configured');
    if (!env.API_PUBLIC_URL) throw new Error('API_PUBLIC_URL is not set; Twilio cannot reach the voice webhook');
    const base = `${env.API_PUBLIC_URL}/webhooks/twilio/voice-notify/${deliveryId}`;
    const call = await client.calls.create({
      to,
      from: fromNumber(),
      url: base,
      method: 'POST',
      // Tells a person from an answering machine, so a voicemail greeting
      // is not mistaken for someone listening.
      machineDetection: 'Enable',
      statusCallback: `${base}/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed'],
      timeout: 30,
    });
    return { providerCallId: call.sid, provider: 'twilio', status: call.status };
  },
  validateWebhookSignature: validate,
};

export function twimlDial(destination: string): string {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'alice', language: 'en-US' },
    "Connecting you through Refuah V'Chesed. Please hold.",
  );
  twiml.dial({ callerId: fromNumber(), timeout: 30 }, destination);
  return twiml.toString();
}

export function twimlError(message = 'We could not connect this call. Please try again later.'): string {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', language: 'en-US' }, message);
  twiml.hangup();
  return twiml.toString();
}

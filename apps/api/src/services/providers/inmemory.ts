/** Test and local-development doubles. Used automatically whenever the real
 *  provider is not configured, so the app is fully exercisable without vendor
 *  accounts — including in CI. */
import type {
  CallingProvider, PlacedCall, PushProvider, SmsProvider, SmsSendResult,
} from './types.js';

export interface CapturedSms { to: string; body: string; at: Date }
export interface CapturedPush { endpoint: string; title: string; body: string; at: Date }
export interface CapturedCall { initiator: string; destination: string; callId: string; at: Date }

export const captured = {
  sms: [] as CapturedSms[],
  push: [] as CapturedPush[],
  calls: [] as CapturedCall[],
  announcements: [] as Array<{ to: string; deliveryId: string; at: Date }>,
  reset() { this.sms = []; this.push = []; this.calls = []; this.announcements = []; },
};

/** Set to a number to make the next N sends fail — used by the retry tests. */
export const faults = { smsFailures: 0, pushFailures: 0 };

let counter = 0;
// Include per-process entropy: a restarted process previously restarted the
// counter at 1 and collided with provider ids already stored in the database.
const runId = Math.random().toString(36).slice(2, 8).toUpperCase();
const nextId = (prefix: string) => `${prefix}${runId}${(++counter).toString().padStart(6, '0')}`;

export const memorySmsProvider: SmsProvider = {
  name: 'memory',
  enabled: true,
  async send(to, body): Promise<SmsSendResult> {
    if (faults.smsFailures > 0) { faults.smsFailures -= 1; throw new Error('simulated SMS failure'); }
    captured.sms.push({ to, body, at: new Date() });
    return { providerMessageId: nextId('SM'), provider: 'memory' };
  },
  validateWebhookSignature: () => true,
};

export const memoryPushProvider: PushProvider = {
  name: 'memory',
  enabled: true,
  async send(target, payload) {
    if (faults.pushFailures > 0) { faults.pushFailures -= 1; throw new Error('simulated push failure'); }
    captured.push.push({ endpoint: target.endpoint, title: payload.title, body: payload.body, at: new Date() });
    return { provider: 'memory', providerMessageId: nextId('PU') };
  },
};

export const memoryCallingProvider: CallingProvider = {
  name: 'memory',
  enabled: true,
  async connect({ initiatorNumber, destinationNumber, callId }): Promise<PlacedCall> {
    captured.calls.push({ initiator: initiatorNumber, destination: destinationNumber, callId, at: new Date() });
    return { providerCallId: nextId('CA'), provider: 'memory', status: 'queued' };
  },
  async announce({ to, deliveryId }): Promise<PlacedCall> {
    captured.announcements.push({ to, deliveryId, at: new Date() });
    return { providerCallId: nextId('CA'), provider: 'memory', status: 'queued' };
  },
  validateWebhookSignature: () => true,
};

// ---------------------------------------------------------------------------
// Doubles for the channels added in the production build.
// ---------------------------------------------------------------------------

import type {
  EmailMessage, EmailProvider, EmailSendResult, ObjectStore,
  WhatsAppProvider, WhatsAppSendResult,
} from './types.js';

export interface CapturedEmail { to: string; subject: string; text: string; at: Date }
export interface CapturedWhatsApp { to: string; body: string; at: Date }

export const capturedExtra = {
  email: [] as CapturedEmail[],
  whatsapp: [] as CapturedWhatsApp[],
  reset() { this.email = []; this.whatsapp = []; },
};

export const extraFaults = { emailFailures: 0, whatsappFailures: 0 };

export const memoryEmailProvider: EmailProvider = {
  name: 'memory',
  enabled: true,
  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (extraFaults.emailFailures > 0) {
      extraFaults.emailFailures -= 1;
      throw new Error('simulated email failure');
    }
    capturedExtra.email.push({ to: message.to, subject: message.subject, text: message.text, at: new Date() });
    return { provider: 'memory', providerMessageId: nextId('EM') };
  },
};

export const memoryWhatsAppProvider: WhatsAppProvider = {
  name: 'memory',
  enabled: true,
  async send(to, body): Promise<WhatsAppSendResult> {
    if (extraFaults.whatsappFailures > 0) {
      extraFaults.whatsappFailures -= 1;
      throw new Error('simulated WhatsApp failure');
    }
    capturedExtra.whatsapp.push({ to, body, at: new Date() });
    return { provider: 'memory', providerMessageId: nextId('WA') };
  },
  async health() {
    return { ok: true, detail: 'memory' };
  },
};

/** In-memory object store, so file upload paths are testable without a disk. */
const blobs = new Map<string, Buffer>();

export const memoryObjectStore: ObjectStore = {
  name: 'memory',
  async put(key, body) { blobs.set(key, Buffer.from(body)); },
  async get(key) {
    const b = blobs.get(key);
    if (!b) throw new Error(`No object at ${key}`);
    return b;
  },
  async delete(key) { blobs.delete(key); },
  async exists(key) { return blobs.has(key); },
};

export function resetMemoryObjectStore(): void { blobs.clear(); }

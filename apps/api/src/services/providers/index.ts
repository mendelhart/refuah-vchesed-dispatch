import { env, isTest } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { twilioCallingProvider, twilioSmsProvider } from './twilio.js';
import { webPushProvider } from './webpush.js';
import { nominatimProvider } from './nominatim.js';
import {
  memoryCallingProvider,
  memoryEmailProvider,
  memoryObjectStore,
  memoryPushProvider,
  memorySmsProvider,
  memoryWhatsAppProvider,
} from './inmemory.js';
import { smtpEmailProvider } from './email.js';
import { wahaWhatsAppProvider } from './waha.js';
import { dbObjectStore, localObjectStore, s3ObjectStore } from './objectstore.js';
import {
  httpLicenceVerificationProvider,
  nullLicenceVerificationProvider,
} from './licence-verification.js';
import type {
  CallingProvider,
  EmailProvider,
  GeocodingProvider,
  LicenceVerificationProvider,
  ObjectStore,
  PushProvider,
  SmsProvider,
  WhatsAppProvider,
} from './types.js';

/**
 * Provider selection happens once, here. Nothing else in the codebase knows
 * which vendor is in use.
 */
const isDevOrTest = isTest || env.NODE_ENV === 'development';
const useMemory = isDevOrTest || env.MESSAGING_TEST_MODE;

if (env.NODE_ENV === 'production' && env.FILE_STORAGE_DRIVER === 'local') {
  logger.warn(
    'FILE_STORAGE_DRIVER=local in production: uploaded files are only as durable as this machine\'s disk and are NOT in the database backup. Use db (or s3) unless the disk is a persistent volume.',
  );
}

if (env.MESSAGING_TEST_MODE && !isDevOrTest) {
  logger.warn(
    'MESSAGING_TEST_MODE is on: unconfigured channels are recorded in the notification log and not sent.',
  );
}

/**
 * The in-memory providers accept every webhook signature, which is right in
 * tests and wrong on a public server. In test mode on a real deployment,
 * refuse inbound webhooks for channels that are not really configured.
 */
function noWebhooks<T extends { validateWebhookSignature: (...a: never[]) => boolean }>(p: T): T {
  return isDevOrTest ? p : { ...p, validateWebhookSignature: () => false };
}
const memSms = noWebhooks(memorySmsProvider);
const memCalling = noWebhooks(memoryCallingProvider);

export const smsProvider: SmsProvider =
  twilioSmsProvider.enabled ? twilioSmsProvider : useMemory ? memSms : twilioSmsProvider;

export const pushProvider: PushProvider =
  webPushProvider.enabled ? webPushProvider : useMemory ? memoryPushProvider : webPushProvider;

export const callingProvider: CallingProvider =
  twilioCallingProvider.enabled
    ? twilioCallingProvider
    : useMemory
      ? memCalling
      : twilioCallingProvider;

export const geocodingProvider: GeocodingProvider = nominatimProvider;

export const emailProvider: EmailProvider =
  smtpEmailProvider.enabled ? smtpEmailProvider : useMemory ? memoryEmailProvider : smtpEmailProvider;

export const whatsappProvider: WhatsAppProvider =
  wahaWhatsAppProvider.enabled
    ? wahaWhatsAppProvider
    : useMemory
      ? memoryWhatsAppProvider
      : wahaWhatsAppProvider;

export const objectStore: ObjectStore = isTest
  ? memoryObjectStore
  : env.FILE_STORAGE_DRIVER === 's3'
    ? s3ObjectStore
    : env.FILE_STORAGE_DRIVER === 'db'
      ? dbObjectStore
      : localObjectStore;

/**
 * Licence verification. The null provider is the default and is not a
 * degraded mode — it is the honest answer when no verification service exists.
 * See providers/licence-verification.ts.
 */
export const licenceVerificationProvider: LicenceVerificationProvider =
  httpLicenceVerificationProvider.enabled
    ? httpLicenceVerificationProvider
    : nullLicenceVerificationProvider;

/**
 * What each outbound channel really does right now, for the screens:
 * 'live' sends, 'test' is recorded in Admin > Notifications only, 'off' has
 * no provider at all (sends would fail).
 */
export function channelStatus(): Record<'email' | 'sms' | 'whatsapp' | 'push', 'live' | 'test' | 'off'> {
  const s = (p: { name: string; enabled?: boolean }): 'live' | 'test' | 'off' =>
    p.name === 'memory' ? 'test' : p.enabled === false ? 'off' : 'live';
  return {
    email: s(emailProvider as { name: string; enabled?: boolean }),
    sms: s(smsProvider as { name: string; enabled?: boolean }),
    whatsapp: s(whatsappProvider as { name: string; enabled?: boolean }),
    push: s(pushProvider as { name: string; enabled?: boolean }),
  };
}

export function logProviderSelection(): void {
  logger.info(
    {
      sms: smsProvider.name,
      push: pushProvider.name,
      calling: callingProvider.name,
      email: emailProvider.name,
      whatsapp: whatsappProvider.name,
      files: objectStore.name,
      licenceVerification: licenceVerificationProvider.name,
    },
    'providers selected',
  );
}

export * from './types.js';
export { captured, faults, capturedExtra, extraFaults, resetMemoryObjectStore } from './inmemory.js';
export { verifySmtp } from './email.js';
export { twimlDial, twimlError } from './twilio.js';
export { vapidPublicKey } from './webpush.js';

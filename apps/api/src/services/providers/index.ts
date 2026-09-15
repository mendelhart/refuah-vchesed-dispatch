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
import { localObjectStore, s3ObjectStore } from './objectstore.js';
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
const useMemory = isTest || env.NODE_ENV === 'development';

export const smsProvider: SmsProvider =
  twilioSmsProvider.enabled ? twilioSmsProvider : useMemory ? memorySmsProvider : twilioSmsProvider;

export const pushProvider: PushProvider =
  webPushProvider.enabled ? webPushProvider : useMemory ? memoryPushProvider : webPushProvider;

export const callingProvider: CallingProvider =
  twilioCallingProvider.enabled
    ? twilioCallingProvider
    : useMemory
      ? memoryCallingProvider
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

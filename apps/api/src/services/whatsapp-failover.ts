/**
 * WhatsApp with an SMS fallback.
 *
 * WhatsApp goes out through the organisation's own WAHA server first. A WAHA
 * session can drop without warning (the paired phone goes flat, WhatsApp logs
 * the device out), so when WAHA is unhealthy or a send fails, the same text
 * goes by SMS instead and the delivery row records which carrier took it and
 * why. A volunteer who asked for WhatsApp still hears about the ride.
 *
 * The fallback is wired but inert until an SMS provider is configured: with no
 * Twilio credentials the original WAHA error is thrown and the normal retry
 * and "failed" surfacing apply, exactly as before.
 */
import { logger } from '../lib/logger.js';
import { smsProvider, whatsappProvider } from './providers/index.js';

export interface CarriedResult {
  provider: string;
  providerMessageId: string;
  /** Which network actually carried the message. */
  carriedBy: 'whatsapp' | 'sms';
  /** Set when WhatsApp was skipped or failed and SMS took over. */
  fallbackReason: string | null;
}

const HEALTH_TTL_MS = 60_000;
let health: { ok: boolean; detail: string; at: number } | null = null;

/** Cached WAHA session health; a failed send marks it unhealthy at once. */
export async function whatsappHealthy(): Promise<{ ok: boolean; detail: string }> {
  if (health && Date.now() - health.at < HEALTH_TTL_MS) return health;
  try {
    const h = await whatsappProvider.health();
    health = { ...h, at: Date.now() };
  } catch (err) {
    health = { ok: false, detail: (err as Error).message, at: Date.now() };
  }
  return health;
}

function markUnhealthy(detail: string): void {
  health = { ok: false, detail, at: Date.now() };
}

/** Test hook. */
export function resetWhatsAppHealth(): void {
  health = null;
}

/** SMS can take over only when a real (or test) SMS provider is available. */
export function smsFallbackAvailable(): boolean {
  return smsProvider.enabled;
}

export async function sendWhatsAppWithFallback(
  to: string,
  body: string,
  opts: { allowSmsFallback: boolean },
): Promise<CarriedResult> {
  const h = await whatsappHealthy();
  let reason: string;
  let original: Error;
  if (h.ok) {
    try {
      const r = await whatsappProvider.send(to, body);
      return { ...r, carriedBy: 'whatsapp', fallbackReason: null };
    } catch (err) {
      original = err as Error;
      reason = `WhatsApp send failed: ${original.message}`.slice(0, 300);
      markUnhealthy(original.message);
    }
  } else {
    reason = `WhatsApp unavailable (${h.detail})`.slice(0, 300);
    original = new Error(reason);
  }

  if (!opts.allowSmsFallback || !smsFallbackAvailable()) throw original;

  logger.warn({ reason }, 'WhatsApp fell back to SMS');
  const r = await smsProvider.send(to, body);
  return { ...r, carriedBy: 'sms', fallbackReason: reason };
}

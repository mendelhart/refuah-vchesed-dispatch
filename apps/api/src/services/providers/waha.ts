import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import type { WhatsAppProvider, WhatsAppSendResult } from './types.js';

/**
 * WhatsApp via the organisation's existing WAHA server.
 *
 * WAHA (github.com/devlikeapro/waha) is already running and already paired with
 * the organisation's number, so this adapter speaks its HTTP API rather than
 * replacing it with a different vendor. Everything WAHA-specific — the chat-id
 * format, the session name, the header it authenticates with — is confined to
 * this file; the notification path only knows `send(to, body)`.
 *
 * WhatsApp is treated as a *preference*, never as the carrier for an offer. A
 * paired session can drop without warning (the phone goes flat, WhatsApp logs
 * the device out) and an offer that silently fails to send is a volunteer who
 * was never asked. Offers force SMS and push; see notification.service.ts.
 */

const TIMEOUT_MS = 12_000;

/** WAHA addresses individuals as `<digits>@c.us`. */
function chatId(e164: string): string {
  return `${e164.replace(/\D/g, '')}@c.us`;
}

async function wahaFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${env.WAHA_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(env.WAHA_API_KEY ? { 'X-Api-Key': env.WAHA_API_KEY } : {}),
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export const wahaWhatsAppProvider: WhatsAppProvider = {
  name: 'waha',
  enabled: Boolean(env.WAHA_BASE_URL),

  async send(to: string, body: string): Promise<WhatsAppSendResult> {
    const res = await wahaFetch('/api/sendText', {
      method: 'POST',
      body: JSON.stringify({ session: env.WAHA_SESSION, chatId: chatId(to), text: body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WAHA sendText failed: ${res.status} ${detail.slice(0, 300)}`);
    }
    const payload = (await res.json().catch(() => ({}))) as { id?: string | { _serialized?: string } };
    const id =
      typeof payload.id === 'string'
        ? payload.id
        : (payload.id?._serialized ?? `waha-${Date.now()}`);
    return { provider: 'waha', providerMessageId: id };
  },

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (!env.WAHA_BASE_URL) return { ok: false, detail: 'WAHA_BASE_URL not set' };
    try {
      const res = await wahaFetch(`/api/sessions/${encodeURIComponent(env.WAHA_SESSION)}`);
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const body = (await res.json()) as { status?: string };
      // WAHA reports WORKING when the session is paired and connected.
      const ok = body.status === 'WORKING';
      return { ok, detail: body.status ?? 'unknown' };
    } catch (err) {
      logger.warn({ err }, 'WAHA health check failed');
      return { ok: false, detail: (err as Error).message };
    }
  },
};

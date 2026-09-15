import webpush from 'web-push';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { PushSubscriptionGoneError, type PushProvider } from './types.js';

/**
 * Web push.
 *
 * The key correctness rule, and the one the legacy app broke: the public key
 * the browser subscribes with MUST be the public half of the key pair the
 * server signs with. The client therefore fetches it from `/api/push/public-key`
 * rather than carrying a hard-coded literal, so the two cannot diverge.
 */
const configured = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

if (configured) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
} else {
  logger.warn('VAPID keys not configured — push notifications disabled');
}

export const webPushProvider: PushProvider = {
  name: 'web-push',
  enabled: configured,
  async send(target, payload) {
    if (!configured) throw new Error('Push is not configured');
    try {
      const res = await webpush.sendNotification(
        { endpoint: target.endpoint, keys: target.keys },
        JSON.stringify({
          title: payload.title,
          body: payload.body,
          data: payload.data ?? {},
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
        }),
        { TTL: 3600 },
      );
      return { provider: 'web-push', providerMessageId: String(res.statusCode) };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410 mean the browser threw the subscription away; stop retrying it.
      if (status === 404 || status === 410) {
        throw new PushSubscriptionGoneError(`push subscription gone (${status})`);
      }
      throw err;
    }
  },
};

export function vapidPublicKey(): string | null {
  return env.VAPID_PUBLIC_KEY ?? null;
}

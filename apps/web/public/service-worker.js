/* eslint-disable no-undef */
/**
 * Refuah V'Chesed service worker.
 *
 * Three jobs:
 *   1. Push  — a ride offer must reach a volunteer's lock screen, and tapping
 *              it must land on /o/<code>, which accepts in one tap.
 *   2. Click — focus an already-open tab rather than piling up new ones.
 *   3. Cache — the app shell, plus the detail of rides that are already the
 *              volunteer's, so the job card is readable in a hospital garage
 *              with no signal.
 */

const VERSION = 'v1';
const SHELL_CACHE = `rvc-shell-${VERSION}`;
const ASSET_CACHE = `rvc-assets-${VERSION}`;
const TRIP_CACHE = `rvc-trips-${VERSION}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE, TRIP_CACHE];

const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // One missing file must not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !KEEP.includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Trip reads a volunteer may need offline: their own rides, and one ride's detail. */
function isCacheableTripRequest(url) {
  if (url.origin !== self.location.origin) return false;
  if (!url.pathname.startsWith('/api/trips')) return false;
  if (url.pathname === '/api/trips' && url.searchParams.get('scope') !== 'mine') return false;
  // /api/trips/:id — but not the dispatcher-only sub-resources.
  if (url.pathname.endsWith('/history') || url.pathname.endsWith('/eligible-volunteers')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Navigations: network first, fall back to the cached shell so a cold start
  // offline still opens the app instead of the browser's dinosaur.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  if (isCacheableTripRequest(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(TRIP_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) =>
              cached ??
              new Response(JSON.stringify({ error: { code: 'offline', message: 'You are offline and this ride is not saved on this device.' } }), {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
              }),
          ),
        ),
    );
    return;
  }

  // Everything else on this origin that is not an API call: cache first.
  if (url.origin === self.location.origin && !url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Refuah V'Chesed", body: event.data ? event.data.text() : '' };
  }

  const data = payload.data || {};
  // One tap from the lock screen to accepting: /o/<code> accepts on arrival.
  const deepLink = data.code ? `/o/${data.code}` : data.tripId ? `/trips/${data.tripId}` : '/my-trips';

  event.waitUntil(
    self.registration.showNotification(payload.title || "Refuah V'Chesed", {
      body: payload.body || 'A ride needs a driver.',
      icon: payload.icon || '/icons/icon-192.png',
      badge: payload.badge || '/icons/badge-72.png',
      tag: data.tripId ? `trip-${data.tripId}` : undefined,
      renotify: Boolean(data.tripId),
      requireInteraction: data.event === 'trip.offered',
      data: { ...data, deepLink },
      actions: data.code ? [{ action: 'accept', title: 'Accept' }] : [],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.deepLink) || '/my-trips';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          // Reuse the tab the volunteer already has open.
          void client.focus();
          if ('navigate' in client) return client.navigate(target);
          return undefined;
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

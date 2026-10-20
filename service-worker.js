// Retire the older demo cache. The demo has no backend or push service.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (/^rvc-(shell|assets|trips)-/.test(key)) await caches.delete(key);
    }
    await self.registration.unregister();
    await self.clients.claim();
  })());
});

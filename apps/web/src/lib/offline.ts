import { useEffect, useState } from 'react';

/**
 * Offline support helpers.
 *
 * The service worker keeps a copy of the volunteer's own rides (including the
 * passenger's address and phone) so the job can still be driven with no signal.
 * That copy must not outlive the session: on a shared or handed-down phone the
 * next person to open the app would otherwise see it. And while offline, what
 * is on screen is the last saved copy, not the live dispatch state, so the app
 * says so.
 */
export async function clearTripCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('rvc-trips-')).map((k) => caches.delete(k)));
  } catch {
    // Cache storage can be unavailable (private mode); nothing to clear then.
  }
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

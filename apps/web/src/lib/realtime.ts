/**
 * Live board updates over Server-Sent Events.
 *
 * The stream carries ids and a status only; it is a signal to refetch through
 * the normal access-controlled endpoints, never a second way to read data.
 *
 * SSE is an enhancement, never a dependency: if the stream is unavailable
 * (proxy that buffers, offline, an old browser) the app keeps working on
 * ordinary query staleness. Nothing in here may throw into React.
 */
import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateTrips } from './query';

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

interface TripEventPayload {
  type?: string;
  id?: string;
}

export function connectRealtime(client: QueryClient): () => void {
  if (typeof EventSource === 'undefined') return () => {};

  let source: EventSource | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const handleTripEvent = (event: MessageEvent<string>): void => {
    let tripId: string | undefined;
    try {
      const payload = JSON.parse(event.data) as TripEventPayload;
      tripId = payload.id;
    } catch {
      // A malformed frame still means "something changed"; refetch anyway.
    }
    invalidateTrips(client, tripId);
  };

  const open = (): void => {
    if (stopped) return;
    try {
      source = new EventSource('/api/events/stream', { withCredentials: true });
    } catch {
      scheduleReconnect();
      return;
    }

    source.addEventListener('ready', () => {
      attempt = 0; // a clean open resets the backoff
    });
    source.addEventListener('trip', handleTripEvent as EventListener);

    source.onerror = () => {
      // EventSource retries on its own, but not with a bound; close and back off.
      source?.close();
      source = null;
      scheduleReconnect();
    };
  };

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer) return;
    attempt += 1;
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    const jitter = Math.random() * 250;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay + jitter);
  };

  open();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    source?.close();
    source = null;
  };
}

/** Mount once, inside the authenticated part of the tree. */
export function useRealtime(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return connectRealtime(client);
  }, [enabled, client]);
}

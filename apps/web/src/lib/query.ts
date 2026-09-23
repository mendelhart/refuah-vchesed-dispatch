/**
 * React Query setup and the single source of truth for cache keys.
 *
 * Two rules, both learned from the old app:
 *  1. Every key is unique per endpoint AND per parameter set. The old app used
 *     `['trips']` for the board, the volunteer list and the history screen, so
 *     a dispatcher's board write blew away a volunteer's list and vice versa.
 *     Keys here are built only through `qk`.
 *  2. Every invalidation uses the React Query v5 object form,
 *     `invalidateQueries({ queryKey })`. The positional form is a silent no-op
 *     in v5 — nothing refetches and nobody notices until the board is stale.
 */
import { QueryClient, type QueryClient as QueryClientType } from '@tanstack/react-query';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          // Never retry an auth or permission failure: it will not get better,
          // and retrying hides the redirect to /login.
          const status = (error as { status?: number } | null)?.status;
          if (status === 401 || status === 403 || status === 404) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export interface TripListParams {
  scope: 'board' | 'mine' | 'available' | 'history';
  status?: readonly string[];
  groupSlug?: string;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export const qk = {
  auth: {
    me: () => ['auth', 'me'] as const,
  },
  trips: {
    /** Root for "anything trip-shaped" — used only for invalidation. */
    all: () => ['trips'] as const,
    list: (params: TripListParams) => ['trips', 'list', params] as const,
    summary: () => ['trips', 'summary'] as const,
    detail: (id: string) => ['trips', 'detail', id] as const,
    history: (id: string) => ['trips', 'history', id] as const,
    eligibleVolunteers: (id: string) => ['trips', 'eligible-volunteers', id] as const,
  },
  people: {
    list: (params: { role?: string; groupSlug?: string; status?: string; search?: string }) =>
      ['people', 'list', params] as const,
    directory: () => ['people', 'directory'] as const,
    groups: () => ['people', 'groups'] as const,
  },
  me: {
    impact: () => ['me', 'impact'] as const,
    orgImpact: () => ['org', 'impact'] as const,
    status: () => ['me', 'status'] as const,
    notifications: () => ['me', 'notifications'] as const,
  },
  calls: {
    list: (params: { direction?: string; status?: string }) => ['calls', 'list', params] as const,
  },
  equipment: {
    list: (params: { status?: string; categoryId?: string }) => ['equipment', 'list', params] as const,
    categories: () => ['equipment', 'categories'] as const,
    loans: (open: boolean) => ['equipment', 'loans', open] as const,
  },
  vehicles: {
    list: () => ['vehicles', 'list'] as const,
  },
  contacts: {
    list: () => ['contacts', 'list'] as const,
  },
  admin: {
    audit: (params: { entityType?: string; action?: string; entityId?: string }) =>
      ['admin', 'audit', params] as const,
    deliveries: (params: { status?: string }) => ['admin', 'deliveries', params] as const,
    smsEvents: () => ['admin', 'sms-events'] as const,
    settings: () => ['admin', 'settings'] as const,
    opsHealth: () => ['admin', 'ops-health'] as const,
    features: () => ['admin', 'features'] as const,
  },
  org: {
    info: () => ['organization'] as const,
  },
  addresses: {
    search: (q: string) => ['addresses', 'search', q] as const,
  },
  push: {
    publicKey: () => ['push', 'public-key'] as const,
  },

  // --- production scope ----------------------------------------------------

  callers: {
    all: () => ['callers'] as const,
    list: (params: { limit?: number; offset?: number }) => ['callers', 'list', params] as const,
    search: (q: string) => ['callers', 'search', q] as const,
    detail: (id: string) => ['callers', 'detail', id] as const,
  },
  recurring: {
    all: () => ['recurring'] as const,
    list: (status?: string) => ['recurring', 'list', status ?? 'all'] as const,
    detail: (id: string) => ['recurring', 'detail', id] as const,
  },
  conversations: {
    all: () => ['conversations'] as const,
    list: (params: { status?: string; mine?: boolean }) => ['conversations', 'list', params] as const,
    detail: (id: string) => ['conversations', 'detail', id] as const,
  },
  applications: {
    all: () => ['applications'] as const,
    list: (status: string) => ['applications', 'list', status] as const,
    detail: (id: string) => ['applications', 'detail', id] as const,
    signupOptions: () => ['applications', 'signup-options'] as const,
  },
  volunteers: {
    all: () => ['volunteers'] as const,
    overview: (params: { search?: string; groupSlug?: string; serviceSlug?: string; status?: string }) =>
      ['volunteers', 'overview', params] as const,
    availability: (id: string) => ['volunteers', 'availability', id] as const,
    card: (id: string) => ['volunteers', 'card', id] as const,
  },
  meExtras: {
    availability: () => ['me', 'availability'] as const,
    services: () => ['me', 'services'] as const,
    idCard: () => ['me', 'id-card'] as const,
    licence: () => ['me', 'licence'] as const,
  },
  services: {
    list: () => ['services'] as const,
  },
  templates: {
    all: () => ['templates'] as const,
    list: () => ['templates', 'list'] as const,
    detail: (id: string) => ['templates', 'detail', id] as const,
  },
  duty: {
    all: () => ['duty'] as const,
    list: (params: { from?: string; to?: string; kind?: string }) => ['duty', 'list', params] as const,
  },
  exports: {
    all: () => ['exports'] as const,
    list: () => ['exports', 'list'] as const,
  },
  announcements: {
    all: () => ['announcements'] as const,
    list: () => ['announcements', 'list'] as const,
  },
  licences: {
    pending: () => ['licences', 'pending'] as const,
  },
  calendar: {
    zmanim: (date?: string) => ['calendar', 'zmanim', date ?? 'today'] as const,
    hebrew: (from: string, days: number) => ['calendar', 'hebrew', from, days] as const,
    restPeriods: (days: number) => ['calendar', 'rest-periods', days] as const,
  },
  board: {
    context: () => ['board', 'context'] as const,
  },
  equipmentExtras: {
    overdue: () => ['equipment', 'overdue'] as const,
    scan: (code: string) => ['equipment', 'scan', code] as const,
  },
} as const;

/** Everything that a trip state change can make stale, invalidated correctly. */
export function invalidateTrips(client: QueryClientType, tripId?: string): void {
  void client.invalidateQueries({ queryKey: qk.trips.all() });
  if (tripId) {
    void client.invalidateQueries({ queryKey: qk.trips.detail(tripId) });
    void client.invalidateQueries({ queryKey: qk.trips.history(tripId) });
  }
  void client.invalidateQueries({ queryKey: qk.me.impact() });
}

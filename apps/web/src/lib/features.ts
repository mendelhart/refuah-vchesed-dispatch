import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';

export interface Features {
  announcements: boolean;
}

/** Optional screens an administrator can switch off. Defaults to on while loading. */
export function useFeatures(enabled = true): Features {
  const q = useQuery({
    queryKey: qk.admin.features(),
    queryFn: () => api.get<Features>('/api/features'),
    enabled,
    staleTime: 60_000,
  });
  return q.data ?? { announcements: true };
}

/** Route -> feature flag that controls it. */
export const FEATURE_ROUTES: Record<string, keyof Features> = {
  '/admin/announcements': 'announcements',
};

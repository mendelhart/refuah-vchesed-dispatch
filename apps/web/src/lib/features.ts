import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk } from '@/lib/query';

/** Switches for built-but-not-yet-enabled features (server lib/flags.ts).
 *  All default off; a missing value means off. */
export interface FeatureFlags {
  multiLegTrips?: boolean;
  departmentScoping?: boolean;
  foodOps?: boolean;
  packageDelivery?: boolean;
  liftAssist?: boolean;
}

export interface Features {
  announcements: boolean;
  flags?: FeatureFlags;
  /** Departments this coordinator works in; null/absent = everything. */
  departments?: string[] | null;
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

/** True only when the server says the feature is on. */
export function useFlag(flag: keyof FeatureFlags, enabled = true): boolean {
  return Boolean(useFeatures(enabled).flags?.[flag]);
}

/** Route -> feature flag that controls it. */
export const FEATURE_ROUTES: Record<string, keyof Features> = {
  '/admin/announcements': 'announcements',
};

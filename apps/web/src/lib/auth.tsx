/**
 * Session state for the whole app.
 *
 * Fails closed: until `GET /api/auth/me` has answered, the app renders a
 * spinner and nothing else. There is no "render the dispatcher board while we
 * find out who you are" path, and no cached role is trusted across a reload.
 */
import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role, SessionUser } from '@rvc/shared';
import { ApiError, api } from './api';
import { qk } from './query';
import { clearViewAs, getViewAs } from './viewAs';
import type { SessionResponse } from '@/types/api';

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  hasRole: (roles: readonly Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function FullPageSpinner({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-[#EA0029] dark:border-slate-700 dark:border-t-[#EA0029]" />
        <span className="text-sm text-slate-500 dark:text-slate-400">{label}…</span>
      </div>
    </div>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const queryClient = useQueryClient();

  /**
   * Who is signed in.
   *
   * The distinction this query has to make is between "you are not signed in"
   * and "we could not ask". Only a 401 means the first. Anything else — a 429
   * from the rate limiter, a 500, a dropped connection on a hospital car park's
   * signal — means we do not know, and treating that as a sign-out throws a
   * dispatcher off the board mid-morning and sends a volunteer to a login screen
   * while they are trying to read a job card.
   *
   * So: 401 resolves to null (signed out, definitively). Every other failure
   * rethrows, `placeholderData` keeps the last known user on screen, and the
   * query retries with backoff until it gets a real answer.
   */
  const meQuery = useQuery({
    queryKey: qk.auth.me(),
    queryFn: async (): Promise<SessionUser | null> => {
      try {
        const data = await api.get<SessionResponse>('/api/auth/me');
        return data.user;
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthorized) return null;
        // The previewed person was deactivated or the preview is otherwise
        // refused: drop the preview and come back as yourself.
        if (error instanceof ApiError && error.status === 403 && getViewAs()) {
          clearViewAs();
          return (await api.get<SessionResponse>('/api/auth/me')).user;
        }
        throw error;
      }
    },
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.isUnauthorized) return false;
      return failureCount < 4;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  });

  const login = useCallback(
    async (email: string, password: string): Promise<SessionUser> => {
      const data = await api.post<SessionResponse>('/api/auth/login', { email, password });
      queryClient.setQueryData(qk.auth.me(), data.user);
      await queryClient.invalidateQueries({ queryKey: qk.trips.all() });
      return data.user;
    },
    [queryClient],
  );

  const logout = useCallback(async (): Promise<void> => {
    clearViewAs();
    try {
      await api.post('/api/auth/logout');
    } finally {
      // Whatever the server said, this browser is done with the session.
      queryClient.setQueryData(qk.auth.me(), null);
      queryClient.clear();
    }
  }, [queryClient]);

  const refresh = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: qk.auth.me() });
  }, [queryClient]);

  // `data` survives a failed refetch thanks to placeholderData, so a transient
  // outage does not empty this out from under the route guards.
  const user = meQuery.data ?? null;

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading: meQuery.isPending,
      login,
      logout,
      refresh,
      hasRole: (roles: readonly Role[]) => (user ? roles.includes(user.role) : false),
    }),
    [user, meQuery.isPending, login, logout, refresh],
  );

  if (meQuery.isPending) return <FullPageSpinner label="Checking your session" />;

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

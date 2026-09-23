/**
 * Route guards.
 *
 * THESE ARE UX ONLY. They decide what to *render*, nothing more. The server is
 * the authorization boundary: every endpoint re-checks the session and the
 * role, so a volunteer who types /board into the address bar gets a 403 from
 * the API even if a bug here let the screen mount. Never move an authorization
 * decision into this file.
 */
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '@rvc/shared';
import { FullPageSpinner, useAuth } from '@/lib/auth';
import { roleLabel } from '@rvc/shared';
import { TwoStepGate } from '@/components/TwoStepGate';

export function RequireAuth({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageSpinner />;
  if (!user) {
    // Remember where they were headed so the deep link survives sign-in —
    // an SMS offer link must not dump the volunteer on a blank home page.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (user.mfa) return <TwoStepGate mode={user.mfa} />;
  return <>{children}</>;
}

export function RequireRole({
  roles,
  children,
}: {
  roles: readonly Role[];
  children: React.ReactNode;
}): React.JSX.Element {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!roles.includes(user.role)) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">That screen is not yours to open</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Your account is set up as a {roleLabel(user.role).toLowerCase()}. If you think that is wrong, ask an administrator.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

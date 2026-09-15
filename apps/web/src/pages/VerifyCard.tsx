import React from 'react';
import { useParams } from 'react-router-dom';
import { BadgeCheck, ShieldX } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface CardCheck {
  valid: boolean;
  fullName?: string;
  volunteerNumber?: string;
  organization?: string;
}

/**
 * The page a hospital reception desk lands on after scanning a volunteer's card.
 *
 * Unauthenticated, standalone, and deliberately almost empty. The desk is
 * asking one question — is this person currently a volunteer here — and that is
 * the only question answered. No phone number, no email, no groups, no rides.
 * An unknown card and a deactivated one give the same answer, so the page
 * cannot be used to work out who used to volunteer here.
 */
export function VerifyCardPage(): React.JSX.Element {
  const { token = '' } = useParams<{ token: string }>();

  const { data, isPending, isError } = useQuery({
    queryKey: ['id-card', 'verify', token],
    queryFn: () => api.get<CardCheck>(`/api/id-card/verify/${encodeURIComponent(token)}`),
    retry: false,
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-700 dark:bg-slate-900">
        {isPending ? (
          <p className="text-slate-600 dark:text-slate-400">Checking…</p>
        ) : isError || !data?.valid ? (
          <>
            <ShieldX className="mx-auto h-12 w-12 text-slate-400" aria-hidden />
            <h1 className="mt-4 text-xl font-semibold text-slate-900 dark:text-white">
              This card is not current
            </h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Please ask the holder for another form of identification.
            </p>
          </>
        ) : (
          <>
            <BadgeCheck className="mx-auto h-12 w-12 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <h1 className="mt-4 text-xl font-semibold text-slate-900 dark:text-white">
              {data.fullName}
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              is a current volunteer with {data.organization}
            </p>
            {data.volunteerNumber ? (
              <p className="mt-4 font-mono text-sm text-slate-500 dark:text-slate-500">
                {data.volunteerNumber}
              </p>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

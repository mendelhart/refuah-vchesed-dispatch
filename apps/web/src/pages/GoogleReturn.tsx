/** Where Google sends the browser back to (item 9). Checks that the answer
 *  belongs to the sign-in this browser started, then hands the token to the
 *  API, which does all the real checking. */
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { STATE_KEY, parseGoogleReturn } from '@/lib/google-signin';
import { useI18n } from '@/i18n';

export function GoogleReturnPage(): React.JSX.Element {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const answer = parseGoogleReturn(window.location.hash);
    // Remove the token from the address bar and history straight away.
    window.history.replaceState(null, '', '/auth/google');
    let expected: string | null = null;
    try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch { /* storage blocked */ }
    if (answer.error || !answer.idToken || !answer.state || answer.state !== expected) {
      setProblem(t('login.googleFailed'));
      return;
    }
    api.post('/api/auth/google', { credential: answer.idToken })
      .then(async () => { await refresh(); navigate('/', { replace: true }); })
      .catch((e: unknown) => setProblem(errorMessage(e)));
  }, [navigate, refresh, t]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <main className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">{t('login.google')}</h1>
        {problem ? (
          <>
            <p role="alert" className="mt-3 text-sm text-slate-800 dark:text-slate-100">{problem}</p>
            <Link to="/login" className="mt-4 inline-block font-medium text-[#C80023] underline dark:text-red-400">{t('login.backToSignIn')}</Link>
          </>
        ) : (
          <p className="mt-3 text-sm text-slate-700 dark:text-slate-200" role="status">{t('login.googleWorking')}</p>
        )}
      </main>
    </div>
  );
}

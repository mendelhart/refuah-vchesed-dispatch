import React, { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { errorMessage, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { inputClass, labelClass, primaryButtonClass } from '@/components/states';
import { PasswordInput } from '@/components/PasswordInput';
import { useI18n } from '@/i18n';
import { LanguagePicker } from '@/i18n/LanguagePicker';
import { useQuery } from '@tanstack/react-query';
import { STATE_KEY, buildGoogleAuthUrl, googleRedirectUri, randomState } from '@/lib/google-signin';

/** "Sign in with Google" (item 9). Shown only when the server says Google
 *  sign-in is on; password sign-in above is unchanged. */
function GoogleSignIn(): React.JSX.Element | null {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    queryKey: ['public', 'google-signin'],
    queryFn: () => api.get<{ enabled: boolean }>('/api/public/google-signin'),
    staleTime: 300_000,
    retry: false,
  });
  if (!status.data?.enabled) return null;
  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const { nonce, clientId } = await api.post<{ nonce: string; clientId: string }>('/api/auth/google/start');
      const state = randomState();
      sessionStorage.setItem(STATE_KEY, state);
      window.location.assign(buildGoogleAuthUrl({ clientId, nonce, state, redirectUri: googleRedirectUri(window.location.origin) }));
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  };
  return (
    <div className="mt-4">
      <p className="mb-4 flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300" aria-hidden="true">
        <span className="h-px flex-1 bg-slate-300 dark:bg-slate-600" />{t('login.or')}<span className="h-px flex-1 bg-slate-300 dark:bg-slate-600" />
      </p>
      <button type="button" onClick={() => void start()} disabled={busy}
        className="flex min-h-[44px] w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-800">
        {t('login.google')}
      </button>
    </div>
  );
}

interface LocationState {
  from?: string;
}

export function LoginPage(): React.JSX.Element {
  const { user, login } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  const from = (location.state as LocationState | null)?.from ?? '/';
  if (user) return <Navigate to={from} replace />;

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      await login(email, password);
      toast.success(t('login.signedIn'));
      navigate(from, { replace: true });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    if (!email) {
      toast.error(t('login.enterEmailFirst'));
      return;
    }
    try {
      await api.post('/api/auth/request-password-reset', { email });
      setResetSent(true);
      toast.success(t('login.resetSent'));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex w-full items-center justify-center rounded-2xl bg-[#EA0029] px-6 py-5 shadow-sm">
            <img src="/brand/logo-white.svg" alt="" className="h-14 w-auto" />
          </div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">
            <span className="sr-only">Refuah V&apos;Chesed </span>Dispatch
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('login.subtitle')}</p>
        </div>

        <div className="mb-4"><LanguagePicker /></div>
        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <div>
            <label htmlFor="email" className={labelClass}>
              {t('login.identifier')}
            </label>
            <input
              id="email"
              type="text"
              inputMode="email"
              autoCapitalize="none"
              autoComplete="username"
              required
              className={inputClass}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="password" className={labelClass}>
              {t('login.password')}
            </label>
            <PasswordInput
              id="password"
              autoComplete="current-password"
              required
              className={inputClass}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button type="submit" className={`${primaryButtonClass} w-full`} disabled={busy}>
            {busy ? t('login.submitting') : t('login.submit')}
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="w-full text-center text-sm text-slate-600 underline-offset-2 hover:underline dark:text-slate-400"
          >
            {resetSent ? t('login.resetRequested') : t('login.forgot')}
          </button>
        </form>
        <GoogleSignIn />

        <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
          {t('login.newVolunteer')} <Link className="underline" to="/accept-invite">{t('login.setUp')}</Link>.
        </p>
        <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">
          <Link className="underline" to="/privacy">{t('login.privacy')}</Link>
        </p>
      </div>
    </div>
  );
}

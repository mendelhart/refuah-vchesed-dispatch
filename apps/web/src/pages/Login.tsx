import React, { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { errorMessage, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { inputClass, labelClass, primaryButtonClass } from '@/components/states';

interface LocationState {
  from?: string;
}

export function LoginPage(): React.JSX.Element {
  const { user, login } = useAuth();
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
      toast.success('Signed in.');
      navigate(from, { replace: true });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async (): Promise<void> => {
    if (!email) {
      toast.error('Enter your email address first, then tap this again.');
      return;
    }
    try {
      await api.post('/api/auth/request-password-reset', { email });
      setResetSent(true);
      toast.success('If that address is registered, a reset link is on its way.');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-[#E31E24] text-xl font-black text-white">
            RV
          </span>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Refuah V&apos;Chesed</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">Volunteer medical transport, Montreal</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <div>
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              className={inputClass}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="password" className={labelClass}>
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              className={inputClass}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button type="submit" className={`${primaryButtonClass} w-full`} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="w-full text-center text-sm text-slate-600 underline-offset-2 hover:underline dark:text-slate-400"
          >
            {resetSent ? 'Reset link requested' : 'I forgot my password'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
          New volunteer with an invitation? <Link className="underline" to="/accept-invite">Set up your account</Link>.
        </p>
      </div>
    </div>
  );
}

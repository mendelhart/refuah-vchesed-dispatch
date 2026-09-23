import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { resetPasswordSchema } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { inputClass, labelClass, primaryButtonClass } from '@/components/states';
import { PasswordInput } from '@/components/PasswordInput';

export function ResetPasswordPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const parsed = resetPasswordSchema.safeParse({ token, password });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', parsed.data);
      setDone(true);
      toast.success('Password changed. Sign in with the new one.');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Choose a new password</h1>
        {done ? (
          <>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Your password has been changed and every other signed-in device has been signed out.
            </p>
            <Link to="/login" className={`${primaryButtonClass} mt-4 w-full`}>
              Go to sign in
            </Link>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {params.get('token') ? null : (
              <div>
                <label htmlFor="reset-token" className={labelClass}>
                  Reset code
                </label>
                <input id="reset-token" className={inputClass} value={token} onChange={(event) => setToken(event.target.value)} required />
              </div>
            )}
            <div>
              <label htmlFor="reset-password" className={labelClass}>
                New password
              </label>
              <PasswordInput
                id="reset-password"
                autoComplete="new-password"
                className={inputClass}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">At least 12 characters.</p>
            </div>
            <button type="submit" className={`${primaryButtonClass} w-full`} disabled={busy}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

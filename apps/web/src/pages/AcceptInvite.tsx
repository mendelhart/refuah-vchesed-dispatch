import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { acceptInviteSchema } from '@rvc/shared';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { inputClass, labelClass, primaryButtonClass } from '@/components/states';
import type { SessionResponse } from '@/types/api';

export function AcceptInvitePage(): React.JSX.Element {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const parsed = acceptInviteSchema.safeParse({ token, password, fullName, phone });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the details above.');
      return;
    }
    setBusy(true);
    try {
      await api.post<SessionResponse>('/api/auth/accept-invite', parsed.data);
      await refresh();
      toast.success('Welcome. Your account is ready.');
      navigate('/', { replace: true });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 dark:bg-slate-950">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Set up your account</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            One time only. After this you sign in with your email and password.
          </p>
        </div>

        {params.get('token') ? null : (
          <div>
            <label htmlFor="token" className={labelClass}>
              Invitation code
            </label>
            <input id="token" className={inputClass} value={token} onChange={(event) => setToken(event.target.value)} required />
          </div>
        )}

        <div>
          <label htmlFor="full-name" className={labelClass}>
            Your full name
          </label>
          <input id="full-name" className={inputClass} value={fullName} onChange={(event) => setFullName(event.target.value)} required />
        </div>
        <div>
          <label htmlFor="phone" className={labelClass}>
            Mobile number
          </label>
          <input
            id="phone"
            type="tel"
            className={inputClass}
            value={phone}
            placeholder="+1 514 555 1234"
            onChange={(event) => setPhone(event.target.value)}
            required
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Ride offers are sent here, and your replies are matched back to you.
          </p>
        </div>
        <div>
          <label htmlFor="new-password" className={labelClass}>
            Choose a password
          </label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            className={inputClass}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">At least 12 characters.</p>
        </div>

        <button type="submit" className={`${primaryButtonClass} w-full`} disabled={busy}>
          {busy ? 'Setting up…' : 'Finish setup'}
        </button>
      </form>
    </div>
  );
}

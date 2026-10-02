/**
 * Two-step sign-in for coordinators and admins.
 *
 * After the password, the server marks the session as owing a code and refuses
 * everything else until it is entered (or set up, the first time). This screen
 * is only the front of that rule; the server enforces it.
 */
import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { QrCode } from '@/pages/MyIdCard';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '@/components/states';

interface SetupResponse { secret: string; otpauthUrl: string }

function Frame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="w-full max-w-md space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-7 w-7 text-[#C80023] dark:text-red-400" aria-hidden="true" />
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Two-step sign-in</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

function CodeInput({ value, onChange, id, label }: { value: string; onChange: (v: string) => void; id: string; label: string }): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      <input
        id={id}
        className={`${inputClass} text-center text-2xl tracking-[0.3em]`}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={20}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoFocus
      />
    </div>
  );
}

export function TwoStepGate({ mode }: { mode: 'setup' | 'verify' }): React.JSX.Element {
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);

  const done = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: qk.auth.me() });
  };

  const start = useMutation({
    mutationFn: () => api.post<SetupResponse>('/api/auth/mfa/setup', {}),
    onSuccess: (data) => setSetup(data),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/api/auth/mfa/enable', { code }),
    onSuccess: (data) => setRecovery(data.recoveryCodes),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });
  const verify = useMutation({
    mutationFn: () => api.post<unknown>('/api/auth/mfa/verify', { code }),
    onSuccess: () => void done(),
    onError: (error: unknown) => toast.error(errorMessage(error)),
  });

  const signOut = (
    <button type="button" className="text-sm text-slate-500 underline dark:text-slate-400" onClick={() => void logout()}>
      Sign out
    </button>
  );

  if (mode === 'verify') {
    return (
      <Frame>
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {useRecovery
            ? 'Type one of the recovery codes you saved when you set this up. Each code works once.'
            : 'Open your authenticator app and type the 6-digit code for Refuah V\'Chesed.'}
        </p>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); verify.mutate(); }}>
          <CodeInput id="mfa-code" label={useRecovery ? 'Recovery code' : 'Code'} value={code} onChange={setCode} />
          <button type="submit" className={`${primaryButtonClass} w-full`} disabled={verify.isPending || code.trim().length < 6}>
            {verify.isPending ? 'Checking…' : 'Continue'}
          </button>
        </form>
        <div className="flex items-center justify-between">
          <button type="button" className="text-sm text-[#C80023] dark:text-red-400 underline" onClick={() => { setUseRecovery((v) => !v); setCode(''); }}>
            {useRecovery ? 'Use the app code instead' : 'Lost your phone? Use a recovery code'}
          </button>
          {signOut}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">No phone and no recovery codes? An admin can reset it for you from People.</p>
      </Frame>
    );
  }

  if (recovery) {
    return (
      <Frame>
        <p className="text-sm font-medium text-slate-900 dark:text-white">Done. Save these recovery codes somewhere safe.</p>
        <p className="text-sm text-slate-700 dark:text-slate-200">
          If you lose your phone, each code gets you in once. They are shown only now.
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-3 font-mono text-base dark:bg-slate-800">
          {recovery.map((c) => <li key={c} className="text-slate-900 dark:text-white">{c}</li>)}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void navigator.clipboard?.writeText(recovery.join('\n')).then(() => toast.success('Copied.'), () => toast.error('Copy them by hand.'))}
          >
            Copy
          </button>
          <button type="button" className={primaryButtonClass} onClick={() => void done()}>
            I saved them - continue
          </button>
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <p className="text-sm text-slate-700 dark:text-slate-200">
        Coordinators and admins can see patient names, addresses and phone numbers, so sign-in now needs a code from
        your phone as well as your password. This takes about a minute, once.
      </p>
      {!setup ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
            <li>Install an authenticator app if you don&apos;t have one (Google Authenticator or Microsoft Authenticator, both free).</li>
            <li>Tap Start below and add the code it shows.</li>
            <li>Type the 6-digit number the app shows.</li>
          </ol>
          <button type="button" className={`${primaryButtonClass} w-full`} disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? 'Starting…' : 'Start'}
          </button>
        </>
      ) : (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); enable.mutate(); }}>
          <a href={setup.otpauthUrl} className={`${secondaryButtonClass} w-full justify-center`}>
            On this phone: open in authenticator app
          </a>
          <div className="mx-auto h-48 w-48">
            <QrCode text={setup.otpauthUrl} title="Scan with your authenticator app" />
          </div>
          <p className="text-center text-xs text-slate-500 dark:text-slate-400">
            On another device, scan this. Or type this key in the app:
            <span className="mt-1 block select-all break-all font-mono text-sm text-slate-900 dark:text-white">
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </span>
          </p>
          <CodeInput id="mfa-first-code" label="6-digit code from the app" value={code} onChange={setCode} />
          <button type="submit" className={`${primaryButtonClass} w-full`} disabled={enable.isPending || code.trim().length < 6}>
            {enable.isPending ? 'Checking…' : 'Turn on two-step sign-in'}
          </button>
        </form>
      )}
      <div className="text-right">{signOut}</div>
    </Frame>
  );
}

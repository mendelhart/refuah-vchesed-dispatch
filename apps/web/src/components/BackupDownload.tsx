import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { inputClass, primaryButtonClass } from './states';

export function BackupDownload(): React.JSX.Element | null {
  const { user } = useAuth();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = useQuery({ queryKey: ['backup-status'], queryFn: () => api.get<{ overdue: boolean }>('/api/admin/backup/status'), enabled: user?.role === 'admin' });
  if (user?.role !== 'admin') return null;
  const download = async (): Promise<void> => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/admin/backup/download', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }) });
      if (!response.ok) throw new Error('Backup failed. No backup is confirmed. Try again or check with the admin.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `rvc-${new Date().toISOString().slice(0, 10)}.rvc`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setPassphrase(''); await status.refetch();
    } catch (err) { setError(err instanceof Error ? err.message : 'Backup failed'); }
    finally { setBusy(false); }
  };
  return <details className="rounded-xl border border-slate-300 p-4 dark:border-slate-700">
    <summary className="min-h-11 cursor-pointer font-medium">{status.data?.overdue ? 'Backup needed: no full download in the last 7 days' : 'Download full backup'}</summary>
    <p className="my-3 text-sm">Keep the passphrase in your password manager. A restore also needs the existing field-encryption keys from Render. This download is not proof that a restore works or that the file was saved offsite.</p>
    <label className="block text-sm">Encryption passphrase (at least 16 characters)
      <input type="password" autoComplete="new-password" className={inputClass} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
    </label>
    <button type="button" className={`${primaryButtonClass} mt-3`} disabled={busy || passphrase.length < 16} onClick={() => void download()}>{busy ? 'Preparing backup...' : 'Download encrypted full backup'}</button>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
  </details>;
}

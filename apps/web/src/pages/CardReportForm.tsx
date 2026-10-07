import React, { useState } from 'react';
import { api } from '@/lib/api';
import { ORG_TYPES, REPORT_TYPES, T, type Lang } from './verify-i18n';

export function CardReportForm({ token, lang = 'fr' }: { token: string; lang?: Lang }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [reportType, setReportType] = useState('report conduct');
  const submit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    setBusy(true);
    setStatus('');
    try {
      await api.post(`/api/roster-cards/verify/${encodeURIComponent(token)}/report`, body);
      setStatus(T.received[lang]);
    } catch {
      setStatus(T.failed[lang]);
    } finally {
      setBusy(false);
    }
  };
  const buttons: [string, string][] = [
    ['report conduct', T.btnReport[lang]],
    ['found card', T.btnFound[lang]],
    ['comment', T.btnContact[lang]],
  ];
  const input = 'w-full rounded border p-2';
  return (
    <section className="mt-6 border-t pt-5 text-left">
      <div className="flex flex-wrap gap-2">
        {buttons.map(([type, label]) => (
          <button
            key={type}
            type="button"
            className="rounded-lg bg-[#ed1925] px-4 py-2 text-white"
            onClick={() => {
              setReportType(type);
              setOpen(true);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {open && (
        <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3">
          <p className="text-sm">{T.formNote[lang]}</p>
          <label className="block">
            {T.reportType[lang]}
            <select required name="reportType" value={reportType} onChange={(e) => setReportType(e.target.value)} className={input}>
              {REPORT_TYPES.map(([v, l]) => (
                <option key={v} value={v}>{l[lang]}</option>
              ))}
            </select>
          </label>
          <label className="block">
            {T.yourName[lang]}
            <input required name="reporterName" maxLength={120} className={input} />
          </label>
          <label className="block">
            {T.orgType[lang]}
            <select name="organizationType" required className={input}>
              {ORG_TYPES.map(([v, l]) => (
                <option key={v} value={v}>{l[lang]}</option>
              ))}
            </select>
          </label>
          <label className="block">
            {T.orgName[lang]}
            <input required name="organizationName" maxLength={160} className={input} />
          </label>
          <label className="block">
            {T.contact[lang]}
            <input required name="contact" maxLength={180} className={input} />
          </label>
          <label className="block">
            {T.message[lang]}
            <textarea required name="message" maxLength={4000} rows={4} className={input} />
          </label>
          <button disabled={busy || token === 'preview'} className="rounded-lg bg-[#ed1925] px-4 py-2 text-white">
            {busy ? T.saving[lang] : T.submit[lang]}
          </button>
          {token === 'preview' && <p>{T.sampleOnly[lang]}</p>}
        </form>
      )}
      {status && <p role="status" className="mt-3 text-sm">{status}</p>}
      <p className="mt-4 text-sm">
        <a href="mailto:info@refuahvchesed.org">info@refuahvchesed.org</a>
        <br />
        <a href="tel:+15143572167">514 357 2167</a>
      </p>
    </section>
  );
}

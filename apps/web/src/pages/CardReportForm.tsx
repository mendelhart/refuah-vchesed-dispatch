import React, { useState } from 'react';
import { api } from '@/lib/api';
import { CONTACT_METHODS, ORG_TYPES, REPORT_TYPES, T, type Lang } from './verify-i18n';

export function CardReportForm({ token, lang = 'fr' }: { token: string; lang?: Lang }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [reportType, setReportType] = useState('report conduct');
  const [organizationType, setOrganizationType] = useState('hospital');
  const [preferredContactMethod, setPreferredContactMethod] = useState('');
  const foundCard = reportType === 'found card';
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
  const input = `w-full rounded border border-slate-300 bg-white p-2 text-slate-900 ${token === 'preview' ? 'dark:bg-white dark:text-slate-900' : 'dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100'}`;
  return (
    <section className={`mt-6 border-t border-slate-300 pt-5 text-left text-slate-900 ${token === 'preview' ? 'dark:text-slate-900' : 'dark:border-slate-700 dark:text-slate-100'}`}>
      <div className="flex flex-wrap gap-2">
        {buttons.map(([type, label]) => (
          <button
            key={type}
            type="button"
            className="rounded-lg bg-[#ed1925] px-4 py-2 text-white"
            onClick={() => {
              setReportType(type);
              setOrganizationType('hospital');
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
            <select required name="reportType" value={reportType} onChange={(e) => { setReportType(e.target.value); setOrganizationType('hospital'); }} className={input}>
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
            <select name="organizationType" value={organizationType} onChange={(e) => setOrganizationType(e.target.value)} required className={input}>
              {[...ORG_TYPES, ...(foundCard ? [['private person', {fr: 'Particulier', en: 'Private person'}] as [string, {fr: string; en: string}]] : [])].map(([v, l]) => (
                <option key={v} value={v}>{l[lang]}</option>
              ))}
            </select>
          </label>
          {organizationType !== 'private person' && <label className="block">
            {T.orgName[lang]}
            <input required name="organizationName" maxLength={160} className={input} />
          </label>}
          {foundCard && <>
            <label className="block">{T.phone[lang]}<input required type="tel" name="phone" maxLength={40} minLength={7} className={input} /></label>
            <label className="block">{T.preferredContact[lang]}
              <select required name="preferredContactMethod" value={preferredContactMethod} onChange={(e) => setPreferredContactMethod(e.target.value)} className={input}>
                <option value="">{T.chooseContact[lang]}</option>
                {CONTACT_METHODS.map(([v, l]) => <option key={v} value={v}>{l[lang]}</option>)}
              </select>
            </label>
          </>}
          {(!foundCard || preferredContactMethod === 'email') ? <label className="block">
            {foundCard ? T.emailContact[lang] : T.contact[lang]}
            <input required type={foundCard ? 'email' : 'text'} name="contact" maxLength={180} className={input} />
          </label> : <input type="hidden" name="contact" value="See phone number" />}
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

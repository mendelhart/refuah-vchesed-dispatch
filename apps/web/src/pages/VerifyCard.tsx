import React from 'react';
import { useParams } from 'react-router-dom';
import { BadgeCheck, ShieldX } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {CardReportForm} from './CardReportForm';
import {LangToggle,T,useLang} from './verify-i18n';
import { api } from '@/lib/api';

interface CardCheck {
  valid: boolean;
 volunteerStatus?:string;reason?:string;kind?:string;unitNumber?:string;vehicle?:{make:string;model:string;year:string;plate:string};
  fullName?: string;
  volunteerNumber?: string;
  organization?: string;
  photo?: string;
}

/** Public card check. Invalid cards disclose status only, never person details. */
function StatusLabel({ status, lang }: { status?: string; lang: 'fr' | 'en' }): React.JSX.Element | null {
  if (!status) return null;
  const label = status === 'active' ? T.active : status === 'inactive' ? T.inactive : status === 'suspended' ? T.suspended : T.statusUnknown;
  return <p className={`mt-3 rounded-lg border px-3 py-2 text-sm font-semibold ${status === 'active' ? 'border-emerald-700 bg-emerald-100 text-emerald-900' : 'border-red-700 bg-red-100 text-red-900'}`}>{T.volunteerStatus[lang]}: {label[lang]}</p>;
}
export function VerificationPreview({state='active'}:{state?:string}):React.JSX.Element {
 const [lang,setLang]=useLang();const valid=state==='active'||state==='vehicle';
 const title=valid?T.previewValid[lang]:state==='lost'?T.previewLost[lang]:state==='revoked'?T.previewRevoked[lang]:T.invalid[lang];
 return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-900"><div className="w-full max-w-sm rounded-2xl border bg-white p-8 text-center shadow-sm"><LangToggle lang={lang} setLang={setLang}/><img src="/brand/cards/rvc-logo.svg" alt="Refuah V'Chesed" className="mx-auto mb-6 h-20 w-56 object-contain"/><div className="mb-5 h-2 rounded bg-[#ed1925]"/><p className="text-sm text-amber-800">{T.previewBanner[lang]}</p><h1 className={`mt-4 rounded-lg border p-3 text-xl font-semibold ${valid?'border-emerald-700 bg-emerald-100 text-emerald-900':'border-red-700 bg-red-100 text-red-900'}`}>{title}</h1><StatusLabel status={state === 'vehicle' ? 'active' : state === 'active' || state === 'inactive' || state === 'suspended' ? state : 'unknown'} lang={lang}/>{valid?<><div className="mx-auto mt-4 flex h-40 w-32 items-center justify-center rounded-xl bg-slate-200">{T.samplePhoto[lang]}</div><h2 className="mt-4 font-semibold">Sample Volunteer</h2><p>Unit 101</p>{state==='vehicle'&&<dl className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-4 text-left text-slate-900"><dt>{T.vehicle[lang]}</dt><dd className="font-semibold">2024 Toyota Sienna</dd><dt className="mt-2">{T.plate[lang]}</dt><dd className="font-mono font-semibold">DEMO 101</dd></dl>}<p className="mt-4 text-sm">{T.photoMatch[lang]}</p></>:<p className="mt-4 text-sm">{T.askId[lang]}</p>}<p className="mt-4 text-sm">{T.previewNote[lang]}</p><CardReportForm token="preview" lang={lang}/><nav className="mt-4 flex flex-wrap gap-3">{['active','vehicle','lost','revoked','inactive','suspended'].map(s=><a key={s} href={`?state=${s}`}>{s}</a>)}</nav></div></main>;
}
export function VerifyCardPage(): React.JSX.Element {
 const {token=''}=useParams<{token:string}>();
 if(token==='preview')return <VerificationPreview state={new URLSearchParams(window.location.search).get('state')??'active'}/>;
 return <LiveVerifyCardPage/>;
}
function LiveVerifyCardPage(): React.JSX.Element {
  const { token = '' } = useParams<{ token: string }>();
  const [lang, setLang] = useLang();

  const { data, isPending, isError } = useQuery({
    queryKey: ['id-card', 'verify', token],
    queryFn: () => api.get<CardCheck>(`/api/${token.startsWith('rr_')?'roster-cards':'id-card'}/verify/${encodeURIComponent(token)}`),
    retry: false,
    staleTime:0,gcTime:0,refetchOnMount:'always',refetchOnWindowFocus:true,
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <LangToggle lang={lang} setLang={setLang}/><img src="/brand/cards/rvc-logo.svg" alt="Refuah V'Chesed" className="mx-auto mb-6 h-20 w-56 object-contain"/><div className="mb-5 h-2 rounded bg-[#ed1925]"/>
        {isPending ? (
          <p className="text-slate-600 dark:text-slate-400">{T.checking[lang]}</p>
        ) : isError || !data?.valid ? (
          <>
            <ShieldX className="mx-auto h-12 w-12 text-slate-500 dark:text-slate-400" aria-hidden />
            <h1 className="mt-4 rounded-lg border border-red-700 bg-red-100 p-3 text-xl font-semibold text-red-900">
              {isError?T.unable[lang]:data?.reason==='reported_lost'?T.lost[lang]:data?.reason==='revoked'?T.revoked[lang]:data?.reason==='expired'?T.expired[lang]:T.invalid[lang]}
            </h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              {T.askId[lang]}
            </p>
          </>
        ) : (
          <>
            {data.photo ? (
              <img
                src={data.photo}
                alt={data.fullName ?? ''}
                className="mx-auto h-40 w-32 rounded-xl border-2 border-emerald-600 object-cover"
              />
            ) : null}
            <BadgeCheck
              className={`mx-auto text-emerald-600 dark:text-emerald-400 ${data.photo ? 'mt-4 h-8 w-8' : 'h-12 w-12'}`}
              aria-hidden
            />
            <h1 className="mt-4 text-xl font-semibold text-slate-900 dark:text-white">
              {data.fullName}
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {T.activeWith[lang]} {data.organization}
            </p>
            {data.unitNumber||data.volunteerNumber ? (
              <p className="mt-4 font-mono text-sm text-slate-500 dark:text-slate-400">
                {data.unitNumber??data.volunteerNumber}
              </p>
            ) : null}
            {data.vehicle&&<dl className="mt-4 rounded-lg bg-slate-50 p-4 text-left text-slate-900"><dt className="text-sm text-slate-500">{T.vehicle[lang]}</dt><dd className="font-semibold">{data.vehicle.year} {data.vehicle.make} {data.vehicle.model}</dd><dt className="mt-2 text-sm text-slate-500">{T.plate[lang]}</dt><dd className="font-mono font-semibold">{data.vehicle.plate}</dd></dl>}
            {data.photo ? (
              <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">{T.photoMatch[lang]}</p>
            ) : (
              <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">{T.noPhoto[lang]}</p>
            )}
          </>
        )}
        {!isPending && !isError && <StatusLabel status={data?.volunteerStatus} lang={lang}/>}
        {token.startsWith('rr_')&&<CardReportForm token={token} lang={lang}/>}
      </div>
    </main>
  );
}

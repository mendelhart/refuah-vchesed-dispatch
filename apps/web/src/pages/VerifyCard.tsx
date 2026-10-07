import React from 'react';
import { useParams } from 'react-router-dom';
import { BadgeCheck, ShieldX } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {CardReportForm} from './CardReportForm';
import { api } from '@/lib/api';

interface CardCheck {
  valid: boolean;
 reason?:string;kind?:string;unitNumber?:string;
  fullName?: string;
  volunteerNumber?: string;
  organization?: string;
  photo?: string;
}

/**
 * The page a hospital reception desk lands on after scanning a volunteer's card.
 *
 * Unauthenticated, standalone, and deliberately almost empty. The desk is
 * asking one question — is this person currently a volunteer here — and that is
 * the only question answered. No phone number, no email, no groups, no rides.
 * An unknown card and a deactivated one give the same answer, so the page
 * cannot be used to work out who used to volunteer here.
 */
export function VerificationPreview({state='active'}:{state?:string}):React.JSX.Element {
 const valid=state==='active';return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6"><div className="w-full max-w-sm rounded-2xl border bg-white p-8 text-center shadow-sm"><img src="/brand/cards/rvc-logo.svg" alt="Refuah V'Chesed" className="mx-auto mb-6 h-20 w-56 object-contain"/><div className="mb-5 h-2 rounded bg-[#ed1925]"/><p className="text-sm text-amber-800">SYNTHETIC PREVIEW - NOT A REAL CARD</p><h1 className="mt-4 text-xl font-semibold">{valid?'Valid - active volunteer':state==='lost'?'This card was reported lost - not valid':state==='revoked'?'This card was revoked - not valid':'This card is not valid'}</h1>{valid?<><div className="mx-auto mt-4 h-40 w-32 rounded-xl bg-slate-200 flex items-center justify-center">Sample photo</div><h2 className="mt-4 font-semibold">Sample Volunteer</h2><p>Unit 101</p><p className="mt-4 text-sm">Check that the photo matches the person.</p></>:<p className="mt-4 text-sm">Ask for another form of identification.</p>}<p className="mt-4 text-sm">This is a synthetic example. No person data is published by this preview.</p><CardReportForm token="preview"/><nav className="mt-4 flex flex-wrap gap-3">{['active','lost','revoked','inactive'].map(s=><a key={s} href={`?state=${s}`}>{s}</a>)}</nav></div></main>;
}
export function VerifyCardPage(): React.JSX.Element {
 const {token=''}=useParams<{token:string}>();
 if(token==='preview')return <VerificationPreview state={new URLSearchParams(window.location.search).get('state')??'active'}/>;
 return <LiveVerifyCardPage/>;
}
function LiveVerifyCardPage(): React.JSX.Element {
  const { token = '' } = useParams<{ token: string }>();

  const { data, isPending, isError } = useQuery({
    queryKey: ['id-card', 'verify', token],
    queryFn: () => api.get<CardCheck>(`/api/${token.startsWith('rr_')?'roster-cards':'id-card'}/verify/${encodeURIComponent(token)}`),
    retry: false,
    staleTime:0,gcTime:0,refetchOnMount:'always',refetchOnWindowFocus:true,
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <img src="/brand/cards/rvc-logo.svg" alt="Refuah V'Chesed" className="mx-auto mb-6 h-20 w-56 object-contain"/><div className="mb-5 h-2 rounded bg-[#ed1925]"/>
        {isPending ? (
          <p className="text-slate-600 dark:text-slate-400">Checking…</p>
        ) : isError || !data?.valid ? (
          <>
            <ShieldX className="mx-auto h-12 w-12 text-slate-500 dark:text-slate-400" aria-hidden />
            <h1 className="mt-4 text-xl font-semibold text-slate-900 dark:text-white">
              {isError?'Unable to verify this card':data?.reason==='reported_lost'?'Reported lost - not valid':data?.reason==='revoked'?'Revoked - not valid':data?.reason==='expired'?'Expired - not valid':'This card is not valid'}
            </h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Please ask the holder for another form of identification.
            </p>
          </>
        ) : (
          <>
            {data.photo ? (
              <img
                src={data.photo}
                alt={`Photo of ${data.fullName ?? 'the card holder'}`}
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
              is an active volunteer with {data.organization}
            </p>
            {data.unitNumber||data.volunteerNumber ? (
              <p className="mt-4 font-mono text-sm text-slate-500 dark:text-slate-400">
                {data.unitNumber??data.volunteerNumber}
              </p>
            ) : null}
            {data.photo ? (
              <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">Check that this photo matches the person in front of you.</p>
            ) : (
              <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">No photo on file. Please check another photo ID.</p>
            )}
          </>
        )}
        {token.startsWith('rr_')&&<CardReportForm token={token}/>}
      </div>
    </main>
  );
}

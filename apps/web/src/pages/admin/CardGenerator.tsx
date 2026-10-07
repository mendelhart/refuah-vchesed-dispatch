/** Admin-only local artwork. No create/update/reissue endpoints are called. */
import React, { useState,useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from '@/lib/api';
import { PageHeader, ErrorState } from '@/components/states';
import { CardArtwork, initialCardFields, type CardFields, type Face } from './card-artwork';
import { missingCardFields } from './card-readiness';
import { RequestMissingInfo } from './RequestMissingInfo';
import './card-artwork.css';
import './card-font-regular.css';
import font0 from './card-font-regular.css?raw';
import './card-font-bold.css';
import font1 from './card-font-bold.css?raw';
import './vehicle-font-regular.css';
import font2 from './vehicle-font-regular.css?raw';
import './vehicle-font-bold.css';
import font3 from './vehicle-font-bold.css?raw';
interface Volunteer {id:string;fullName:string;volunteerNumber:string|null;photo:string|null;status:string;hasVehicle:boolean;sourceDraft?:boolean;yiddishName?:string;plate?:string;unit?:string;phone?:string;email?:string;car?:string}
const faces:Face[]=['volunteer-front','volunteer-back','vehicle-front','vehicle-back'];
const labels:Record<Face,string>={'volunteer-front':'Volunteer front · 54 x 85.6 mm','volunteer-back':'Volunteer reverse · proposed terms','vehicle-front':'Vehicle front · 8.5 x 5.5 in','vehicle-back':'Vehicle reverse · historical text'};
export function fieldsForVolunteer(v:Volunteer):CardFields {return {...initialCardFields,name:v.fullName.toUpperCase(),number:v.volunteerNumber??'',photo:v.photo,plate:v.sourceDraft?v.plate??'':'',unit:v.sourceDraft?v.unit??'':''};}
export function PrintFace({face,fields,marks}:{face:Face;fields:CardFields;marks:boolean}):React.JSX.Element {
 const uid=React.useId().replace(/:/g,'');const id=face.startsWith('volunteer');const w=id?54:215.9;const h=id?85.6:139.7;
 if(!marks)return <CardArtwork face={face} fields={fields}/>;
 // Provisional 3 mm background bleed. The trim illustration is rendered untouched above it.
 const b=3,m=7;const W=w+14,H=h+14;const aw=id?855:1250,ah=id?1355:800;
 const bx=b*aw/w,by=b*ah/h;
 // Extend the original quadratic curves, not the picture or its repeating heart pattern.
 const curve=(p0:number[],p1:number[],p2:number[])=>{
  const t0=-.2,t1=1.2;const point=(t:number)=>p0.map((v,i)=>(1-t)**2*v+2*(1-t)*t*p1[i]!+t*t*p2[i]!);
  const start=point(t0),end=point(t1),control=start.map((v,i)=>v+(t1-t0)*((1-t0)*(p1[i]!-p0[i]!)+t0*(p2[i]!-p1[i]!)));
  return {start,end,control};
 };
 const band=(p0:number[],p1:number[],p2:number[],edge:number)=>{const c=curve(p0,p1,p2);return `M${c.start[0]} ${edge}V${c.start[1]}Q${c.control.join(' ')} ${c.end.join(' ')}V${edge}Z`;};
 return <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}} aria-label="Crop-mark proof, provisional 3 mm bleed">
 <defs><clipPath id={`bleed${uid}`}><path clipRule="evenodd" d={`M${m-b} ${m-b}h${w+2*b}v${h+2*b}h-${w+2*b}Z M${m} ${m}v${h}h${w}v-${h}Z`}/></clipPath></defs>
 <rect width={W} height={H} fill="white"/>
 <g clipPath={`url(#bleed${uid})`}><svg x={m} y={m} width={w} height={h} viewBox={`0 0 ${aw} ${ah}`} overflow="visible" preserveAspectRatio="none">
 <rect x={-bx} y={-by} width={aw+2*bx} height={ah+2*by} fill={id?'white':'#d8d9dc'}/>
 {id?<>
 <path d={band([855,302],[490,295],[0,474],-by)} fill="#b31d27"/>
 <path d={band([855,302],[475,350],[0,235],-by)} fill="#ed1925"/>
 <path d={band([0,1185],[315,1400],[855,1148],ah+by)} fill="#b31d27"/>
 <path d={band([0,1268],[520,1305],[855,1148],ah+by)} fill="#ed1925"/>
 </>:<>{[false,true].map(bottom=><g key={String(bottom)} transform={bottom?'translate(1250,800) rotate(180)':undefined}>
 <rect x={-bx} y={-by} width={1250+2*bx} height={60+by} fill="#262626"/>
 <path d={`M${-bx} ${-by}H${515+by}L490 25H${-bx}Z`} fill="#ed1925"/>
 <path d={`M${-bx} 27H897L${925+by} ${-by}H${967+by}L912 60H${-bx}Z`} fill="#d6d6d6"/>
 <path d={`M${-bx} 51H910L${960+by} ${-by}`} fill="none" stroke="#ed1925" strokeWidth="2"/>
 <path d={`M1190 60L${1250+by} ${-by}H${1250+bx}V60Z`} fill="#ed1925"/>
 </g>)}</>}
 </svg></g>
 <svg x={m} y={m} width={w} height={h} viewBox={`0 0 ${aw} ${ah}`} preserveAspectRatio="none"><CardArtwork face={face} fields={fields}/></svg>
 <g stroke="black" strokeWidth="0.18">{[m,m+w].map(x=><React.Fragment key={x}><line x1={x} x2={x} y1="0.7" y2="3.2"/><line x1={x} x2={x} y1={H-3.2} y2={H-.7}/></React.Fragment>)}{[m,m+h].map(y=><React.Fragment key={y}><line y1={y} y2={y} x1="0.7" x2="3.2"/><line y1={y} y2={y} x1={W-3.2} x2={W-.7}/></React.Fragment>)}</g>
 </svg>;
}
export function twoYearExpiry(issueMonth:string):string {
 if(!/^\d{4}-\d{2}$/.test(issueMonth))return '';
 const [year,month]=issueMonth.split('-').map(Number);
 if(!year||!month||month<1||month>12)return '';
 return `${year+2}-${String(month).padStart(2,'0')}`;
}
interface Prepared {roster_id:string;fields:CardFields;groups:string[];revision:number;verification_state:'unissued'|'active'|'lost'|'revoked'|'inactive'}
interface PreparationData {saved:Prepared[];numberPlan:Record<string,{number:string;issue:string|null}>;verificationActive:false}
export function CardGeneratorPage():React.JSX.Element {
 const roster=useQuery({queryKey:['admin-card-drafts'],queryFn:()=>api.get<{volunteers:Volunteer[]}>('/api/admin/card-drafts'),gcTime:0,refetchOnWindowFocus:false});
 const preparations=useQuery({queryKey:['admin-card-preparations'],queryFn:()=>api.get<PreparationData>('/api/admin/card-preparations'),gcTime:0,refetchOnWindowFocus:false});
 const reports=useQuery({queryKey:['admin-roster-card-reports'],queryFn:()=>api.get<{reports:{id:string;reporter_name:string;organization_type:string;organization_name:string;contact:string;report_type:string;message:string;identity_status:string}[]}>('/api/admin/roster-card-reports'),gcTime:0,refetchOnWindowFocus:true});
 const issuedCards=useQuery({queryKey:['admin-roster-cards'],queryFn:()=>api.get<{cards:{id:string;roster_id:string;kind:'volunteer'|'vehicle';state:string;revision:number;token:string}[]}>('/api/admin/roster-cards'),gcTime:0,refetchOnWindowFocus:false});
 const [confirmed,setConfirmed]=useState(false);const [plateConfirmed,setPlateConfirmed]=useState(false);
 const [readyOnly,setReadyOnly]=useState(false);const [groupFilter,setGroupFilter]=useState('');const [picked,setPicked]=useState<string[]>([]);const [groupEdits,setGroupEdits]=useState<Record<string,string>>({});const [saving,setSaving]=useState(false);const [stateEdits,setStateEdits]=useState<Record<string,string>>({});
 const savedFor=(v:Volunteer)=>preparations.data?.saved.find(p=>`roster:${p.roster_id}`===v.id);
 const planFor=(v:Volunteer)=>preparations.data?.numberPlan[v.id.replace('roster:','')];
 const baseFor=(v:Volunteer):CardFields=>savedFor(v)?.fields??{...fieldsForVolunteer(v),number:v.sourceDraft?(planFor(v)?.number??v.unit??''):(v.volunteerNumber??''),unit:v.sourceDraft?(planFor(v)?.number??v.unit??''):''};
 const groupsFor=(v:Volunteer)=>groupEdits[v.id]!==undefined?groupEdits[v.id]!.split(',').map(g=>g.trim()).filter(Boolean):savedFor(v)?.groups??[];
 const [cropMarks,setCropMarks]=useState(false);const [issueMonth,setIssueMonth]=useState('');const [selected,setSelected]=useState('sample');const [overrides,setOverrides]=useState<Record<string,CardFields>>({});const [expiry,setExpiry]=useState('');
 const [kind,setKind]=useState<'volunteer'|'vehicle'>('volunteer');const [all,setAll]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 useEffect(()=>{setConfirmed(false);setPlateConfirmed(false);},[selected,kind]);
 const current=roster.data?.volunteers.find(v=>v.id===selected);
 const base=current?baseFor(current):initialCardFields;
 const fields={...(overrides[selected]??base),expiry:expiry||base.expiry};
 const update=(key:keyof CardFields,value:string|null)=>setOverrides(s=>({...s,[selected]:{...fields,[key]:value,...(key==='number'?{unit:value??''}:key==='unit'?{number:value??''}:{})}}));
 const cardFor=(v:Volunteer)=>({...overrides[v.id]??baseFor(v),expiry:expiry||(overrides[v.id]??baseFor(v)).expiry});
 const filtered=(roster.data?.volunteers??[]).filter(v=>(!groupFilter||groupsFor(v).includes(groupFilter))&&(!readyOnly||(missingCardFields(cardFor(v),kind).length===0&&!planFor(v)?.issue)));
 const withQr=(d:CardFields,v:Volunteer|undefined):CardFields=>{const dirty=v&&(!!overrides[v.id]||!!expiry&&expiry!==savedFor(v)?.fields.expiry);const cards=dirty?[]:issuedCards.data?.cards.filter(c=>`roster:${c.roster_id}`===v?.id);const id=cards?.find(c=>c.kind==='volunteer'&&c.state==='active');const vehicle=cards?.find(c=>c.kind==='vehicle'&&c.state==='active');return {...d,issued:!!id,vehicleIssued:!!vehicle,verificationUrl:id?`${window.location.origin}/verify/${id.token}`:undefined,vehicleVerificationUrl:vehicle?`${window.location.origin}/verify/${vehicle.token}`:undefined};};
 const docs=all?filtered.filter(v=>!picked.length||picked.includes(v.id)).map(v=>withQr(cardFor(v),v)):[withQr(fields,current)];
 const save=async()=>{if(!current?.sourceDraft)return;setSaving(true);setError('');try{const {name,number,unit,plate,photo,expiry:expires,termsFr,termsEn,make,model,year}=fields;await api.put(`/api/admin/card-preparations/${current.id.replace('roster:','')}`,{fields:{name,number,unit,plate,photo,expiry:expires,termsFr,termsEn,make:make??'',model:model??'',year:year??''},groups:groupsFor(current),revision:savedFor(current)?.revision??0,verificationState:stateEdits[current.id]??savedFor(current)?.verification_state??'unissued'});await preparations.refetch();setOverrides(s=>{const next={...s};delete next[current.id];return next;});setExpiry('');await issuedCards.refetch();}catch(e){setError(e instanceof Error?e.message:'Save failed');}finally{setSaving(false);}};
 const issueCard=async()=>{if(!current?.sourceDraft)return;setError('');try{await api.post('/api/admin/roster-cards/issue',{rosterId:current.id.replace('roster:',''),kind,activeConfirmed:confirmed,photoConfirmed:confirmed,plateConfirmed,revision:savedFor(current)?.revision??0});await issuedCards.refetch();setConfirmed(false);setPlateConfirmed(false);}catch(e){setError(e instanceof Error?e.message:'Issuance failed');}};
 const setCardStatus=async(id:string,state:string,revision:number)=>{setError('');try{await api.patch(`/api/admin/roster-cards/${id}/status`,{state,revision,activeConfirmed:state==='active'?confirmed:undefined});await issuedCards.refetch();}catch(e){setError(e instanceof Error?e.message:'Status change failed');}};
 const chosen=faces.filter(f=>f.startsWith(kind));
 const photo=async(file:File|undefined)=>{setError('');if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5_000_000){setError('Use a JPEG, PNG or WebP photo under 5 MB.');return;}const value=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);});update('photo',value);};
 const download=async()=>{setBusy(true);setError('');try{
  let html=docs.map(d=>chosen.map(face=>`<div class="print-face ${kind==='volunteer'?'id':'vehicle'}">${renderToStaticMarkup(<PrintFace face={face} fields={d} marks={cropMarks}/>)}</div>`).join('')).join('');
  // Self-contained export. No external photo retrieval and no public artifact URL.
  const assets=[...new Set([...html.matchAll(/href="(\/brand\/[^"]+)"/g)].map(m=>m[1]!))];
  for(const path of assets){const response=await fetch(path);if(!response.ok)throw new Error('Artwork asset unavailable');const blob=await response.blob();const data=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsDataURL(blob);});html=html.split(`href="${path}"`).join(`href="${data}"`);}
  const css=kind==='vehicle'?font2+font3:font0+font1;
  const width=(kind==='volunteer'?54:215.9)+(cropMarks?14:0);const height=(kind==='volunteer'?85.6:139.7)+(cropMarks?14:0);const size=`${width}mm ${height}mm`;
  const source=`<!doctype html><html lang="en"><meta charset="utf-8"><title>RVC cards</title><style>${css}@page{size:${size};margin:0}body{margin:0;background:#ddd}.print-face{width:${width}mm;height:${height}mm;break-after:page;background:white}.print-face>svg{width:100%;height:100%;display:block}.print-face:last-child{break-after:auto}</style><body>${html}</body></html>`;
  const url=URL.createObjectURL(new Blob([source],{type:'text/html;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`rvc-${kind}-cards.html`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){setError(e instanceof Error?e.message:'Download failed.');}finally{setBusy(false);}};
 return <div className="card-generator space-y-5"><PageHeader title="Annual cards" subtitle="Saved cards and hospital verification. Sample and unissued cards remain marked for review."/>
 <div className="notice">Internal RVC IDs stay unchanged. Existing source unit numbers are preserved. Suggested new numbers fill missing values only; saving reserves them. Saved card details stay editable. Issue only after confirming the person, photo and required details. Issued QR links reveal name, number, photo and validity. Accounts, dispatch and messaging are unchanged.</div>
 {preparations.isError&&<ErrorState error={preparations.error} onRetry={()=>void preparations.refetch()} what="saved card preparation"/>}
 <section aria-label="Roster completeness"><h2>Missing information and batch selection</h2><label><input type="checkbox" checked={readyOnly} onChange={e=>setReadyOnly(e.target.checked)}/>Ready for this card type only</label><label>Card group<select value={groupFilter} onChange={e=>setGroupFilter(e.target.value)}><option value="">All groups</option>{[...new Set((roster.data?.volunteers??[]).flatMap(groupsFor))].sort().map(g=><option key={g}>{g}</option>)}</select></label><p>These are private card groups, not dispatch groups. Ready means required details are entered, not that identity or historical plate details have been verified.</p><table><thead><tr><th>Select</th><th>Volunteer</th><th>Unit number</th><th>Missing / review</th><th>Card groups</th><th>Saved</th></tr></thead><tbody>{filtered.map(v=><tr key={v.id}><td><input aria-label={`Select ${v.fullName}`} type="checkbox" checked={picked.includes(v.id)} onChange={e=>setPicked(p=>e.target.checked?[...p,v.id]:p.filter(id=>id!==v.id))}/></td><td><button onClick={()=>setSelected(v.id)}>{v.fullName}</button></td><td>{cardFor(v).number||'Missing'}</td><td>{[...missingCardFields(cardFor(v),kind),...(planFor(v)?.issue?[planFor(v)!.issue]:[])].join(', ')||'Details entered'}</td><td>{groupsFor(v).join(', ')||'No group'}</td><td>{savedFor(v)?'Saved':'Not saved'}</td></tr>)}</tbody></table><p>{filtered.length} shown; {picked.length} selected. Batch export includes selected rows within the current filter, or all shown rows when none are selected.</p></section>
 {roster.isError&&<ErrorState error={roster.error} onRetry={()=>void roster.refetch()} what="the admin card roster"/>}
 {current?.sourceDraft&&<><label>Private card groups (comma-separated)<input value={groupEdits[current.id]??groupsFor(current).join(', ')} onChange={e=>setGroupEdits(s=>({...s,[current.id]:e.target.value}))}/></label><label>Verification state preparation (not live)<select value={stateEdits[current.id]??savedFor(current)?.verification_state??'unissued'} onChange={e=>setStateEdits(s=>({...s,[current.id]:e.target.value}))}>{['unissued','active','lost','revoked','inactive'].map(v=><option key={v}>{v}</option>)}</select></label><p>Lost/revoked controls here save preparation only. A scan never confirms a real person until issuance is approved and verification is activated.</p><button disabled={saving||preparations.isPending||preparations.isError} onClick={()=>void save()}>{saving?'Saving…':'Save preparation'}</button><p>Saving does not issue a card. Source-sheet records and operational accounts stay unchanged.</p></>}
 {current?.sourceDraft&&<section><h2>Issue and manage cards</h2><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I confirm this is an active volunteer and the saved photo belongs to them</label><label><input type="checkbox" checked={plateConfirmed} onChange={e=>setPlateConfirmed(e.target.checked)}/>I confirm the saved plate belongs to this volunteer (vehicle plaque only)</label><button disabled={!confirmed||!savedFor(current)||missingCardFields(fields,kind).length>0||(kind==='vehicle'&&!plateConfirmed)} onClick={()=>void issueCard()}>Issue / replace {kind==='vehicle'?'vehicle plaque':'volunteer card'}</button>{issuedCards.data?.cards.filter(c=>`roster:${c.roster_id}`===current.id).map(c=><div key={c.id}><p>{c.kind}: {c.state}</p>{['lost','revoked','inactive','active'].map(state=><button key={state} disabled={c.state==='revoked'||(state==='active'&&!confirmed)} onClick={()=>void setCardStatus(c.id,state,c.revision)}>{state==='active'?'Reactivate':state}</button>)}</div>)}<p>Replacement invalidates all older QR codes for this card type. A revoked QR cannot be reused.</p></section>}
 {current?.sourceDraft&&<RequestMissingInfo key={current.id} person={{id:current.id,name:current.fullName,email:current.email,phone:current.phone,car:current.car,plate:current.plate,unit:current.unit}}/>}
 <div className="card-fields"><label>Volunteer<select aria-label="Volunteer" value={selected} onChange={e=>setSelected(e.target.value)}><option value="sample">Sample preview only</option>{roster.data?.volunteers.map(v=><option key={v.id} value={v.id}>{v.fullName} · {v.status}</option>)}</select></label><label>Proposed certificate issue month<input aria-label="Issue month" type="month" value={issueMonth} onChange={e=>{setIssueMonth(e.target.value);setExpiry(twoYearExpiry(e.target.value));}}/></label><label>Expiry month/year (adjustable)<input aria-label="Expiry" type="month" value={expiry} onChange={e=>setExpiry(e.target.value)}/></label>
 {(['name','number','plate','unit'] as const).map(key=><label key={key}>{({name:'Printed name',number:'Existing volunteer ID',plate:'Confirmed license plate',unit:'Confirmed unit ID'})[key]}<input aria-label={key} value={fields[key]} onChange={e=>update(key,e.target.value)} maxLength={key==='name'?48:20}/></label>)}
 <label>Vehicle make<input value={fields.make??''} maxLength={60} onChange={e=>update('make',e.target.value)}/></label><label>Vehicle model<input value={fields.model??''} maxLength={60} onChange={e=>update('model',e.target.value)}/></label><label>Vehicle year<input value={fields.year??''} maxLength={4} onChange={e=>update('year',e.target.value)}/></label>
 <label>Photo<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>void photo(e.target.files?.[0])}/></label><div className="muted">Source draft plate/unit values are historical source data; confirm them before printing. Operational user records have no volunteer-to-plate link. Plate and unit must be confirmed per volunteer. Use Save preparation to keep card edits and photos. Operational account records cannot be changed here.</div>
 <label>Proposed French reverse terms<textarea aria-label="French terms" value={fields.termsFr} maxLength={450} onChange={e=>update('termsFr',e.target.value)}/></label><label>Proposed English reverse terms<textarea value={fields.termsEn} maxLength={450} onChange={e=>update('termsEn',e.target.value)}/></label></div>
 <div className="notice">Review-only historical vehicle wording includes “VÉHICULE DE RÉPONSE AUTORISÉ” and requests to law enforcement. It is not proof of public authority or parking permission. The Quebec government mark from the original ID is intentionally withheld pending confirmation of permitted use. Proposed ID reverse terms need owner approval. Printer bleed and duplex alignment still need production approval.</div>
 <div className="flex flex-wrap items-center gap-3"><label>Export type<select aria-label="Export type" value={kind} onChange={e=>setKind(e.target.value as 'volunteer'|'vehicle')}><option value="volunteer">Volunteer front + reverse</option><option value="vehicle">Vehicle front + reverse</option></select></label><label style={{display:'flex',gap:8}}><input style={{width:'auto'}} type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>Batch from filtered roster ({filtered.length})</label><label style={{display:'flex',gap:8}}><input style={{width:'auto'}} aria-label="Crop marks" type="checkbox" checked={cropMarks} onChange={e=>setCropMarks(e.target.checked)}/>Crop marks + provisional 3 mm background bleed</label><button disabled={busy||docs.length===0} onClick={()=>void download()}>{busy?'Preparing…':'Download cards'}</button><button onClick={()=>window.print()}>Print / Save as PDF</button></div>
 {error&&<p role="alert">{error}</p>}
 <p className="muted">Crop-mark proof keeps finished sizes unchanged. Provisional 3 mm bleed extends only native background shapes, never the logo pattern. Confirm bleed with your printer; duplex alignment still needs a test print. Not printer-certified.</p><p className="muted">Export is a self-contained HTML file, including vector logos and fonts. Open it and print at 100%, with headers/footers off, to Save as PDF at the stated size. It contains personal information and must remain private. Only issued cards have live QR codes and no draft marking. Unissued cards stay marked NOT VALID.</p>
 <details><summary>Private report inbox ({reports.data?.reports.length??0})</summary>{reports.isError&&<p>Reports could not be loaded.</p>}{reports.data?.reports.map(r=><article key={r.id}><h3>{r.report_type}</h3><p>{r.reporter_name} · {r.organization_type} · {r.organization_name}</p><p>Identity: {r.identity_status} · Contact: {r.contact}</p><p>{r.message}</p></article>)}</details>
 <div className="card-faces">{faces.map(face=><div className="card-face" key={face}><div className="card-face-label">{labels[face]}</div><CardArtwork face={face} fields={withQr(fields,current)}/></div>)}</div>
 <style>{`@media print{@page{size:${kind==='volunteer'?(cropMarks?'68mm 99.6mm':'54mm 85.6mm'):(cropMarks?'229.9mm 153.7mm':'215.9mm 139.7mm')};margin:0}}`}</style>
 <div className="card-print-output">{docs.map((d,i)=>chosen.map(face=><div style={{width:`${(kind==='volunteer'?54:215.9)+(cropMarks?14:0)}mm`,height:`${(kind==='volunteer'?85.6:139.7)+(cropMarks?14:0)}mm`}} className={`print-face ${kind==='volunteer'?'id':'vehicle'}`} key={`${i}-${face}`}><PrintFace face={face} fields={d} marks={cropMarks}/></div>))}</div>
 </div>;
}

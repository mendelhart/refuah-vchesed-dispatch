/** Admin-only local artwork. No create/update/reissue endpoints are called. */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from '@/lib/api';
import { PageHeader, ErrorState } from '@/components/states';
import { CardArtwork, initialCardFields, type CardFields, type Face } from './card-artwork';
import './card-artwork.css';
interface Volunteer {id:string;fullName:string;volunteerNumber:string|null;photo:string|null;status:string;hasVehicle:boolean}
const faces:Face[]=['volunteer-front','volunteer-back','vehicle-front','vehicle-back'];
const labels:Record<Face,string>={'volunteer-front':'Volunteer front · 54 x 85.6 mm','volunteer-back':'Volunteer reverse · proposed terms','vehicle-front':'Vehicle front · 8.5 x 5.5 in','vehicle-back':'Vehicle reverse · historical text'};
export function fieldsForVolunteer(v:Volunteer):CardFields {return {...initialCardFields,name:v.fullName.toUpperCase(),number:v.volunteerNumber??'',photo:v.photo,plate:'',unit:''};}
export function CardGeneratorPage():React.JSX.Element {
 const roster=useQuery({queryKey:['admin-card-drafts'],queryFn:()=>api.get<{volunteers:Volunteer[]}>('/api/admin/card-drafts'),gcTime:0,refetchOnWindowFocus:false});
 const [selected,setSelected]=useState('sample');const [overrides,setOverrides]=useState<Record<string,CardFields>>({});const [expiry,setExpiry]=useState('');
 const [kind,setKind]=useState<'volunteer'|'vehicle'>('volunteer');const [all,setAll]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const current=roster.data?.volunteers.find(v=>v.id===selected);
 const base=current?fieldsForVolunteer(current):initialCardFields;
 const fields={...(overrides[selected]??base),expiry};
 const update=(key:keyof CardFields,value:string|null)=>setOverrides(s=>({...s,[selected]:{...fields,[key]:value}}));
 const docs=all?(roster.data?.volunteers??[]).map(v=>({...(overrides[v.id]??fieldsForVolunteer(v)),expiry})):[fields];
 const chosen=faces.filter(f=>f.startsWith(kind));
 const photo=async(file:File|undefined)=>{setError('');if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5_000_000){setError('Use a JPEG, PNG or WebP photo under 5 MB.');return;}const value=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);});update('photo',value);};
 const download=async()=>{setBusy(true);setError('');try{
  let html=docs.map(d=>chosen.map(face=>`<div class="print-face ${kind==='volunteer'?'id':'vehicle'}">${renderToStaticMarkup(<CardArtwork face={face} fields={d}/>)}</div>`).join('')).join('');
  // Self-contained export. No external photo retrieval and no public artifact URL.
  const assets=[...new Set([...html.matchAll(/href="(\/brand\/[^\"]+)"/g)].map(m=>m[1]!))];
  for(const path of assets){const response=await fetch(path);if(!response.ok)throw new Error('Artwork asset unavailable');const blob=await response.blob();const data=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsDataURL(blob);});html=html.split(`href="${path}"`).join(`href="${data}"`);}
  let css='';for(const [weight,path] of [[400,kind==='vehicle'?'vehicle-regular.ttf':'card-regular.ttf'],[700,kind==='vehicle'?'vehicle-bold.ttf':'card-bold.ttf']] as const){const res=await fetch(`/brand/cards/${path}`);if(!res.ok)throw new Error('Font unavailable');const b=await res.blob();const data=await new Promise<string>((resolve)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.readAsDataURL(b);});css+=`@font-face{font-family:${kind==='vehicle'?'VehicleCondensed':'CardCondensed'};src:url(${data});font-weight:${weight}}`;}
  const size=kind==='volunteer'?'54mm 85.6mm':'215.9mm 139.7mm';
  const source=`<!doctype html><html lang="en"><meta charset="utf-8"><title>RVC draft artwork - not valid</title><style>${css}@page{size:${size};margin:0}body{margin:0;background:#ddd}.print-face{width:${kind==='volunteer'?'54mm':'215.9mm'};height:${kind==='volunteer'?'85.6mm':'139.7mm'};break-after:page;background:white}.print-face svg{width:100%;height:100%}</style><body>${html}</body></html>`;
  const url=URL.createObjectURL(new Blob([source],{type:'text/html;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`rvc-${kind}-drafts.html`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){setError(e instanceof Error?e.message:'Download failed.');}finally{setBusy(false);}};
 return <div className="card-generator space-y-5"><PageHeader title="Annual cards" subtitle="Admin-only draft artwork. No credentials are issued or renewed."/>
 <div className="notice">Every volunteer gets a draft automatically when this screen opens. The original December 2025 expiry is not renewed automatically. Choose an expiry after review. Missing ID numbers, photos, plates and unit IDs stay unassigned. No changes are saved to volunteer accounts.</div>
 {roster.isError&&<ErrorState error={roster.error} onRetry={()=>void roster.refetch()} what="the admin card roster"/>}
 <div className="card-fields"><label>Volunteer<select aria-label="Volunteer" value={selected} onChange={e=>setSelected(e.target.value)}><option value="sample">Sample preview only</option>{roster.data?.volunteers.map(v=><option key={v.id} value={v.id}>{v.fullName} · {v.status}</option>)}</select></label><label>Expiry for this annual batch<input aria-label="Expiry" type="month" value={expiry} onChange={e=>setExpiry(e.target.value)}/></label>
 {(['name','number','plate','unit'] as const).map(key=><label key={key}>{({name:'Printed name',number:'Existing volunteer ID',plate:'Confirmed license plate',unit:'Confirmed unit ID'})[key]}<input aria-label={key} value={fields[key]} onChange={e=>update(key,e.target.value)} maxLength={key==='name'?48:20}/></label>)}
 <label>Photo for this draft only<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>void photo(e.target.files?.[0])}/></label><div className="muted">No volunteer-to-plate link exists in the current app. Plate and unit must be confirmed per volunteer. Draft edits and photos are lost when you leave this screen.</div>
 <label>Proposed French reverse terms<textarea aria-label="French terms" value={fields.termsFr} maxLength={450} onChange={e=>update('termsFr',e.target.value)}/></label><label>Proposed English reverse terms<textarea value={fields.termsEn} maxLength={450} onChange={e=>update('termsEn',e.target.value)}/></label></div>
 <div className="notice">Review-only historical vehicle wording includes “VÉHICULE DE RÉPONSE AUTORISÉ” and requests to law enforcement. It is not proof of public authority or parking permission. The Quebec government mark from the original ID is intentionally withheld pending confirmation of permitted use. Proposed ID reverse terms need owner approval. Printer bleed and duplex alignment still need production approval.</div>
 <div className="flex flex-wrap items-center gap-3"><label>Export type<select aria-label="Export type" value={kind} onChange={e=>setKind(e.target.value as 'volunteer'|'vehicle')}><option value="volunteer">Volunteer front + reverse</option><option value="vehicle">Vehicle front + reverse</option></select></label><label style={{display:'flex',gap:8}}><input style={{width:'auto'}} type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>All volunteer drafts ({roster.data?.volunteers.length??0})</label><button disabled={busy||docs.length===0} onClick={()=>void download()}>{busy?'Preparing…':'Download drafts'}</button><button onClick={()=>window.print()}>Print / Save as PDF</button></div>
 {error&&<p role="alert">{error}</p>}
 <p className="muted">Export is a self-contained HTML file, including vector logos and fonts. Open it and print at 100%, with headers/footers off, to Save as PDF at the stated size. It contains personal information and must remain private. Every draft is marked NOT VALID; issuance is not implemented.</p>
 <div className="card-faces">{faces.map(face=><div className="card-face" key={face}><div className="card-face-label">{labels[face]}</div><CardArtwork face={face} fields={fields}/></div>)}</div>
 <style>{`@media print{@page{size:${kind==='volunteer'?'54mm 85.6mm':'215.9mm 139.7mm'};margin:0}}`}</style>
 <div className="card-print-output">{docs.map((d,i)=>chosen.map(face=><div className={`print-face ${kind==='volunteer'?'id':'vehicle'}`} key={`${i}-${face}`}><CardArtwork face={face} fields={d}/></div>))}</div>
 </div>;
}

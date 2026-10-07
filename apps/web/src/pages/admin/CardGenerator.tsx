/** Admin-only local artwork. No create/update/reissue endpoints are called. */
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from '@/lib/api';
import { PageHeader, ErrorState } from '@/components/states';
import { CardArtwork, initialCardFields, type CardFields, type Face } from './card-artwork';
import './card-artwork.css';
import './card-font-regular.css';
import font0 from './card-font-regular.css?raw';
import './card-font-bold.css';
import font1 from './card-font-bold.css?raw';
import './vehicle-font-regular.css';
import font2 from './vehicle-font-regular.css?raw';
import './vehicle-font-bold.css';
import font3 from './vehicle-font-bold.css?raw';
interface Volunteer {id:string;fullName:string;volunteerNumber:string|null;photo:string|null;status:string;hasVehicle:boolean}
const faces:Face[]=['volunteer-front','volunteer-back','vehicle-front','vehicle-back'];
const labels:Record<Face,string>={'volunteer-front':'Volunteer front · 54 x 85.6 mm','volunteer-back':'Volunteer reverse · proposed terms','vehicle-front':'Vehicle front · 8.5 x 5.5 in','vehicle-back':'Vehicle reverse · historical text'};
export function fieldsForVolunteer(v:Volunteer):CardFields {return {...initialCardFields,name:v.fullName.toUpperCase(),number:v.volunteerNumber??'',photo:v.photo,plate:'',unit:''};}
export function PrintFace({face,fields,marks}:{face:Face;fields:CardFields;marks:boolean}):React.JSX.Element {
 const hash=Array.from(JSON.stringify({face,fields})).reduce((a,c)=>Math.imul(a^c.charCodeAt(0),16777619),2166136261)>>>0;const artId=`print-${hash}`;const id=face.startsWith('volunteer');const w=id?54:215.9;const h=id?85.6:139.7;
 if(!marks)return <CardArtwork face={face} fields={fields}/>;
 // Provisional 3 mm bleed, 4 mm clear mark margin. Original trim artwork stays exact.
 const b=3,m=7;const W=w+14,H=h+14;const aw=id?855:1250,ah=id?1355:800;
 return <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'100%'}} aria-label="Crop-mark proof, provisional 3 mm bleed">
 <rect width={W} height={H} fill="white"/>
 <defs><symbol id={artId} viewBox={`0 0 ${aw} ${ah}`}><CardArtwork face={face} fields={fields}/></symbol></defs>
 {[[m,m-b,w,b,0,0,aw,1],[m,m+h,w,b,0,ah-1,aw,1],[m-b,m,b,h,0,0,1,ah],[m+w,m,b,h,aw-1,0,1,ah],[m-b,m-b,b,b,0,0,1,1],[m+w,m-b,b,b,aw-1,0,1,1],[m-b,m+h,b,b,0,ah-1,1,1],[m+w,m+h,b,b,aw-1,ah-1,1,1],[m,m,w,h,0,0,aw,ah]].map(([x,y,sw,sh,vx,vy,vw,vh],i)=><svg key={i} x={x} y={y} width={sw} height={sh} viewBox={`${vx} ${vy} ${vw} ${vh}`} preserveAspectRatio="none"><use href={`#${artId}`} width={aw} height={ah}/></svg>)}
 <g stroke="black" strokeWidth="0.18">{[m,m+w].map(x=><React.Fragment key={x}><line x1={x} x2={x} y1="0.7" y2="3.2"/><line x1={x} x2={x} y1={H-3.2} y2={H-.7}/></React.Fragment>)}{[m,m+h].map(y=><React.Fragment key={y}><line y1={y} y2={y} x1="0.7" x2="3.2"/><line y1={y} y2={y} x1={W-3.2} x2={W-.7}/></React.Fragment>)}</g>
 </svg>;
}
export function twoYearExpiry(issueMonth:string):string {
 if(!/^\d{4}-\d{2}$/.test(issueMonth))return '';
 const [year,month]=issueMonth.split('-').map(Number);
 if(!year||!month||month<1||month>12)return '';
 return `${year+2}-${String(month).padStart(2,'0')}`;
}
export function CardGeneratorPage():React.JSX.Element {
 const roster=useQuery({queryKey:['admin-card-drafts'],queryFn:()=>api.get<{volunteers:Volunteer[]}>('/api/admin/card-drafts'),gcTime:0,refetchOnWindowFocus:false});
 const [cropMarks,setCropMarks]=useState(false);const [issueMonth,setIssueMonth]=useState('');const [selected,setSelected]=useState('sample');const [overrides,setOverrides]=useState<Record<string,CardFields>>({});const [expiry,setExpiry]=useState('');
 const [kind,setKind]=useState<'volunteer'|'vehicle'>('volunteer');const [all,setAll]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const current=roster.data?.volunteers.find(v=>v.id===selected);
 const base=current?fieldsForVolunteer(current):initialCardFields;
 const fields={...(overrides[selected]??base),expiry};
 const update=(key:keyof CardFields,value:string|null)=>setOverrides(s=>({...s,[selected]:{...fields,[key]:value}}));
 const docs=all?(roster.data?.volunteers??[]).map(v=>({...(overrides[v.id]??fieldsForVolunteer(v)),expiry})):[fields];
 const chosen=faces.filter(f=>f.startsWith(kind));
 const photo=async(file:File|undefined)=>{setError('');if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5_000_000){setError('Use a JPEG, PNG or WebP photo under 5 MB.');return;}const value=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);});update('photo',value);};
 const download=async()=>{setBusy(true);setError('');try{
  let html=docs.map(d=>chosen.map(face=>`<div class="print-face ${kind==='volunteer'?'id':'vehicle'}">${renderToStaticMarkup(<PrintFace face={face} fields={d} marks={cropMarks}/>)}</div>`).join('')).join('');
  // Self-contained export. No external photo retrieval and no public artifact URL.
  const assets=[...new Set([...html.matchAll(/href="(\/brand\/[^"]+)"/g)].map(m=>m[1]!))];
  for(const path of assets){const response=await fetch(path);if(!response.ok)throw new Error('Artwork asset unavailable');const blob=await response.blob();const data=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsDataURL(blob);});html=html.split(`href="${path}"`).join(`href="${data}"`);}
  const css=kind==='vehicle'?font2+font3:font0+font1;
  const width=(kind==='volunteer'?54:215.9)+(cropMarks?14:0);const height=(kind==='volunteer'?85.6:139.7)+(cropMarks?14:0);const size=`${width}mm ${height}mm`;
  const source=`<!doctype html><html lang="en"><meta charset="utf-8"><title>RVC draft artwork - not valid</title><style>${css}@page{size:${size};margin:0}body{margin:0;background:#ddd}.print-face{width:${width}mm;height:${height}mm;break-after:page;background:white}.print-face>svg{width:100%;height:100%;display:block}.print-face:last-child{break-after:auto}</style><body>${html}</body></html>`;
  const url=URL.createObjectURL(new Blob([source],{type:'text/html;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`rvc-${kind}-drafts.html`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){setError(e instanceof Error?e.message:'Download failed.');}finally{setBusy(false);}};
 return <div className="card-generator space-y-5"><PageHeader title="Annual cards" subtitle="Admin-only draft artwork. No credentials are issued or renewed."/>
 <div className="notice">Every volunteer gets a draft automatically when this screen opens. The original December 2025 expiry is not renewed automatically. Choose a proposed issue month to calculate a two-year expiry, or adjust the expiry after review. No issuance date is saved. Missing ID numbers, photos, plates and unit IDs stay unassigned. No changes are saved to volunteer accounts.</div>
 {roster.isError&&<ErrorState error={roster.error} onRetry={()=>void roster.refetch()} what="the admin card roster"/>}
 <div className="card-fields"><label>Volunteer<select aria-label="Volunteer" value={selected} onChange={e=>setSelected(e.target.value)}><option value="sample">Sample preview only</option>{roster.data?.volunteers.map(v=><option key={v.id} value={v.id}>{v.fullName} · {v.status}</option>)}</select></label><label>Proposed certificate issue month<input aria-label="Issue month" type="month" value={issueMonth} onChange={e=>{setIssueMonth(e.target.value);setExpiry(twoYearExpiry(e.target.value));}}/></label><label>Expiry month/year (adjustable)<input aria-label="Expiry" type="month" value={expiry} onChange={e=>setExpiry(e.target.value)}/></label>
 {(['name','number','plate','unit'] as const).map(key=><label key={key}>{({name:'Printed name',number:'Existing volunteer ID',plate:'Confirmed license plate',unit:'Confirmed unit ID'})[key]}<input aria-label={key} value={fields[key]} onChange={e=>update(key,e.target.value)} maxLength={key==='name'?48:20}/></label>)}
 <label>Photo for this draft only<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>void photo(e.target.files?.[0])}/></label><div className="muted">No volunteer-to-plate link exists in the current app. Plate and unit must be confirmed per volunteer. Draft edits and photos are lost when you leave this screen.</div>
 <label>Proposed French reverse terms<textarea aria-label="French terms" value={fields.termsFr} maxLength={450} onChange={e=>update('termsFr',e.target.value)}/></label><label>Proposed English reverse terms<textarea value={fields.termsEn} maxLength={450} onChange={e=>update('termsEn',e.target.value)}/></label></div>
 <div className="notice">Review-only historical vehicle wording includes “VÉHICULE DE RÉPONSE AUTORISÉ” and requests to law enforcement. It is not proof of public authority or parking permission. The Quebec government mark from the original ID is intentionally withheld pending confirmation of permitted use. Proposed ID reverse terms need owner approval. Printer bleed and duplex alignment still need production approval.</div>
 <div className="flex flex-wrap items-center gap-3"><label>Export type<select aria-label="Export type" value={kind} onChange={e=>setKind(e.target.value as 'volunteer'|'vehicle')}><option value="volunteer">Volunteer front + reverse</option><option value="vehicle">Vehicle front + reverse</option></select></label><label style={{display:'flex',gap:8}}><input style={{width:'auto'}} type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>All volunteer drafts ({roster.data?.volunteers.length??0})</label><label style={{display:'flex',gap:8}}><input style={{width:'auto'}} aria-label="Crop marks" type="checkbox" checked={cropMarks} onChange={e=>setCropMarks(e.target.checked)}/>Crop marks + provisional 3 mm bleed</label><button disabled={busy||docs.length===0} onClick={()=>void download()}>{busy?'Preparing…':'Download drafts'}</button><button onClick={()=>window.print()}>Print / Save as PDF</button></div>
 {error&&<p role="alert">{error}</p>}
 <p className="muted">Crop-mark proof keeps finished sizes unchanged. Provisional 3 mm bleed uses edge artwork extension outside trim only, with a 4 mm mark margin. Confirm bleed with your printer; duplex alignment still needs a test print. Not printer-certified.</p><p className="muted">Export is a self-contained HTML file, including vector logos and fonts. Open it and print at 100%, with headers/footers off, to Save as PDF at the stated size. It contains personal information and must remain private. Every draft is marked NOT VALID; issuance is not implemented.</p>
 <div className="card-faces">{faces.map(face=><div className="card-face" key={face}><div className="card-face-label">{labels[face]}</div><CardArtwork face={face} fields={fields}/></div>)}</div>
 <style>{`@media print{@page{size:${kind==='volunteer'?(cropMarks?'68mm 99.6mm':'54mm 85.6mm'):(cropMarks?'229.9mm 153.7mm':'215.9mm 139.7mm')};margin:0}}`}</style>
 <div className="card-print-output">{docs.map((d,i)=>chosen.map(face=><div style={{width:`${(kind==='volunteer'?54:215.9)+(cropMarks?14:0)}mm`,height:`${(kind==='volunteer'?85.6:139.7)+(cropMarks?14:0)}mm`}} className={`print-face ${kind==='volunteer'?'id':'vehicle'}`} key={`${i}-${face}`}><PrintFace face={face} fields={d} marks={cropMarks}/></div>))}</div>
 </div>;
}

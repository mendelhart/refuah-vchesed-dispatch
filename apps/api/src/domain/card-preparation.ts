/** Pure preparation only. Never issues verification or changes operational users. */
export function canonicalUnit(value:string|null|undefined):string|null {
 const s=value?.trim()??'';return /^\d{1,3}$/.test(s)&&Number(s)>0?String(Number(s)):null;
}
export function planUnitNumbers(rows:{id:string;unitNumber:string|null}[],reserved:string[]):Record<string,{number:string;issue:string|null}> {
 const used=new Set(reserved.map(canonicalUnit).filter((v):v is string=>v!==null));
 const counts=new Map<string,number>();for(const r of rows){const n=canonicalUnit(r.unitNumber);if(n){used.add(n);counts.set(n,(counts.get(n)??0)+1);}}
 const out:Record<string,{number:string;issue:string|null}>={};
 for(const r of [...rows].sort((a,b)=>a.id.localeCompare(b.id))){
  const source=r.unitNumber?.trim()??'';const n=canonicalUnit(source);
  if(source){out[r.id]={number:source,issue:!n?'Source number needs review':(counts.get(n)??0)>1?'Duplicate source number':reserved.some(v=>canonicalUnit(v)===n)?'Number also used by an account':null};continue;}
  let next=101;while(next<=999&&used.has(String(next)))next++;
  if(next>999){out[r.id]={number:'',issue:'No unused three-digit number'};continue;}
  used.add(String(next));out[r.id]={number:String(next),issue:null};
 }return out;
}

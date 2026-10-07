/** One scoped inert import. Private payload is temporary environment input, never logged. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
const expectedHash='0db706391bc4f53165ba86e36da16387669cdb34b583caeb2a04c88d5a3301e9';
const columns=['source_key','member_number','full_name','yiddish_name','source_status','unit_number','plate','data','source_refs','review_state'] as const;
export type RosterInput=Record<(typeof columns)[number],unknown>;
export function validatePayload(raw:string):RosterInput[]{
 if(createHash('sha256').update(raw).digest('hex')!==expectedHash)throw Error('payload_hash');
 const rows:unknown=JSON.parse(raw);if(!Array.isArray(rows)||rows.length!==95)throw Error('payload_count');
 const keys=new Set<string>();const numbers=new Set<string>();
 for(const value of rows){
  const r=value as RosterInput;if(!r||typeof r!=='object'||Object.keys(r).sort().join()!==[...columns].sort().join())throw Error('payload_shape');
  if(r.source_status!=='Active'||r.review_state!=='candidate'||typeof r.full_name!=='string'||!r.full_name.trim())throw Error('payload_status');
  if(typeof r.source_key!=='string'||!r.source_key||keys.has(r.source_key))throw Error('payload_key');keys.add(r.source_key);
  if(typeof r.member_number!=='string'||!/^RVC\d{4}$/.test(r.member_number)||numbers.has(r.member_number))throw Error('payload_number');numbers.add(r.member_number);
  if(!Array.isArray(r.source_refs)||!r.source_refs.length||!r.data||typeof r.data!=='object')throw Error('payload_source');
 }
 for(let i=1;i<=95;i++)if(!numbers.has(`RVC${String(i).padStart(4,'0')}`))throw Error('payload_namespace');
 return rows as RosterInput[];
}
function stable(v:unknown):string{if(Array.isArray(v))return '['+v.map(stable).join(',')+']';if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+stable(x)).join(',')+'}';return JSON.stringify(v);}
export async function executeImport(url:string,raw:string):Promise<{count:number;hash:string;unchangedTables:number;alreadyPresent:boolean}>{
 const rows=validatePayload(raw);const sql=postgres(url,{max:1,onnotice:()=>{}});
 try{return await sql.begin(async tx=>{
  await tx`SET LOCAL lock_timeout='10s'`;await tx`SET LOCAL statement_timeout='30s'`;await tx`SELECT pg_advisory_xact_lock(713104095)`;
  const tables=await tx<{tablename:string}[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  if(!tables.some(r=>r.tablename==='volunteer_roster_drafts'))throw Error('missing_table');
  for(const {tablename}of tables)await tx`LOCK TABLE ${tx(tablename)} IN SHARE ROW EXCLUSIVE MODE`;
  const triggers=await tx`SELECT 1 FROM pg_trigger WHERE tgrelid='public.volunteer_roster_drafts'::regclass AND NOT tgisinternal`;if(triggers.length)throw Error('unexpected_trigger');
  const protectedTables=tables.filter(r=>r.tablename!=='volunteer_roster_drafts');
  const snapshot=async()=>{const out:Record<string,string>={};for(const{tablename}of protectedTables){const[r]=await tx`SELECT count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${tx(tablename)} t`;if(!r)throw Error('snapshot_missing');out[tablename]=`${r.n}:${r.digest}`;}return stable(out);};
  const before=await snapshot();const existing=await tx`SELECT ${tx([...columns])} FROM volunteer_roster_drafts ORDER BY source_key`;
  const sorted=[...rows].sort((a,b)=>String(a.source_key).localeCompare(String(b.source_key)));
  const same=(actual:unknown[])=>stable([...actual].sort((a,b)=>String((a as RosterInput).source_key).localeCompare(String((b as RosterInput).source_key))))===stable(sorted);
  if(existing.length){if(!same(existing))throw Error('existing_conflict');}else{
   const values=rows.map(r=>({...r,data:tx.json(r.data as postgres.JSONValue),source_refs:tx.json(r.source_refs as postgres.JSONValue)}));
   await tx`INSERT INTO volunteer_roster_drafts ${tx(values,[...columns])}`;
  }
  const after=await tx`SELECT ${tx([...columns])} FROM volunteer_roster_drafts ORDER BY source_key`;if(after.length!==95||!same(after))throw Error('readback_mismatch');
  if(before!==await snapshot())throw Error('protected_table_changed');
  return {count:95,hash:expectedHash,unchangedTables:protectedTables.length,alreadyPresent:existing.length>0};
 });}finally{await sql.end({timeout:5});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const raw=process.env.RVC_INERT_ROSTER_ONCE;if(raw){
  delete process.env.RVC_INERT_ROSTER_ONCE;
  try{if(!process.env.DATABASE_URL)throw Error('database_missing');console.warn('[inert-roster] success '+JSON.stringify(await executeImport(process.env.DATABASE_URL,raw)));}
  catch{console.error('[inert-roster] blocked; transaction rolled back or not started. No payload or database error logged.');}
 }
}

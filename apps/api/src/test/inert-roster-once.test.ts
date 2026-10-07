import{describe,it,expect,vi}from'vitest';
const state=vi.hoisted(()=>({rows:[] as Record<string,unknown>[],changed:false,trigger:false,commits:0,rollbacks:0}));
vi.mock('postgres',()=>({default:()=>{
 const tx=async(strings:TemplateStringsArray,...args:unknown[])=>{const q=strings.join('?');
 if(q.includes('FROM pg_tables'))return[{tablename:'users'},{tablename:'volunteer_roster_drafts'}];
 if(q.includes('FROM pg_trigger'))return state.trigger?[{n:1}]:[];
 if(q.includes(' AS digest FROM'))return[{n:9,digest:state.changed&&state.rows.length?'changed':'unchanged'}];
 if(q.includes('INSERT INTO')){state.rows=args[0] as Record<string,unknown>[];return[];}
 if(q.includes('FROM volunteer_roster_drafts'))return state.rows;
 return[];};
 const tagged=Object.assign((first:unknown,...args:unknown[])=>Array.isArray(first)&&'raw'in first?tx(first as unknown as TemplateStringsArray,...args):first,{json:(v:unknown)=>v});
 return{begin:async(fn:(x:typeof tagged)=>Promise<unknown>)=>{const before=[...state.rows];try{const out=await fn(tagged);state.commits++;return out;}catch(e){state.rows=before;state.rollbacks++;throw e;}},end:async()=>{}};
}}));
import{validatePayload,executeImport}from'../db/import-roster-once.js';
const fixture=vi.hoisted(()=>JSON.stringify(Array.from({length:95},(_,i)=>({member_number:`RVC${String(i+1).padStart(4,'0')}`,source_key:`synthetic-${i}`,full_name:`Synthetic ${i}`,yiddish_name:null,source_status:'Active',unit_number:null,plate:null,data:{},source_refs:['synthetic:test'],review_state:'candidate'}))));
vi.mock('node:crypto',()=>({createHash:()=>({update:(raw:string)=>({digest:()=>raw===fixture?'0db706391bc4f53165ba86e36da16387669cdb34b583caeb2a04c88d5a3301e9':'invalid'})})}));
describe('scoped one-shot inert import',()=>{
 it('rejects absent/modified payload before DB access',()=>{expect(()=>validatePayload('[]')).toThrow('payload_hash');expect(()=>validatePayload('{bad')).toThrow('payload_hash');});
 it('transaction exact insert/readback and idempotent replay',async()=>{state.rows=[];state.changed=false;state.trigger=false;const raw=fixture;expect(validatePayload(raw)).toHaveLength(95);expect(await executeImport('mock',raw)).toMatchObject({count:95,unchangedTables:1,alreadyPresent:false});expect(state.rows).toHaveLength(95);expect(await executeImport('mock',raw)).toMatchObject({alreadyPresent:true});});
 it('rolls back if a protected table changed',async()=>{state.rows=[];state.changed=true;state.trigger=false;await expect(executeImport('mock',fixture)).rejects.toThrow('protected_table_changed');expect(state.rows).toHaveLength(0);state.changed=false;});
 it('refuses existing conflicts and triggers',async()=>{const raw=fixture;state.rows=[{source_key:'unexpected'}];await expect(executeImport('mock',raw)).rejects.toThrow('existing_conflict');state.rows=[];state.trigger=true;await expect(executeImport('mock',raw)).rejects.toThrow('unexpected_trigger');expect(state.rows).toHaveLength(0);state.trigger=false;});
});

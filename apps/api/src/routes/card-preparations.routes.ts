import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {sql} from '../db/client.js';
import {requireAdmin} from '../auth/guards.js';
import {Errors} from '../lib/errors.js';
import {canonicalUnit,planUnitNumbers} from '../domain/card-preparation.js';
const fields=z.object({name:z.string().trim().min(1).max(48),number:z.string().regex(/^\d{1,3}$/),plate:z.string().max(20),unit:z.string().max(3),photo:z.string().max(7_000_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/).nullable(),expiry:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),termsFr:z.string().max(450),termsEn:z.string().max(450)}).strict();
const input=z.object({fields,groups:z.array(z.string().trim().min(1).max(60)).max(20),revision:z.number().int().min(0),verificationState:z.enum(['unissued','active','lost','revoked','inactive'])}).strict();
export async function cardPreparationRoutes(app:FastifyInstance):Promise<void>{
 app.get('/api/admin/card-preparations',{preHandler:requireAdmin},async(_req,reply)=>{
  reply.header('Cache-Control','private, no-store');
  const rows=await sql<{id:string;unitNumber:string|null}[]>`SELECT r.id,COALESCE(p.unit_number,r.unit_number) AS "unitNumber" FROM volunteer_roster_drafts r LEFT JOIN card_preparations p ON p.roster_id=r.id ORDER BY r.member_number`;
  const users=await sql<{number:string}[]>`SELECT volunteer_number AS number FROM users WHERE volunteer_number IS NOT NULL`;
  const saved=await sql`SELECT roster_id,unit_number,fields,groups,revision,verification_state FROM card_preparations`;
  return {saved,numberPlan:planUnitNumbers(rows,users.map(u=>u.number)),verificationActive:false};
 });
 app.put<{Params:{id:string}}>('/api/admin/card-preparations/:id',{preHandler:requireAdmin,bodyLimit:8_000_000},async(req,reply)=>{
  reply.header('Cache-Control','private, no-store');
  if(!z.string().uuid().safeParse(req.params.id).success)throw Errors.validation('Invalid roster record');
  const parsed=input.safeParse(req.body);if(!parsed.success)throw Errors.validation('Check the card fields, photo, date and groups');
  const {fields:f,groups,revision,verificationState}=parsed.data;const n=canonicalUnit(f.number);
  if(!n||canonicalUnit(f.unit)!==n)throw Errors.validation('Volunteer and unit number must match and be 1-999');
  return sql.begin(async tx=>{
   await tx`SELECT pg_advisory_xact_lock(713104096)`;
   const roster=await tx`SELECT id,unit_number FROM volunteer_roster_drafts WHERE id=${req.params.id}`;
   if(!roster.length)throw Errors.notFound('Roster record');
   const old=await tx`SELECT revision FROM card_preparations WHERE roster_id=${req.params.id} FOR UPDATE`;
   if((old[0]?.revision??0)!==revision)throw Errors.conflict('Card changed; reload before saving');
   const collisions=await tx`SELECT 1 FROM volunteer_roster_drafts r WHERE r.id<>${req.params.id} AND COALESCE((SELECT p.unit_number FROM card_preparations p WHERE p.roster_id=r.id),r.unit_number) ~ '^[0-9]{1,3}$' AND ltrim(COALESCE((SELECT p.unit_number FROM card_preparations p WHERE p.roster_id=r.id),r.unit_number),'0')=${n} UNION ALL SELECT 1 FROM users WHERE volunteer_number ~ '^[0-9]{1,3}$' AND ltrim(volunteer_number,'0')=${n}`;
   if(collisions.length)throw Errors.conflict('Number already assigned; choose another');
   await tx`UPDATE roster_verification_cards SET state='revoked',revision=revision+1 WHERE roster_id=${req.params.id} AND state<>'revoked'`;
   const result=await tx`INSERT INTO card_preparations (roster_id,unit_number,fields,groups,verification_state) VALUES (${req.params.id},${f.number},${tx.json(f)},${tx.json([...new Set(groups)])},${verificationState}) ON CONFLICT (roster_id) DO UPDATE SET unit_number=EXCLUDED.unit_number,fields=EXCLUDED.fields,groups=EXCLUDED.groups,verification_state=EXCLUDED.verification_state,revision=card_preparations.revision+1,updated_at=now() RETURNING revision`;
   return {revision:result[0]!.revision,verificationActive:false};
  });
 });
}

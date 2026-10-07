import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
const rows = vi.hoisted(() => [{ id: 'sample', fullName: 'Sample Volunteer', volunteerNumber: null, photo: null, status: 'active', hasVehicle: true }]);
const staged = vi.hoisted(()=>[{id:'draft-id',fullName:'Synthetic Source',memberNumber:'RVC0001',yiddishName:'שם',plate:null,unitNumber:null,data:{},sourceRefs:['sheet:2']}]);
const select = vi.hoisted(() => vi.fn());
vi.mock('../db/client.js', () => ({ db: { select } }));
import {users}from'../db/schema.js';
import { cardDraftRoutes } from '../routes/card-drafts.routes.js';
describe('annual draft privacy', () => {
 it.each([undefined,'volunteer','dispatcher','admin'])('limits roster to admin, role %s', async role => {
  select.mockReturnValue({ from: (table: unknown) => ({ where: () => ({ orderBy: async () => table===users?rows:staged }) }) });
  const app=Fastify();
  app.addHook('preHandler',async req => {if(role) req.user={id:'sample',role,fullName:'Sample'} as NonNullable<typeof req.user>;});
  await app.register(cardDraftRoutes);
  const before=select.mock.calls.length; const res=await app.inject({method:'GET',url:'/api/admin/card-drafts'});
  if(role==='admin'){expect(res.statusCode).toBe(200);expect(res.headers['cache-control']).toContain('no-store');const body=res.json();expect(body.volunteers[0]).toEqual(rows[0]);expect(body.volunteers[1]).toMatchObject({id:'roster:draft-id',volunteerNumber:'RVC0001',sourceDraft:true,photo:null,hasVehicle:false});expect(body.issuesCredentials).toBe(false);expect(res.body).not.toMatch(/cardToken|verificationCode|passwordHash/);}
  else {expect(res.statusCode).not.toBe(200);expect(select.mock.calls.length).toBe(before);}
  await app.close();
 });
});

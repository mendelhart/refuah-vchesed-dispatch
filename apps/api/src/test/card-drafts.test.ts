import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
const rows = vi.hoisted(() => [{ id: 'sample', fullName: 'Sample Volunteer', volunteerNumber: null, photo: null, status: 'active', hasVehicle: true }]);
const select = vi.hoisted(() => vi.fn());
vi.mock('../db/client.js', () => ({ db: { select } }));
import { cardDraftRoutes } from '../routes/card-drafts.routes.js';
describe('annual draft privacy', () => {
 it.each([undefined,'volunteer','dispatcher','admin'])('limits roster to admin, role %s', async role => {
  select.mockReturnValue({ from: () => ({ where: () => ({ orderBy: async () => rows }) }) });
  const app=Fastify();
  app.addHook('preHandler',async req => {if(role) req.user={id:'sample',role,fullName:'Sample'} as NonNullable<typeof req.user>;});
  await app.register(cardDraftRoutes);
  const before=select.mock.calls.length; const res=await app.inject({method:'GET',url:'/api/admin/card-drafts'});
  if(role==='admin'){expect(res.statusCode).toBe(200);expect(res.headers['cache-control']).toContain('no-store');const body=res.json();expect(body.volunteers).toEqual(rows);expect(body.issuesCredentials).toBe(false);expect(res.body).not.toMatch(/cardToken|verificationCode|phone|email/);}
  else {expect(res.statusCode).not.toBe(200);expect(select.mock.calls.length).toBe(before);}
  await app.close();
 });
});

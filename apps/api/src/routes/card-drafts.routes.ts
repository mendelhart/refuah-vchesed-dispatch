/** Annual artwork data only. This path never issues IDs or mutates card tokens. */
import type { FastifyInstance } from 'fastify';
import { asc, eq, isNull, and } from 'drizzle-orm';
import { requireAdmin } from '../auth/guards.js';
import { db } from '../db/client.js';
import { users, volunteerRosterDrafts } from '../db/schema.js';

export async function cardDraftRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/card-drafts', { preHandler: requireAdmin }, async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Pragma', 'no-cache');
    const volunteers = await db.select({
      id: users.id, fullName: users.fullName, volunteerNumber: users.volunteerNumber,
      photo: users.photoUrl, status: users.status, hasVehicle: users.hasVehicle,
    }).from(users).where(and(eq(users.role, 'volunteer'), isNull(users.deletedAt)))
      .orderBy(asc(users.fullName), asc(users.id));
    const staged = await db.select().from(volunteerRosterDrafts).where(eq(volunteerRosterDrafts.sourceStatus, 'Active')).orderBy(asc(volunteerRosterDrafts.fullName), asc(volunteerRosterDrafts.id));
    // Do not call buildIdCard: it assigns a missing number/token as a side effect.
    // The vehicle roster has no volunteer ownership link. No plates are guessed.
    return { volunteers: [...volunteers.map((v) => ({ ...v,
      photo: v.photo?.startsWith('data:image/') ? v.photo : null,
    })), ...staged.map(r => ({ id: `roster:${r.id}`, fullName:r.fullName, volunteerNumber:r.memberNumber, photo:null, status:'source Active · draft only', hasVehicle:false, sourceDraft:true, yiddishName:r.yiddishName, plate:r.plate, unit:r.unitNumber, phone:r.data.phone??'', email:r.data.email??'', car:r.data.car??'', sourceRefs:r.sourceRefs }))], mode: 'draft', issuesCredentials: false };
  });
}

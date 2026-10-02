import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql as raw } from 'drizzle-orm';
import { uuidSchema } from '@rvc/shared';
import { actorFrom, currentUser, requireAdmin, requireAuth } from '../auth/guards.js';
import { db } from '../db/client.js';
import { recordAudit } from '../lib/audit.js';
import { Errors } from '../lib/errors.js';
import { requireFlag } from '../lib/flags.js';
import { DEPARTMENTS, departmentScope } from '../lib/departments.js';

/** Departments: admins decide who works in which (item 4). 404 while the
 *  feature is off; role guards run first. */
const on = requireFlag('departmentScoping');
const slugParam = z.object({ slug: z.enum(DEPARTMENTS) });
const membersBody = z.object({ userIds: z.array(uuidSchema).max(200) });

export async function departmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/departments', { preHandler: [requireAdmin, on] }, async () => {
    const rows = await db.execute<{ slug: string; name: string; user_id: string | null; full_name: string | null }>(raw`
      select d.slug, d.name, u.id as user_id, u.full_name
        from departments d
        left join department_members m on m.department_id = d.id
        left join users u on u.id = m.user_id and u.deleted_at is null
       order by d.name, u.full_name`);
    const out = new Map<string, { slug: string; name: string; members: Array<{ id: string; fullName: string }> }>();
    for (const r of rows) {
      const d = out.get(r.slug) ?? { slug: r.slug, name: r.name, members: [] };
      if (r.user_id && r.full_name) d.members.push({ id: r.user_id, fullName: r.full_name });
      out.set(r.slug, d);
    }
    return { departments: [...out.values()] };
  });

  app.put('/api/departments/:slug/members', { preHandler: [requireAdmin, on] }, async (req) => {
    const { slug } = slugParam.parse(req.params);
    const { userIds } = membersBody.parse(req.body);
    const unique = [...new Set(userIds)];
    if (unique.length) {
      const ok = await db.execute<{ id: string }>(raw`
        select id from users where id = any(${`{${unique.join(',')}}`}::uuid[]) and role = 'dispatcher' and deleted_at is null`);
      if (ok.length !== unique.length) throw Errors.validation('Only coordinators can belong to a department.');
    }
    const actor = actorFrom(req);
    await db.transaction(async (tx) => {
      const [dept] = await tx.execute<{ id: string }>(raw`select id from departments where slug = ${slug}`);
      if (!dept) throw Errors.notFound('Department');
      const current = (await tx.execute<{ user_id: string }>(raw`
        select user_id from department_members where department_id = ${dept.id}`)).map((r) => r.user_id);
      const add = unique.filter((id) => !current.includes(id));
      const remove = current.filter((id) => !unique.includes(id));
      for (const id of add) {
        await tx.execute(raw`insert into department_members (department_id, user_id, added_by_id) values (${dept.id}, ${id}, ${actor.userId ?? null}) on conflict do nothing`);
        await recordAudit({ actor, action: 'department.member_added', entityType: 'user', entityId: id, next: { department: slug } }, tx);
      }
      for (const id of remove) {
        await tx.execute(raw`delete from department_members where department_id = ${dept.id} and user_id = ${id}`);
        await recordAudit({ actor, action: 'department.member_removed', entityType: 'user', entityId: id, previous: { department: slug } }, tx);
      }
    });
    return { ok: true };
  });

  /** What the signed-in person may work on: null means everything. */
  app.get('/api/me/departments', { preHandler: [requireAuth, on] }, async (req) => {
    const scope = await departmentScope(currentUser(req));
    return { departments: scope ? [...scope] : null };
  });
}

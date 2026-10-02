import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { AuthenticatedUser } from '../auth/session.js';
import { Errors } from './errors.js';
import { isOn } from './flags.js';

/**
 * Departments: what a coordinator works on, separate from their role.
 *
 * The rule, in full:
 *   - feature off (DEPARTMENT_SCOPING_ENABLED unset): nobody is restricted
 *   - admins and volunteers: never restricted by departments
 *   - a coordinator in no department: not restricted (exactly today's access)
 *   - a coordinator in one or more departments: only those departments
 *
 * Enforced on the server, for every request, by registerDepartmentScope():
 * the trip endpoints check the trip's type, and the domain endpoints check
 * their department. Screens hide what is out of scope, but hiding is not the
 * protection.
 */

export const DEPARTMENTS = ['rides', 'food', 'equipment', 'reports'] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** Which department each kind of trip belongs to. */
export const TRIP_TYPE_DEPARTMENT: Record<string, Department> = {
  ride: 'rides',
  hospital_food: 'food',
  equipment_delivery: 'equipment',
};

/** Whole areas of the API that belong to one department. */
const ROUTE_PREFIX_DEPARTMENT: Array<[string, Department]> = [
  ['/api/equipment', 'equipment'],
  ['/api/recurring-rides', 'rides'],
  ['/api/callers', 'rides'],
  ['/api/impact', 'reports'],
  ['/api/reports', 'reports'],
  ['/api/food', 'food'],
  ['/api/packages', 'equipment'],
];

declare module 'fastify' {
  interface FastifyRequest {
    departmentScopeCache?: Set<Department> | null;
  }
}

/** null = not restricted; otherwise the departments this person may work in. */
export async function departmentScope(user: AuthenticatedUser | undefined): Promise<Set<Department> | null> {
  if (!user || !isOn('departmentScoping') || user.role !== 'dispatcher') return null;
  const rows = await db.execute<{ slug: Department }>(raw`
    select d.slug from department_members m join departments d on d.id = m.department_id where m.user_id = ${user.id}`);
  return rows.length === 0 ? null : new Set(rows.map((r) => r.slug));
}

async function scopeFor(req: FastifyRequest): Promise<Set<Department> | null> {
  if (req.departmentScopeCache === undefined) req.departmentScopeCache = await departmentScope(req.user);
  return req.departmentScopeCache;
}

/** Trip types a scoped coordinator may see; null = all. */
export async function allowedTripTypes(req: FastifyRequest): Promise<string[] | null> {
  const scope = await scopeFor(req);
  if (!scope) return null;
  return Object.entries(TRIP_TYPE_DEPARTMENT).filter(([, d]) => scope.has(d)).map(([t]) => t);
}

export function tripTypeInScope(scope: Set<Department> | null, tripType: string): boolean {
  if (!scope) return true;
  const dept = TRIP_TYPE_DEPARTMENT[tripType];
  return dept ? scope.has(dept) : false;
}

const NOT_YOURS = 'This belongs to a department you do not work in.';

/**
 * One preHandler for every route. It runs before the route's own guards, so
 * it only ever narrows: a person it does not restrict is untouched.
 */
export function registerDepartmentScope(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (!isOn('departmentScoping') || req.user?.role !== 'dispatcher') return;
    const route = req.routeOptions?.url ?? '';
    if (!route.startsWith('/api/')) return;
    const scope = await scopeFor(req);
    if (!scope) return;

    const area = ROUTE_PREFIX_DEPARTMENT.find(([prefix]) => route === prefix || route.startsWith(`${prefix}/`));
    if (area && !scope.has(area[1])) throw Errors.forbidden(NOT_YOURS);

    // A single trip: judged by the trip's own type. Not found rather than
    // forbidden, so a trip outside your departments is not even confirmed.
    if (route.startsWith('/api/trips/:id')) {
      const id = (req.params as { id?: string }).id;
      if (id) {
        const [t] = await db.execute<{ trip_type: string }>(raw`select trip_type from trips where id = ${id}::uuid`).catch(() => []);
        if (t && !tripTypeInScope(scope, t.trip_type)) throw Errors.notFound('Trip');
      }
    }

    // Creating: the type being created must be in scope.
    const body = (req.body ?? {}) as { tripType?: string; trip?: { tripType?: string }; tripIds?: string[] };
    if (req.method === 'POST' && (route === '/api/trips' || route === '/api/journeys')) {
      const type = (route === '/api/trips' ? body.tripType : body.trip?.tripType) ?? 'ride';
      if (!tripTypeInScope(scope, type)) throw Errors.forbidden(NOT_YOURS);
    }

    // Bulk actions name several trips: every one must be in scope.
    if (route.startsWith('/api/trips/bulk/') && Array.isArray(body.tripIds) && body.tripIds.length) {
      const rows = await db.execute<{ trip_type: string }>(raw`
        select trip_type from trips where id = any(${`{${body.tripIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).join(',')}}`}::uuid[])`);
      if (rows.some((r) => !tripTypeInScope(scope, r.trip_type))) throw Errors.forbidden(NOT_YOURS);
    }
  });
}

import { eq, sql as raw } from 'drizzle-orm';
import { SEED_GROUPS, SEED_SERVICES } from '@rvc/shared';
import { db, type Executor } from './client.js';
import { serviceTypes, users, volunteerGroups, volunteerServices } from './schema.js';
import { seedDefaultSettings } from '../lib/settings.js';
import { seedTemplates } from '../services/templates.service.js';
import { logger } from '../lib/logger.js';

/**
 * Reference data the application cannot function without.
 *
 * Distinct from `seed.ts`, which creates fictional people and refuses to run in
 * production. This runs at every boot, in every environment, and is idempotent:
 * it creates what is missing and never overwrites what is there. An
 * administrator who has edited a message template keeps their wording.
 *
 * It exists because three of the new subsystems fail closed without their
 * reference rows — with no `service_types`, targeting has nothing to match and
 * would offer trips to nobody at all.
 */
export async function bootstrapReferenceData(exec: Executor = db): Promise<void> {
  await seedDefaultSettings();

  for (const g of SEED_GROUPS) {
    await exec
      .insert(volunteerGroups)
      .values({ slug: g.slug, name: g.name })
      .onConflictDoNothing();
  }

  let servicesCreated = 0;
  for (const [index, s] of SEED_SERVICES.entries()) {
    const [existing] = await exec
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(eq(serviceTypes.slug, s.slug))
      .limit(1);
    if (existing) continue;
    await exec.insert(serviceTypes).values({
      slug: s.slug,
      name: s.name,
      description: s.description,
      dispatchable: s.dispatchable,
      sortOrder: index,
    });
    servicesCreated++;
  }

  const templatesCreated = await seedTemplates(exec);

  /**
   * Back-fill opt-ins for volunteers who predate the services table.
   *
   * Without this, the day targeting ships is the day every existing volunteer
   * silently stops receiving offers — they have no opt-in row, so the filter
   * excludes all of them. Everyone active at this moment is opted in to the
   * dispatchable services, which is what they were implicitly signed up for by
   * being on the roster at all. It runs once: a volunteer who later opts out
   * has a row for the services they kept, so the `not exists` guard skips them.
   */
  const backfilled = await backfillServiceOptIns(exec);

  if (servicesCreated || templatesCreated || backfilled.length) {
    logger.info(
      {
        services: servicesCreated,
        templates: templatesCreated,
        volunteersOptedIn: new Set(backfilled.map((r) => r.user_id)).size,
      },
      'reference data bootstrapped',
    );
  }
}

/**
 * Opts volunteers with no service rows at all into the dispatchable services.
 *
 * Runs at every boot, so a volunteer imported or created by a path that forgot
 * to set opt-ins is picked up on the next restart rather than quietly never
 * being offered anything again.
 */
export async function backfillServiceOptIns(
  exec: Executor = db,
): Promise<Array<{ user_id: string }>> {
  return (await exec.execute(raw`
    insert into volunteer_services (user_id, service_type_id)
    select u.id, st.id
      from users u
      cross join service_types st
     where u.deleted_at is null
       and u.role = 'volunteer'
       and st.dispatchable
       and st.active
       and not exists (select 1 from volunteer_services vs where vs.user_id = u.id)
    on conflict do nothing
    returning user_id
  `)) as unknown as Array<{ user_id: string }>;
}

/** Convenience for scripts and tests. */
export async function volunteerCount(): Promise<number> {
  const [row] = await db
    .select({ n: raw<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, 'volunteer'));
  return row?.n ?? 0;
}

export { volunteerServices };

/**
 * Development / staging seed.
 *
 * Creates the three volunteer groups, an admin, a dispatcher and a handful of
 * volunteers, plus a couple of trips in different states so the board is not
 * empty on first run. Never run against production: it refuses to.
 */
import { eq, sql as raw } from 'drizzle-orm';
import { SEED_GROUPS } from '@rvc/shared';
import { db, closeDb } from './client.js';
import { addresses, trips, userGroups, users, volunteerGroups, organizationInfo } from './schema.js';
import { hashPassword } from '../lib/crypto.js';
import { backfillServiceOptIns, bootstrapReferenceData } from './bootstrap.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

const PEOPLE = [
  { email: 'admin@refuahvchesed.test', name: 'Admin User', role: 'admin', phone: '+15145550100', groups: SEED_GROUPS.map((g) => g.slug) },
  { email: 'dispatch@refuahvchesed.test', name: 'Dina Dispatcher', role: 'dispatcher', phone: '+15145550101', groups: SEED_GROUPS.map((g) => g.slug) },
  { email: 'volunteer1@refuahvchesed.test', name: 'Yaakov Driver', role: 'volunteer', phone: '+15145550111', groups: ['chesed_on_the_go'] },
  { email: 'volunteer2@refuahvchesed.test', name: 'Rivka Helper', role: 'volunteer', phone: '+15145550112', groups: ['chesed_on_the_go'] },
  { email: 'volunteer3@refuahvchesed.test', name: 'Moshe Levi', role: 'volunteer', phone: '+15145550113', groups: ['chaim_vchesed', 'chesed_on_the_go'] },
] as const;

const PASSWORD = 'ChangeMeInDev123!';

export async function seed(): Promise<void> {
  if (env.NODE_ENV === 'production') throw new Error('refusing to seed a production database');
  // Groups, services, templates and settings are real reference data and live
  // in bootstrap.ts, which also runs in production.
  await bootstrapReferenceData();
  const groups = await db.select().from(volunteerGroups);
  const bySlug = new Map(groups.map((g) => [g.slug, g]));
  const passwordHash = await hashPassword(PASSWORD);

  for (const p of PEOPLE) {
    const [user] = await db.insert(users).values({
      email: p.email, fullName: p.name, role: p.role, phone: p.phone,
      status: 'active', passwordHash, notificationPreference: 'both',
    }).onConflictDoNothing().returning();
    const id = user?.id ?? (await db.select({ id: users.id }).from(users).where(eq(users.email, p.email)))[0]?.id;
    if (!id) continue;
    for (const slug of p.groups) {
      const g = bySlug.get(slug);
      if (g) await db.insert(userGroups).values({ userId: id, groupId: g.id }).onConflictDoNothing();
    }
  }

  await db.insert(organizationInfo).values({
    name: "Refuah V'Chesed", phone: '+15145550000', email: 'info@refuahvchesed.test',
    addressLine: 'Outremont, Montreal, QC',
  }).onConflictDoNothing();

  const existing = await db.select({ id: trips.id }).from(trips).limit(1);
  if (existing.length === 0) {
    const dispatcher = (await db.select({ id: users.id }).from(users).where(eq(users.email, 'dispatch@refuahvchesed.test')))[0];
    const group = bySlug.get('chesed_on_the_go')!;
    for (const sample of [
      { caller: 'Sara Klein', phone: '+15145559001', from: '1234 Avenue Bernard', to: '3755 Chemin de la Côte-Sainte-Catherine', hours: 3, needs: ['walker'] },
      { caller: 'David Roth', phone: '+15145559002', from: '5600 Avenue Durocher', to: '1650 Avenue Cedar', hours: 26, needs: [] },
    ]) {
      const [pickupAddr] = await db.insert(addresses).values({ line1: sample.from, city: 'Montreal' }).returning();
      const [dropoffAddr] = await db.insert(addresses).values({ line1: sample.to, city: 'Montreal', notes: 'Main entrance, ask for the transport desk' }).returning();
      const refRows = (await db.execute(
        raw`select next_trip_reference() as reference`,
      )) as unknown as Array<{ reference: string }>;
      await db.insert(trips).values({
        reference: refRows[0]!.reference, status: 'pending', groupId: group.id,
        callerName: sample.caller, callerPhone: sample.phone,
        pickupAddressId: pickupAddr!.id, dropoffAddressId: dropoffAddr!.id,
        pickupAt: new Date(Date.now() + sample.hours * 3_600_000),
        mobilityNeeds: sample.needs, createdById: dispatcher?.id ?? null,
        passengerNotes: 'Seed data for local development.',
      });
    }
  }
  // The volunteers were created after the bootstrap ran, so opt them in now.
  await backfillServiceOptIns();

  logger.info({ password: PASSWORD }, 'seed complete — sign in with any @refuahvchesed.test address');
}

const invokedDirectly = process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js');
if (invokedDirectly) {
  seed().then(async () => { await closeDb(); process.exit(0); })
    .catch(async (err) => { logger.error({ err }, 'seed failed'); await closeDb().catch(() => {}); process.exit(1); });
}

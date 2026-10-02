/**
 * Staging seed: a believable, entirely invented organisation.
 *
 *   npm run db:seed:staging          (from the repo root)
 *
 * Builds on the development seed (seed.ts) and adds enough made-up history to
 * exercise the board, reports and phone layouts: ~40 volunteers with weekly
 * availability, coordinators, callers, two months of rides in every state,
 * equipment with loans (some overdue), vehicles and phone-duty shifts.
 *
 * Every person is invented. Emails use the reserved `.test` domain, phone
 * numbers sit in the 555-01xx range that is set aside for fiction, and the
 * random generator is seeded, so two runs produce the same people and the
 * same pattern of rides (dates are relative to the day it runs).
 *
 * It refuses to run unless it is safe to (see assertSafeStagingTarget):
 *   - never with NODE_ENV=production
 *   - only against a database on this machine or a named, allowed host
 *   - never against a database that holds a person who is not synthetic
 * Running it twice is a no-op.
 */
import { eq, sql as raw } from 'drizzle-orm';
import { VOLUNTEER_CAPABILITIES } from '@rvc/shared';
import { db, closeDb } from './client.js';
import {
  addresses, availabilityRules, callers, dutyShifts, equipment, equipmentCategories,
  equipmentLoans, tripAssignments, trips, userGroups, users, vehicles, volunteerGroups,
} from './schema.js';
import { hashPassword } from '../lib/crypto.js';
import { backfillServiceOptIns } from './bootstrap.js';
import { seed as seedDevelopment } from './seed.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

export const STAGING_PASSWORD = 'StagingOnly-NotSecret-123!';
/** Marks a database this script has already filled. */
const MARKER_EMAIL = 'coordinator.a@staging.rvc.test';
/** Written last; its absence beside the marker means a run stopped part-way. */
const LAST_VEHICLE = 'Staging car 2';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db']);

/**
 * Throws unless the target is a throwaway database. Pure, so it is unit-tested
 * on its own (staging-seed.test.ts).
 */
export function assertSafeStagingTarget(opts: { databaseUrl: string; nodeEnv: string; allowHost?: string }): void {
  if (opts.nodeEnv === 'production') {
    throw new Error('refusing to seed: NODE_ENV is production');
  }
  let host: string;
  try {
    host = new URL(opts.databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error('refusing to seed: DATABASE_URL is not a valid URL');
  }
  if (LOCAL_HOSTS.has(host)) return;
  if (opts.allowHost && opts.allowHost.toLowerCase() === host) return;
  throw new Error(
    `refusing to seed: ${host} is not this machine. If it really is a throwaway staging database, ` +
      `set STAGING_SEED_ALLOW_HOST=${host} and run again.`,
  );
}

/**
 * True when every person in the database is synthetic (or there is nobody):
 * staff and volunteers have a `.test` email (or, with no email, a 555-01xx
 * style 514-555 number), and every caller and ride passenger has a 514-555
 * number. Real callers and passengers make it a real database.
 */
export async function onlySyntheticPeople(): Promise<boolean> {
  const fake = (col: string) => raw.raw(`regexp_replace(coalesce(${col}, ''), '\\D', '', 'g') ~ '^1?514555'`);
  const rows = await db.execute<{ n: number }>(raw`
    select
      (select count(*) from users
        where case when email is null then not (${fake('phone')})
                   else lower(email) not like '%.test' and lower(email) not like '%@test.local' end)
    + (select count(*) from callers where primary_phone is not null and not (${fake('primary_phone')}))
    + (select count(*) from trips where caller_phone is not null and not (${fake('caller_phone')}))
    as n`);
  return Number(rows[0]!.n) === 0;
}

// --- a small seeded random generator (mulberry32) ---------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Avi', 'Bina', 'Chaim', 'Dina', 'Eli', 'Faigy', 'Gershon', 'Hindy', 'Itzik', 'Jacob', 'Kayla', 'Leib',
  'Malka', 'Nachum', 'Ora', 'Pinchas', 'Rachel', 'Shmuel', 'Tova', 'Uri', 'Vivian', 'Yossi', 'Zelda', 'Ari'];
const LAST = ['Adler', 'Berger', 'Cohen', 'Dresner', 'Engel', 'Fink', 'Gold', 'Halpern', 'Isaacs', 'Jacobs', 'Kaplan',
  'Lerner', 'Mandel', 'Newman', 'Orlow', 'Perl', 'Rosen', 'Stern', 'Tauber', 'Weiss'];
const STREETS = ['Avenue Bernard', 'Avenue Van Horne', 'Avenue Durocher', 'Avenue Querbes', 'Rue Hutchison',
  'Avenue Champagneur', 'Avenue Outremont', 'Chemin Bates', 'Avenue Lajoie', 'Rue Jean-Talon'];
const DESTINATIONS = [
  { line1: '3755 Chemin de la Côte-Sainte-Catherine', notes: 'Main entrance' },
  { line1: '1001 Boulevard Décarie', notes: 'Door D, drop-off loop' },
  { line1: '5400 Boulevard Gouin Ouest', notes: 'Outpatient clinic' },
  { line1: '3840 Rue Saint-Urbain', notes: 'Pavilion entrance' },
  { line1: '1560 Rue Sherbrooke Est', notes: 'Emergency entrance only after 20:00' },
];
const CANCEL_REASONS = ['Appointment moved', 'Family is driving', 'Passenger feeling unwell'];

function phone(n: number): string {
  return `+1514555${String(100 + n).padStart(4, '0')}`; // +1 514 555-01xx (the dev seed uses 0100-0113)
}

export interface StagingSummary { skipped: boolean; volunteers: number; trips: number; loans: number }

export async function seedStaging(): Promise<StagingSummary> {
  assertSafeStagingTarget({
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV,
    allowHost: process.env.STAGING_SEED_ALLOW_HOST,
  });
  if (!(await onlySyntheticPeople())) {
    throw new Error('refusing to seed: this database holds people who are not synthetic (emails outside .test)');
  }
  const started = await db.select({ id: users.id }).from(users).where(eq(users.email, MARKER_EMAIL));
  if (started.length > 0) {
    const finished = await db.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.label, LAST_VEHICLE));
    if (finished.length === 0) {
      throw new Error('this database was only partly seeded (an earlier run stopped). Reset it and run again: see docs/STAGING.md');
    }
    logger.info('staging seed already applied — nothing to do');
    return { skipped: true, volunteers: 0, trips: 0, loans: 0 };
  }

  await seedDevelopment();
  const rand = rng(20261001);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const groups = await db.select().from(volunteerGroups);
  const bySlug = new Map(groups.map((g) => [g.slug, g]));
  const passwordHash = await hashPassword(STAGING_PASSWORD);

  // --- people ---------------------------------------------------------------
  const coordinators: string[] = [];
  for (const [i, letter] of ['a', 'b', 'c'].entries()) {
    const [row] = await db.insert(users).values({
      email: `coordinator.${letter}@staging.rvc.test`, fullName: `${FIRST[i]} ${LAST[i]} (coordinator)`,
      role: 'dispatcher', phone: phone(21 + i), status: 'active', passwordHash, notificationPreference: 'push',
    }).returning({ id: users.id });
    coordinators.push(row!.id);
    for (const g of groups) await db.insert(userGroups).values({ userId: row!.id, groupId: g.id }).onConflictDoNothing();
  }

  const volunteers: string[] = [];
  for (let i = 0; i < 40; i++) {
    const first = FIRST[(i * 7) % FIRST.length]!;
    const last = LAST[(i * 3) % LAST.length]!;
    const [row] = await db.insert(users).values({
      email: `volunteer${String(i + 1).padStart(2, '0')}@staging.rvc.test`,
      fullName: `${first} ${last}`, role: 'volunteer', phone: phone(30 + i),
      status: i % 13 === 12 ? 'inactive' : 'active', passwordHash,
      notificationPreference: pick(['sms', 'push', 'both'] as const),
      capabilities: rand() < 0.3 ? [...VOLUNTEER_CAPABILITIES] : [],
    }).returning({ id: users.id });
    volunteers.push(row!.id);
    const slugs = i % 4 === 0 ? ['chaim_vchesed', 'chesed_on_the_go'] : i % 5 === 0 ? ['misamchem'] : ['chesed_on_the_go'];
    for (const slug of slugs) {
      const g = bySlug.get(slug);
      if (g) await db.insert(userGroups).values({ userId: row!.id, groupId: g.id }).onConflictDoNothing();
    }
    // Two or three weekly windows, Sunday to Thursday, mornings or afternoons.
    const days = new Set([Math.floor(rand() * 5), Math.floor(rand() * 5), Math.floor(rand() * 5)]);
    for (const weekday of days) {
      const morning = rand() < 0.5;
      await db.insert(availabilityRules).values({
        userId: row!.id, weekday, startMinute: morning ? 8 * 60 : 13 * 60, endMinute: morning ? 12 * 60 : 18 * 60,
      }).onConflictDoNothing();
    }
  }

  const callerIds: Array<{ id: string; name: string; phone: string }> = [];
  for (let i = 0; i < 20; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const p = phone(70 + i);
    const [row] = await db.insert(callers).values({
      name, primaryPhone: p, language: i % 3 === 0 ? 'fr' : 'en',
      accessNotes: i % 4 === 0 ? 'Uses a walker; needs help on the stairs.' : null,
      createdById: coordinators[0]!,
    }).onConflictDoNothing().returning({ id: callers.id });
    if (row) callerIds.push({ id: row.id, name, phone: p });
  }

  // --- rides: 60 days back, 7 days ahead -------------------------------------
  const rideGroup = bySlug.get('chesed_on_the_go')!;
  const foodGroup = bySlug.get('chaim_vchesed') ?? rideGroup;
  const active = volunteers.filter((_, i) => i % 13 !== 12);
  const day = 86_400_000;
  let tripCount = 0;
  for (let d = -60; d <= 7; d++) {
    const perDay = d < 0 ? 1 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 2);
    for (let k = 0; k < perDay; k++) {
      const caller = pick(callerIds);
      const when = new Date(Date.now() + d * day);
      when.setUTCHours(12 + Math.floor(rand() * 9), rand() < 0.5 ? 0 : 30, 0, 0);
      const food = rand() < 0.15;
      const [from] = await db.insert(addresses).values({
        line1: `${1000 + Math.floor(rand() * 8000)} ${pick(STREETS)}`, city: 'Montreal', province: 'QC',
      }).returning({ id: addresses.id });
      const dest = pick(DESTINATIONS);
      const [to] = await db.insert(addresses).values({ ...dest, city: 'Montreal', province: 'QC' }).returning({ id: addresses.id });
      const ref = (await db.execute<{ reference: string }>(raw`select next_trip_reference() as reference`))[0]!.reference;

      const roll = rand();
      const past = d < 0;
      const status = past ? (roll < 0.85 ? 'completed' : 'cancelled') : roll < 0.4 ? 'pending' : roll < 0.6 ? 'offered' : 'assigned';
      const volunteer = status === 'completed' || status === 'assigned' ? pick(active) : null;
      const [trip] = await db.insert(trips).values({
        reference: ref, isTest: rand() < 0.04, status,
        tripType: food ? 'hospital_food' : 'ride',
        priority: rand() < 0.1 ? 'urgent' : 'routine',
        groupId: food ? foodGroup.id : rideGroup.id,
        callerId: caller.id, callerName: caller.name, callerPhone: caller.phone,
        pickupAddressId: from!.id, dropoffAddressId: to!.id, pickupAt: when,
        mobilityNeeds: rand() < 0.2 ? ['wheelchair'] : [],
        passengerNotes: 'Synthetic staging data.',
        assignedVolunteerId: volunteer,
        assignedAt: volunteer ? new Date(when.getTime() - 2 * day) : null,
        acceptedAt: volunteer ? new Date(when.getTime() - 2 * day) : null,
        completedAt: status === 'completed' ? new Date(when.getTime() + 3_600_000) : null,
        cancelledAt: status === 'cancelled' ? new Date(when.getTime() - day) : null,
        cancelledById: status === 'cancelled' ? coordinators[0]! : null,
        cancellationReason: status === 'cancelled' ? pick(CANCEL_REASONS) : null,
        createdById: pick(coordinators),
      }).returning({ id: trips.id });
      if (volunteer) {
        await db.insert(tripAssignments).values({
          tripId: trip!.id, volunteerId: volunteer, assignedById: coordinators[0]!, source: 'dispatcher',
          assignedAt: new Date(when.getTime() - 2 * day),
        });
      }
      tripCount++;
    }
  }

  // --- equipment, loans, vehicles, duty --------------------------------------
  const categoryIds: string[] = [];
  for (const name of ['Wheelchairs', 'Walkers', 'Shower chairs', 'Crutches']) {
    const [c] = await db.insert(equipmentCategories).values({ name }).onConflictDoNothing().returning({ id: equipmentCategories.id });
    if (c) categoryIds.push(c.id);
  }
  const items: string[] = [];
  for (let i = 0; i < 24; i++) {
    const [item] = await db.insert(equipment).values({
      categoryId: categoryIds[i % categoryIds.length] ?? null, itemCode: `STG-${String(i + 1).padStart(3, '0')}`,
      equipmentType: ['wheelchair', 'walker', 'shower_chair', 'crutches'][i % 4]!, status: 'available',
      condition: i % 9 === 0 ? 'fair' : 'good',
    }).onConflictDoNothing().returning({ id: equipment.id });
    if (item) items.push(item.id);
  }
  let loans = 0;
  for (let i = 0; i < 10 && i < items.length; i++) {
    const borrower = pick(callerIds);
    const loanedAt = new Date(Date.now() - (5 + i * 6) * day);
    const returned = i >= 6;
    await db.insert(equipmentLoans).values({
      equipmentId: items[i]!, borrowerName: borrower.name, borrowerPhone: borrower.phone,
      loanedById: coordinators[1]!, loanedAt, expectedReturnAt: new Date(loanedAt.getTime() + 21 * day),
      returnedAt: returned ? new Date(loanedAt.getTime() + 14 * day) : null,
      returnedById: returned ? coordinators[1]! : null,
    });
    if (!returned) await db.update(equipment).set({ status: 'loaned' }).where(eq(equipment.id, items[i]!));
    loans++;
  }
  for (let d = 0; d < 7; d++) {
    const start = new Date(Date.now() + d * day);
    start.setUTCHours(12, 0, 0, 0);
    await db.insert(dutyShifts).values({
      kind: 'phone', userId: coordinators[d % coordinators.length]!, startsAt: start,
      endsAt: new Date(start.getTime() + 6 * 3_600_000), createdById: coordinators[0]!,
    });
  }

  await backfillServiceOptIns();
  // Vehicles last: LAST_VEHICLE marks a finished run.
  for (const [label, vehicleType, capacity] of [['Staging van 1', 'wheelchair_van', 4], ['Staging car 1', 'standard', 3], ['Staging car 2', 'standard', 3]] as const) {
    await db.insert(vehicles).values({ label, vehicleType, capacity }).onConflictDoNothing();
  }
  logger.info({ volunteers: volunteers.length, trips: tripCount, loans, password: STAGING_PASSWORD },
    'staging seed complete — sign in as coordinator.a@staging.rvc.test or volunteer01@staging.rvc.test');
  return { skipped: false, volunteers: volunteers.length, trips: tripCount, loans };
}

const invokedDirectly = process.argv[1]?.endsWith('seed-staging.ts') || process.argv[1]?.endsWith('seed-staging.js');
if (invokedDirectly) {
  seedStaging().then(async () => { await closeDb(); process.exit(0); })
    .catch(async (err) => { logger.error({ err }, 'staging seed failed'); await closeDb().catch(() => {}); process.exit(1); });
}

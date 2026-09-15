/**
 * The loader: a `MigrationPlan` written to Postgres.
 *
 * ---------------------------------------------------------------------------
 * NOTE ON THE IMPORT BELOW
 *
 * This file imports the drizzle schema from the API workspace by relative path.
 * That is deliberate and it is safe: the dependency points ONE WAY ONLY. The
 * production application has no dependency on tools/migrate — nothing under
 * apps/ or packages/ imports anything from this directory, and this tool is
 * never built, bundled or deployed with the app. It is one-shot operational
 * tooling that must see the exact schema it is loading into, and duplicating
 * the table definitions here would guarantee they drift apart.
 * ---------------------------------------------------------------------------
 *
 * Three properties, in order of importance:
 *
 * 1. ONE TRANSACTION. Everything commits or nothing does. A half-migrated
 *    dispatch database — users without their trips, trips without their
 *    assignments — is worse than no migration at all, because it looks like it
 *    worked.
 *
 * 2. FK-SAFE ORDER. Parents before children throughout: groups -> users ->
 *    user_groups -> addresses -> trips -> trip_assignments, categories ->
 *    equipment -> equipment_loans, and audit/calls last because they reference
 *    everything.
 *
 * 3. IDEMPOTENT. Re-running must not duplicate. Neither `users` nor `trips`
 *    has a metadata column, so the legacy id is recorded in a LEDGER built out
 *    of `audit_events` — the one append-only table with a jsonb `metadata`
 *    column and an (entity_type, entity_id) index. Each imported row gets one
 *    ledger entry:
 *
 *        action      = 'legacy.import'
 *        entity_type = the target table name
 *        entity_id   = the new uuid
 *        metadata    = { legacyEntity, legacyId, ...provenance }
 *
 *    On startup the loader reads every ledger row and builds
 *    `legacyId -> newId`. Anything already present is skipped, not re-inserted.
 *    That makes a re-run after a partial failure, or after fixing a handful of
 *    source records, safe and cheap.
 *
 * `--dry-run` does all of it — including the inserts, so constraint violations
 * surface — and then rolls back.
 */
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../../../apps/api/src/db/schema.js';
import type { MigrationPlan } from './transform/index.js';

const LEDGER_ACTION = 'legacy.import';
const LEDGER_ACTOR = 'base44-migration';

export interface LoadOptions {
  databaseUrl: string;
  dryRun: boolean;
}

export interface LoadResult {
  dryRun: boolean;
  committed: boolean;
  /** Rows actually inserted this run, per target table. */
  inserted: Record<string, number>;
  /** Rows skipped because the ledger already had them (a re-run). */
  alreadyPresent: Record<string, number>;
}

type Db = PostgresJsDatabase<typeof schema>;

/** One ledger entry queued for writing. */
interface LedgerEntry {
  table: string;
  newId: string;
  legacyEntity: string;
  legacyId: string;
  metadata: Record<string, unknown>;
}

export async function load(plan: MigrationPlan, opts: LoadOptions): Promise<LoadResult> {
  const client = postgres(opts.databaseUrl, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema });

  const inserted: Record<string, number> = {};
  const alreadyPresent: Record<string, number> = {};
  const bump = (r: Record<string, number>, k: string, n = 1): void => {
    r[k] = (r[k] ?? 0) + n;
  };

  let committed = false;

  try {
    await db.transaction(async (tx) => {
      // --- Read the ledger --------------------------------------------------
      const existing = await tx
        .select({
          entityType: schema.auditEvents.entityType,
          entityId: schema.auditEvents.entityId,
          metadata: schema.auditEvents.metadata,
        })
        .from(schema.auditEvents)
        .where(sql`${schema.auditEvents.action} = ${LEDGER_ACTION}`);

      /** `${table}:${legacyId}` -> new uuid */
      const ledger = new Map<string, string>();
      for (const row of existing) {
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        const legacyId = meta['legacyId'];
        if (typeof legacyId === 'string') {
          ledger.set(`${row.entityType}:${legacyId}`, row.entityId);
        }
      }

      const pending: LedgerEntry[] = [];
      const seen = (table: string, legacyId: string): string | undefined =>
        ledger.get(`${table}:${legacyId}`);
      const record = (
        table: string,
        newId: string,
        legacyEntity: string,
        legacyId: string,
        metadata: Record<string, unknown> = {},
      ): void => {
        ledger.set(`${table}:${legacyId}`, newId);
        pending.push({ table, newId, legacyEntity, legacyId, metadata });
      };

      // === 1. volunteer_groups ============================================
      const groupIdBySlug = new Map<string, string>();
      const liveGroups = await tx
        .select({ id: schema.volunteerGroups.id, slug: schema.volunteerGroups.slug })
        .from(schema.volunteerGroups);
      for (const g of liveGroups) groupIdBySlug.set(g.slug, g.id);

      for (const g of plan.groups) {
        if (groupIdBySlug.has(g.slug)) {
          bump(alreadyPresent, 'volunteer_groups');
          continue;
        }
        const [row] = await tx
          .insert(schema.volunteerGroups)
          .values({ slug: g.slug, name: g.name, active: g.active })
          .returning({ id: schema.volunteerGroups.id });
        groupIdBySlug.set(g.slug, row!.id);
        bump(inserted, 'volunteer_groups');
        record('volunteer_groups', row!.id, 'VolunteerGroup', g.legacyId, { slug: g.slug });
      }

      // === 2. users =======================================================
      //
      // Keyed on the merged person's legacy id. Note that one users row may
      // stand for up to three legacy rows; the ledger records all of them via
      // the `legacyMeta` so a re-run recognises any of the three.
      const userIdByKey = new Map<string, string>();

      for (const u of plan.users) {
        const priorId = seen('users', u.legacyId);
        if (priorId !== undefined) {
          userIdByKey.set(u.email, priorId);
          bump(alreadyPresent, 'users');
          continue;
        }

        const [row] = await tx
          .insert(schema.users)
          .values({
            email: u.email,
            fullName: u.fullName,
            phone: u.phone,
            role: u.role,
            status: u.status,
            notificationPreference: u.notificationPreference,
            preferredVehicleType: u.preferredVehicleType,
            photoUrl: u.photoUrl,
            addressLine: u.addressLine,
            emergencyContactName: u.emergencyContactName,
            emergencyContactPhone: u.emergencyContactPhone,
            availability: u.availability,
            // Imported users have no password: the legacy system used Base44's
            // hosted auth, whose credentials we neither have nor want.
            passwordHash: null,
            mustChangePassword: true,
            ...(u.createdAt !== null ? { createdAt: u.createdAt } : {}),
          })
          .returning({ id: schema.users.id });

        userIdByKey.set(u.email, row!.id);
        bump(inserted, 'users');
        record('users', row!.id, 'User', u.legacyId, { ...u.legacyMeta, email: u.email });

        // Alias every contributing legacy id so a re-run matches whichever one
        // it looks up.
        const meta = u.legacyMeta ?? {};
        for (const alias of [
          ...(Array.isArray(meta['legacyVolunteerIds']) ? meta['legacyVolunteerIds'] : []),
          ...(Array.isArray(meta['legacyDirectoryIds']) ? meta['legacyDirectoryIds'] : []),
        ]) {
          if (typeof alias === 'string' && alias !== u.legacyId) {
            record('users', row!.id, 'User', alias, { aliasOf: u.legacyId });
          }
        }
      }

      // === 3. user_groups =================================================
      for (const u of plan.users) {
        const userId = userIdByKey.get(u.email);
        if (userId === undefined) continue;
        for (const slug of u.groupSlugs) {
          const groupId = groupIdBySlug.get(slug);
          if (groupId === undefined) continue;
          const res = await tx
            .insert(schema.userGroups)
            .values({ userId, groupId })
            .onConflictDoNothing()
            .returning({ userId: schema.userGroups.userId });
          if (res.length > 0) bump(inserted, 'user_groups');
          else bump(alreadyPresent, 'user_groups');
        }
      }

      // === 4. addresses ===================================================
      const addressIdByKey = new Map<string, string>();
      for (const a of plan.addresses) {
        const priorId = seen('addresses', a.key);
        if (priorId !== undefined) {
          addressIdByKey.set(a.key, priorId);
          bump(alreadyPresent, 'addresses');
          continue;
        }
        const [row] = await tx
          .insert(schema.addresses)
          .values({
            line1: a.line1,
            unit: a.unit,
            city: a.city,
            province: a.province,
            postalCode: a.postalCode,
            notes: a.notes,
          })
          .returning({ id: schema.addresses.id });
        addressIdByKey.set(a.key, row!.id);
        bump(inserted, 'addresses');
        record('addresses', row!.id, 'TripAddress', a.key, { side: a.key.split(':')[1] });
      }

      // === 5. trips =======================================================
      const tripIdByLegacy = new Map<string, string>();
      for (const t of plan.trips) {
        const priorId = seen('trips', t.legacyId);
        if (priorId !== undefined) {
          tripIdByLegacy.set(t.legacyId, priorId);
          bump(alreadyPresent, 'trips');
          continue;
        }

        const pickupId = addressIdByKey.get(t.pickupAddressKey);
        const dropoffId = addressIdByKey.get(t.dropoffAddressKey);
        if (pickupId === undefined || dropoffId === undefined) {
          throw new Error(
            `Internal error: trip ${t.legacyId} references an address key that was not inserted ` +
              `(${t.pickupAddressKey} / ${t.dropoffAddressKey}). Aborting; nothing is committed.`,
          );
        }
        const groupId = groupIdBySlug.get(t.groupSlug);
        if (groupId === undefined) {
          throw new Error(
            `Internal error: trip ${t.legacyId} references group '${t.groupSlug}' which was not ` +
              `created. Aborting; nothing is committed.`,
          );
        }

        const [row] = await tx
          .insert(schema.trips)
          .values({
            reference: t.reference,
            status: t.status,
            priority: t.priority,
            tripType: t.tripType,
            assignmentMode: t.assignmentMode,
            groupId,
            callerName: t.callerName,
            callerPhone: t.callerPhone,
            pickupAddressId: pickupId,
            dropoffAddressId: dropoffId,
            pickupAt: t.pickupAt,
            mobilityNeeds: t.mobilityNeeds,
            passengerNotes: t.passengerNotes,
            assignedVolunteerId:
              t.assignedVolunteerKey !== null
                ? (userIdByKey.get(t.assignedVolunteerKey) ?? null)
                : null,
            assignedAt: t.assignedAt,
            acceptedAt: t.acceptedAt,
            completedAt: t.completedAt,
            cancelledAt: t.cancelledAt,
            cancelledById:
              t.cancelledByKey !== null ? (userIdByKey.get(t.cancelledByKey) ?? null) : null,
            cancellationReason: t.cancellationReason,
            ...(t.createdAt !== null ? { createdAt: t.createdAt } : {}),
          })
          .returning({ id: schema.trips.id });

        tripIdByLegacy.set(t.legacyId, row!.id);
        bump(inserted, 'trips');
        record('trips', row!.id, 'Trip', t.legacyId, { ...t.legacyMeta, reference: t.reference });
      }

      // === 6. trip_assignments ============================================
      for (const a of plan.tripAssignments) {
        if (seen('trip_assignments', a.legacyId) !== undefined) {
          bump(alreadyPresent, 'trip_assignments');
          continue;
        }
        const tripId = tripIdByLegacy.get(a.tripLegacyId);
        const volunteerId = userIdByKey.get(a.volunteerKey);
        if (tripId === undefined || volunteerId === undefined) continue;

        const [row] = await tx
          .insert(schema.tripAssignments)
          .values({
            tripId,
            volunteerId,
            source: a.source,
            assignedAt: a.assignedAt,
            unassignedAt: a.unassignedAt,
            unassignedReason: a.unassignedReason,
          })
          .returning({ id: schema.tripAssignments.id });
        bump(inserted, 'trip_assignments');
        record('trip_assignments', row!.id, 'TripAssignment', a.legacyId, a.legacyMeta ?? {});
      }

      // === 7. contacts ====================================================
      for (const c of plan.contacts) {
        if (seen('contacts', c.legacyId) !== undefined) {
          bump(alreadyPresent, 'contacts');
          continue;
        }
        const [row] = await tx
          .insert(schema.contacts)
          .values({
            name: c.name,
            phone: c.phone,
            role: c.role,
            notes: c.notes,
            ...(c.createdAt !== null ? { createdAt: c.createdAt } : {}),
          })
          .returning({ id: schema.contacts.id });
        bump(inserted, 'contacts');
        record('contacts', row!.id, 'Contact', c.legacyId, c.legacyMeta ?? {});
      }

      // === 8. vehicles ====================================================
      for (const v of plan.vehicles) {
        if (seen('vehicles', v.legacyId) !== undefined) {
          bump(alreadyPresent, 'vehicles');
          continue;
        }
        const [row] = await tx
          .insert(schema.vehicles)
          .values({
            label: v.label,
            vehicleType: v.vehicleType,
            plate: v.plate,
            capacity: v.capacity,
            status: v.status,
            notes: v.notes,
            lastMaintenanceAt: v.lastMaintenanceAt,
            nextMaintenanceAt: v.nextMaintenanceAt,
            ...(v.createdAt !== null ? { createdAt: v.createdAt } : {}),
          })
          .returning({ id: schema.vehicles.id });
        bump(inserted, 'vehicles');
        record('vehicles', row!.id, 'Vehicle', v.legacyId, v.legacyMeta ?? {});
      }

      // === 9. equipment_categories ========================================
      const categoryIdByLegacy = new Map<string, string>();
      for (const c of plan.equipmentCategories) {
        const priorId = seen('equipment_categories', c.legacyId);
        if (priorId !== undefined) {
          categoryIdByLegacy.set(c.legacyId, priorId);
          bump(alreadyPresent, 'equipment_categories');
          continue;
        }
        const [row] = await tx
          .insert(schema.equipmentCategories)
          .values({
            name: c.name,
            description: c.description,
            ...(c.createdAt !== null ? { createdAt: c.createdAt } : {}),
          })
          .returning({ id: schema.equipmentCategories.id });
        categoryIdByLegacy.set(c.legacyId, row!.id);
        bump(inserted, 'equipment_categories');
        record('equipment_categories', row!.id, 'EquipmentCategory', c.legacyId, c.legacyMeta ?? {});
      }

      // === 10. equipment ==================================================
      const equipmentIdByLegacy = new Map<string, string>();
      for (const e of plan.equipment) {
        const priorId = seen('equipment', e.legacyId);
        if (priorId !== undefined) {
          equipmentIdByLegacy.set(e.legacyId, priorId);
          bump(alreadyPresent, 'equipment');
          continue;
        }
        const [row] = await tx
          .insert(schema.equipment)
          .values({
            categoryId:
              e.categoryLegacyId !== null
                ? (categoryIdByLegacy.get(e.categoryLegacyId) ?? null)
                : null,
            itemCode: e.itemCode,
            barcode: e.barcode,
            equipmentType: e.equipmentType,
            status: e.status,
            condition: e.condition,
            notes: e.notes,
            ...(e.createdAt !== null ? { createdAt: e.createdAt } : {}),
          })
          .returning({ id: schema.equipment.id });
        equipmentIdByLegacy.set(e.legacyId, row!.id);
        bump(inserted, 'equipment');
        record('equipment', row!.id, 'Equipment', e.legacyId, e.legacyMeta ?? {});
      }

      // === 11. equipment_loans ============================================
      for (const l of plan.equipmentLoans) {
        if (seen('equipment_loans', l.legacyId) !== undefined) {
          bump(alreadyPresent, 'equipment_loans');
          continue;
        }
        const equipmentId = equipmentIdByLegacy.get(l.equipmentLegacyId);
        if (equipmentId === undefined) continue;
        const [row] = await tx
          .insert(schema.equipmentLoans)
          .values({
            equipmentId,
            borrowerName: l.borrowerName,
            borrowerPhone: l.borrowerPhone,
            borrowerAddress: l.borrowerAddress,
            loanedAt: l.loanedAt,
            expectedReturnAt: l.expectedReturnAt,
            returnedAt: l.returnedAt,
            notes: l.notes,
          })
          .returning({ id: schema.equipmentLoans.id });
        bump(inserted, 'equipment_loans');
        record('equipment_loans', row!.id, 'EquipmentLoan', l.legacyId, l.legacyMeta ?? {});
      }

      // === 12. calls ======================================================
      for (const c of plan.calls) {
        if (seen('calls', c.legacyId) !== undefined) {
          bump(alreadyPresent, 'calls');
          continue;
        }
        const initiatedById = userIdByKey.get(c.initiatedByKey);
        if (initiatedById === undefined) continue;
        const [row] = await tx
          .insert(schema.calls)
          .values({
            initiatedById,
            tripId:
              c.tripLegacyId !== null ? (tripIdByLegacy.get(c.tripLegacyId) ?? null) : null,
            direction: c.direction,
            counterpartyType: c.counterpartyType,
            counterpartyUserId:
              c.counterpartyUserKey !== null
                ? (userIdByKey.get(c.counterpartyUserKey) ?? null)
                : null,
            destinationLast4: c.destinationLast4,
            counterpartyName: c.counterpartyName,
            failureReason: c.failureReason,
            providerSid: c.providerSid,
            status: c.status,
            durationSeconds: c.durationSeconds,
            authorizationBasis: c.authorizationBasis,
            errorMessage: c.errorMessage,
            startedAt: c.startedAt,
            endedAt: c.endedAt,
          })
          .returning({ id: schema.calls.id });
        bump(inserted, 'calls');
        record('calls', row!.id, 'MaskedCall', c.legacyId, c.legacyMeta ?? {});
      }

      // === 13. settings (text templates) ==================================
      for (const s of plan.settings) {
        const res = await tx
          .insert(schema.settings)
          .values({ key: s.key, value: s.value as never, description: s.description })
          .onConflictDoNothing()
          .returning({ key: schema.settings.key });
        if (res.length > 0) {
          bump(inserted, 'settings');
          record('settings', s.key, 'TextTemplate', s.legacyId, s.legacyMeta ?? {});
        } else {
          bump(alreadyPresent, 'settings');
        }
      }

      // === 14. organization_info ==========================================
      if (plan.organizationInfo !== null) {
        const o = plan.organizationInfo;
        if (seen('organization_info', o.legacyId) !== undefined) {
          bump(alreadyPresent, 'organization_info');
        } else {
          const [row] = await tx
            .insert(schema.organizationInfo)
            .values({
              name: o.name,
              phone: o.phone,
              email: o.email,
              website: o.website,
              addressLine: o.addressLine,
              emergencyContact: o.emergencyContact,
              details: o.details,
            })
            .returning({ id: schema.organizationInfo.id });
          bump(inserted, 'organization_info');
          record('organization_info', row!.id, 'OrganizationInfo', o.legacyId, {});
        }
      }

      // === 15. audit_events (legacy, client-asserted) =====================
      //
      // Last, because they reference every other entity by id. Imported with
      // actorRole 'system' and actorUserId NULL — see transform/audit.ts.
      for (const a of plan.auditEvents) {
        if (seen('audit_events', a.legacyId) !== undefined) {
          bump(alreadyPresent, 'audit_events');
          continue;
        }
        const [row] = await tx
          .insert(schema.auditEvents)
          .values({
            occurredAt: a.occurredAt,
            actorUserId: null,
            actorName: a.actorName,
            actorRole: a.actorRole,
            action: a.action,
            entityType: a.entityType,
            entityId: a.entityId,
            previous: a.previous,
            next: a.next,
            metadata: a.metadata,
            ip: a.ip,
          })
          .returning({ id: schema.auditEvents.id });
        bump(inserted, 'audit_events');
        record('audit_events', row!.id, 'AuditLog', a.legacyId, a.legacyMeta ?? {});
      }

      // === 16. the ledger itself ==========================================
      //
      // Written last so that a failure anywhere above leaves no ledger entries
      // claiming rows that were rolled back. (The whole thing is one
      // transaction, so this is belt and braces — but the ordering also means
      // the ledger is trivially readable as "what this run did".)
      if (pending.length > 0) {
        await tx.insert(schema.auditEvents).values(
          pending.map((p) => ({
            occurredAt: new Date(),
            actorUserId: null,
            actorName: LEDGER_ACTOR,
            actorRole: 'system',
            action: LEDGER_ACTION,
            entityType: p.table,
            entityId: p.newId,
            metadata: {
              source: 'base44',
              legacyEntity: p.legacyEntity,
              legacyId: p.legacyId,
              ...p.metadata,
            },
          })),
        );
        bump(inserted, 'audit_events(ledger)', pending.length);
      }

      if (opts.dryRun) {
        // Everything above ran against the database — constraints, unique
        // indexes and foreign keys were all genuinely exercised — and is now
        // thrown away.
        throw new DryRunRollback();
      }
    });

    committed = !opts.dryRun;
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
    committed = false;
  } finally {
    await client.end({ timeout: 5 });
  }

  return { dryRun: opts.dryRun, committed, inserted, alreadyPresent };
}

/** Sentinel used to roll back a dry run without reporting it as a failure. */
class DryRunRollback extends Error {
  constructor() {
    super('dry run: rolling back');
    this.name = 'DryRunRollback';
  }
}

export { DryRunRollback };

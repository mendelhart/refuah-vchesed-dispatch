import { and, desc, eq, isNull, or, sql as raw } from 'drizzle-orm';
import { ADDRESS_LABELS } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { addresses, callerAddresses, callers, trips } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { normalizePhone } from '../lib/phone.js';

/**
 * The caller directory.
 *
 * Roughly a third of this organisation's rides are for people who have called
 * before — dialysis three times a week, a weekly oncology appointment, an
 * elderly parent whose daughter always rings. The legacy application asked for
 * the name, the number, the pickup address, the entrance and the parking every
 * single time, which is slow on the phone and gets a detail wrong eventually.
 *
 * Privacy shape: this is dispatcher-and-above data. A volunteer never queries
 * it; what they see about a caller comes from the trip they have been given,
 * and only after they have claimed it. Every lookup is audited, because a
 * searchable directory of vulnerable people's addresses is exactly the kind of
 * thing that should leave a trail.
 */

export interface CallerSearchResult {
  id: string;
  name: string;
  primaryPhone: string | null;
  alternatePhone: string | null;
  language: string;
  notes: string | null;
  accessNotes: string | null;
  tripCount: number;
  lastTripAt: Date | null;
}

/**
 * Find a caller by phone number or name.
 *
 * Phone matching is exact E.164 after normalisation, so a dispatcher can type
 * `514 555 0142`, `5145550142` or `+15145550142` and get the same row — but a
 * number that merely ends in the same digits is not a match.
 */
export async function searchCallers(
  actor: AuditActor,
  query: string,
  limit = 10,
): Promise<CallerSearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];
  const phone = normalizePhone(term);

  const rows = (await db.execute(raw`
    select c.id, c.name, c.primary_phone, c.alternate_phone, c.language,
           c.notes, c.access_notes,
           count(t.id) filter (where t.deleted_at is null)::int as trip_count,
           max(t.pickup_at) as last_trip_at
    from callers c
    left join trips t on t.caller_id = c.id
    where c.deleted_at is null
      and c.status = 'active'
      and (
        (${phone}::text is not null and (c.primary_phone = ${phone} or c.alternate_phone = ${phone}))
        or c.name ilike ${'%' + term + '%'}
        or regexp_replace(coalesce(c.primary_phone, ''), '\\D', '', 'g') like ${'%' + term.replace(/\D/g, '') + '%'}
      )
    group by c.id
    order by max(t.pickup_at) desc nulls last, c.name
    limit ${limit}
  `)) as unknown as Array<{
    id: string;
    name: string;
    primary_phone: string | null;
    alternate_phone: string | null;
    language: string;
    notes: string | null;
    access_notes: string | null;
    trip_count: number;
    last_trip_at: Date | null;
  }>;

  if (rows.length) {
    await recordAudit({
      actor,
      action: 'caller.searched',
      entityType: 'caller',
      entityId: 'search',
      metadata: { query: term.slice(0, 60), matches: rows.length },
    });
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    primaryPhone: r.primary_phone,
    alternatePhone: r.alternate_phone,
    language: r.language,
    notes: r.notes,
    accessNotes: r.access_notes,
    tripCount: Number(r.trip_count),
    lastTripAt: r.last_trip_at ? new Date(r.last_trip_at) : null,
  }));
}

/**
 * Everything the dispatcher needs when a repeat caller rings: who they are,
 * where they usually go, and what happened last time.
 */
export async function getCallerProfile(actor: AuditActor, callerId: string) {
  const [caller] = await db
    .select()
    .from(callers)
    .where(and(eq(callers.id, callerId), isNull(callers.deletedAt)))
    .limit(1);
  if (!caller) throw Errors.notFound('That caller is no longer on file.');

  const savedAddresses = await db
    .select({
      id: callerAddresses.id,
      label: callerAddresses.label,
      entrance: callerAddresses.entrance,
      parking: callerAddresses.parking,
      isDefaultPickup: callerAddresses.isDefaultPickup,
      useCount: callerAddresses.useCount,
      lastUsedAt: callerAddresses.lastUsedAt,
      address: {
        id: addresses.id,
        line1: addresses.line1,
        unit: addresses.unit,
        city: addresses.city,
        province: addresses.province,
        postalCode: addresses.postalCode,
        notes: addresses.notes,
        latitude: addresses.latitude,
        longitude: addresses.longitude,
      },
    })
    .from(callerAddresses)
    .innerJoin(addresses, eq(addresses.id, callerAddresses.addressId))
    .where(and(eq(callerAddresses.callerId, callerId), isNull(callerAddresses.deletedAt)))
    .orderBy(desc(callerAddresses.useCount), desc(callerAddresses.lastUsedAt));

  const history = (await db.execute(raw`
    select t.id, t.reference, t.status, t.pickup_at, t.trip_type, t.priority,
           t.mobility_needs,
           pa.line1 as pickup_line1, pa.city as pickup_city,
           da.line1 as dropoff_line1, da.city as dropoff_city,
           u.full_name as volunteer_name
    from trips t
    join addresses pa on pa.id = t.pickup_address_id
    join addresses da on da.id = t.dropoff_address_id
    left join users u on u.id = t.assigned_volunteer_id
    where t.caller_id = ${callerId}::uuid and t.deleted_at is null
    order by t.pickup_at desc
    limit 25
  `)) as unknown as Array<Record<string, unknown>>;

  await recordAudit({
    actor,
    action: 'caller.viewed',
    entityType: 'caller',
    entityId: callerId,
    metadata: { name: caller.name },
  });

  return { caller, addresses: savedAddresses, history };
}

export async function listCallers(limit = 100, offset = 0): Promise<CallerSearchResult[]> {
  // The same shape as searchCallers, so the directory and the search results
  // render through one component rather than two that drift apart.
  const rows = (await db.execute(raw`
    select c.id, c.name, c.primary_phone, c.alternate_phone, c.language,
           c.notes, c.access_notes,
           count(t.id) filter (where t.deleted_at is null)::int as trip_count,
           max(t.pickup_at) as last_trip_at
      from callers c
      left join trips t on t.caller_id = c.id
     where c.deleted_at is null and c.status = 'active'
     group by c.id
     order by c.name
     limit ${limit} offset ${offset}
  `)) as unknown as Array<{
    id: string; name: string; primary_phone: string | null; alternate_phone: string | null;
    language: string; notes: string | null; access_notes: string | null;
    trip_count: number; last_trip_at: Date | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    primaryPhone: r.primary_phone,
    alternatePhone: r.alternate_phone,
    language: r.language,
    notes: r.notes,
    accessNotes: r.access_notes,
    tripCount: Number(r.trip_count),
    lastTripAt: r.last_trip_at ? new Date(r.last_trip_at) : null,
  }));
}

export async function createCaller(
  actor: AuditActor,
  input: {
    name: string;
    primaryPhone?: string | null;
    alternatePhone?: string | null;
    email?: string | null;
    language?: string;
    notes?: string | null;
    accessNotes?: string | null;
  },
) {
  const primaryPhone = normalizePhone(input.primaryPhone);
  const alternatePhone = normalizePhone(input.alternatePhone);
  if (!input.name.trim()) throw Errors.validation('A caller needs a name.');

  if (primaryPhone) {
    const [clash] = await db
      .select({ id: callers.id, name: callers.name })
      .from(callers)
      .where(
        and(
          isNull(callers.deletedAt),
          or(eq(callers.primaryPhone, primaryPhone), eq(callers.alternatePhone, primaryPhone)),
        ),
      )
      .limit(1);
    if (clash) {
      throw Errors.conflict(`That number is already on file for ${clash.name}.`, {
        existingCallerId: clash.id,
      });
    }
  }

  const [row] = await db
    .insert(callers)
    .values({
      name: input.name.trim(),
      primaryPhone,
      alternatePhone,
      email: input.email ?? null,
      language: input.language ?? 'en',
      notes: input.notes ?? null,
      accessNotes: input.accessNotes ?? null,
      createdById: actor.userId,
    })
    .returning();

  await recordAudit({
    actor,
    action: 'caller.created',
    entityType: 'caller',
    entityId: row!.id,
    next: { name: row!.name },
  });
  return row!;
}

export async function updateCaller(
  actor: AuditActor,
  callerId: string,
  patch: Record<string, unknown>,
) {
  const [before] = await db.select().from(callers).where(eq(callers.id, callerId)).limit(1);
  if (!before) throw Errors.notFound('That caller is no longer on file.');

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if ('name' in patch && typeof patch.name === 'string' && patch.name.trim()) set.name = patch.name.trim();
  if ('primaryPhone' in patch) set.primaryPhone = normalizePhone(patch.primaryPhone as string);
  if ('alternatePhone' in patch) set.alternatePhone = normalizePhone(patch.alternatePhone as string);
  if ('email' in patch) set.email = patch.email ?? null;
  if ('language' in patch) set.language = patch.language;
  if ('notes' in patch) set.notes = patch.notes ?? null;
  if ('accessNotes' in patch) set.accessNotes = patch.accessNotes ?? null;
  if ('status' in patch) set.status = patch.status;

  const [after] = await db.update(callers).set(set).where(eq(callers.id, callerId)).returning();
  await recordAudit({
    actor,
    action: 'caller.updated',
    entityType: 'caller',
    entityId: callerId,
    previous: { name: before.name, notes: before.notes, accessNotes: before.accessNotes },
    next: { name: after!.name, notes: after!.notes, accessNotes: after!.accessNotes },
    metadata: { fields: Object.keys(set) },
  });
  return after!;
}

/** Saves an address against a caller so the next call is a click. */
export async function saveCallerAddress(
  actor: AuditActor,
  callerId: string,
  input: {
    line1: string;
    unit?: string | null;
    city?: string;
    province?: string;
    postalCode?: string | null;
    notes?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    label?: string;
    entrance?: string | null;
    parking?: string | null;
    isDefaultPickup?: boolean;
  },
) {
  if (input.label && !ADDRESS_LABELS.includes(input.label as never)) {
    throw Errors.validation(`label must be one of: ${ADDRESS_LABELS.join(', ')}`);
  }
  return db.transaction(async (tx) => {
    const [address] = await tx
      .insert(addresses)
      .values({
        line1: input.line1,
        unit: input.unit ?? null,
        city: input.city ?? 'Montreal',
        province: input.province ?? 'QC',
        postalCode: input.postalCode ?? null,
        notes: input.notes ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      })
      .returning();

    if (input.isDefaultPickup) {
      // The partial unique index allows exactly one default; clear the old one
      // first rather than letting the insert fail.
      await tx
        .update(callerAddresses)
        .set({ isDefaultPickup: false })
        .where(eq(callerAddresses.callerId, callerId));
    }

    const [row] = await tx
      .insert(callerAddresses)
      .values({
        callerId,
        addressId: address!.id,
        label: input.label ?? 'home',
        entrance: input.entrance ?? null,
        parking: input.parking ?? null,
        isDefaultPickup: input.isDefaultPickup ?? false,
      })
      .returning();

    await recordAudit(
      {
        actor,
        action: 'caller.address_saved',
        entityType: 'caller',
        entityId: callerId,
        next: { label: row!.label, city: address!.city },
      },
      tx,
    );
    return { ...row!, address: address! };
  });
}

export async function removeCallerAddress(actor: AuditActor, callerId: string, id: string) {
  const updated = await db
    .update(callerAddresses)
    .set({ deletedAt: new Date(), isDefaultPickup: false })
    .where(and(eq(callerAddresses.id, id), eq(callerAddresses.callerId, callerId)))
    .returning({ id: callerAddresses.id });
  if (!updated.length) throw Errors.notFound('That address is not on file for this caller.');
  await recordAudit({
    actor,
    action: 'caller.address_removed',
    entityType: 'caller',
    entityId: callerId,
    previous: { callerAddressId: id },
  });
}

/** Resolves an inbound phone number to a caller, for the SMS console. */
export async function callerByPhone(phone: string, exec: Executor = db) {
  const [row] = await exec
    .select()
    .from(callers)
    .where(
      and(
        isNull(callers.deletedAt),
        or(eq(callers.primaryPhone, phone), eq(callers.alternatePhone, phone)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Count of completed trips, used on the caller card. */
export async function callerTripCount(callerId: string): Promise<number> {
  const [row] = await db
    .select({ n: raw<number>`count(*)::int` })
    .from(trips)
    .where(and(eq(trips.callerId, callerId), isNull(trips.deletedAt)));
  return row?.n ?? 0;
}

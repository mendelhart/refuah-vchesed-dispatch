import { createHash } from 'node:crypto';
import { sql as raw } from 'drizzle-orm';
import type { z } from 'zod';
import type { createLiftAssistSchema, createPackageSchema } from '@rvc/shared';
import { LIFT_ASSIST_MAX_AUDIENCE } from '@rvc/shared';
import { db } from '../db/client.js';
import type { AuthenticatedUser } from '../auth/session.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { Errors } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { localMinuteOfDay, localWeekday } from '../lib/time.js';
import { notify } from '../services/notification.service.js';
import { createTrip, type TripActor } from './dispatch.service.js';

/**
 * Item 6: package deliveries and lift assist.
 *
 * A package delivery is an ordinary trip of the existing 'equipment_delivery'
 * type with the package described alongside, so offers, claiming and the
 * driver's view all work unchanged, and no existing constraint changes.
 *
 * Lift assist asks a few chosen volunteers to help lift or carry: the people
 * come from those who offered to help with lifting, are free at that time and
 * (optionally) live in the area; the coordinator sees every name and the
 * count before anything is sent, sends once, and it closes when enough have
 * said yes. Never more than 20 people; never 'everyone'.
 */

const isStaff = (u: AuthenticatedUser) => u.role === 'dispatcher' || u.role === 'admin';

// --- packages ------------------------------------------------------------------

export async function createPackageDelivery(actor: TripActor, input: z.infer<typeof createPackageSchema>): Promise<string> {
  return db.transaction(async (tx) => {
    const t = input.trip;
    const trip = await createTrip(actor, {
      isTest: t.isTest, callerId: t.callerId ?? null, callerName: t.callerName ?? null, callerPhone: t.callerPhone ?? null,
      callbackNumber: t.callbackNumber ?? null, pickup: t.pickup, dropoff: t.dropoff,
      pickupEntrance: t.pickupEntrance ?? null, pickupParking: t.pickupParking ?? null,
      dropoffEntrance: t.dropoffEntrance ?? null, dropoffParking: t.dropoffParking ?? null,
      pickupAt: t.pickupAt, appointmentAt: t.appointmentAt ?? null,
      tripType: 'equipment_delivery', priority: t.priority, groupSlug: t.groupSlug, assignmentMode: t.assignmentMode,
      mobilityNeeds: [], passengerNotes: t.passengerNotes ?? null,
    }, tx);
    const p = input.package;
    await tx.execute(raw`
      insert into trip_packages (trip_id, description, size, weight_kg, recipient_name, recipient_phone, handling_notes)
      values (${trip.id}, ${p.description}, ${p.size}, ${p.weightKg ?? null}, ${p.recipientName},
              ${normalizePhone(p.recipientPhone ?? null)}, ${p.handlingNotes ?? null})`);
    await recordAudit({ actor: actor.audit, action: 'package.created', entityType: 'trip', entityId: trip.id, next: { description: p.description, size: p.size } }, tx);
    return trip.id;
  });
}

type PackageRow = {
  description: string; size: string; weight_kg: string | null; recipient_name: string; recipient_phone: string | null;
  handling_notes: string | null; delivered_at: Date | null; received_by: string | null; delivery_note: string | null;
  assigned: string | null;
};

/** The package on a trip, for a coordinator or the trip's own driver. */
export async function getPackage(user: AuthenticatedUser, tripId: string) {
  const [p] = await db.execute<PackageRow>(raw`
    select p.*, t.assigned_volunteer_id as assigned from trip_packages p join trips t on t.id = p.trip_id where p.trip_id = ${tripId}`);
  if (!p || (!isStaff(user) && p.assigned !== user.id)) return null;
  return {
    description: p.description, size: p.size, weightKg: p.weight_kg === null ? null : Number(p.weight_kg),
    recipientName: p.recipient_name, recipientPhone: p.recipient_phone, handlingNotes: p.handling_notes,
    deliveredAt: p.delivered_at ? new Date(p.delivered_at).toISOString() : null, receivedBy: p.received_by, deliveryNote: p.delivery_note,
  };
}

/** Proof of delivery: who took it, when, by whom. Once. */
export async function recordDelivery(actor: AuditActor, user: AuthenticatedUser, tripId: string, receivedBy: string, note: string | null) {
  return db.transaction(async (tx) => {
    const [p] = await tx.execute<{ delivered_at: Date | null; assigned: string | null; status: string }>(raw`
      select p.delivered_at, t.assigned_volunteer_id as assigned, t.status
        from trip_packages p join trips t on t.id = p.trip_id where p.trip_id = ${tripId} for update of p`);
    if (!p || (!isStaff(user) && p.assigned !== user.id)) throw Errors.notFound('Package');
    if (p.delivered_at) throw Errors.conflict('This package is already marked delivered.');
    if (!['accepted', 'assigned', 'en_route', 'in_progress', 'completed'].includes(p.status)) {
      throw Errors.conflict('A driver must have this delivery before it can be marked delivered.');
    }
    await tx.execute(raw`
      update trip_packages set delivered_at = now(), received_by = ${receivedBy}, delivery_note = ${note}, delivered_by_id = ${user.id}
       where trip_id = ${tripId}`);
    await recordAudit({ actor, action: 'package.delivered', entityType: 'trip', entityId: tripId, next: { receivedBy } }, tx);
  });
}

// --- lift assist ---------------------------------------------------------------------

export async function setLiftHelper(actor: AuditActor, userId: string, willing: boolean) {
  if (willing) await db.execute(raw`insert into lift_assist_helpers (user_id) values (${userId}) on conflict do nothing`);
  else await db.execute(raw`delete from lift_assist_helpers where user_id = ${userId}`);
  await recordAudit({ actor, action: willing ? 'lift_assist.helper_on' : 'lift_assist.helper_off', entityType: 'user', entityId: userId });
}

export async function isLiftHelper(userId: string): Promise<boolean> {
  return (await db.execute(raw`select 1 from lift_assist_helpers where user_id = ${userId}`)).length > 0;
}

export async function createLiftAssist(actor: AuditActor, r: z.infer<typeof createLiftAssistSchema>) {
  const [row] = await db.execute<{ id: string }>(raw`
    insert into lift_assist_requests (title, location, starts_at, duration_minutes, needed, area, notes, created_by_id)
    values (${r.title}, ${r.location}, ${r.startsAt.toISOString()}::timestamptz, ${r.durationMinutes}, ${r.needed},
            ${r.area ?? null}, ${r.notes ?? null}, ${actor.userId}) returning id`);
  await recordAudit({ actor, action: 'lift_assist.created', entityType: 'lift_assist', entityId: row!.id, next: { title: r.title, needed: r.needed } });
  return row!.id;
}

type RequestRow = {
  id: string; title: string; location: string; starts_at: Date; duration_minutes: number; needed: number;
  area: string | null; notes: string | null; status: string; lead_user_id: string | null;
};

async function loadRequest(id: string): Promise<RequestRow> {
  const [r] = await db.execute<RequestRow>(raw`select * from lift_assist_requests where id = ${id}`);
  if (!r) throw Errors.notFound('Lift assist request');
  return r;
}

/**
 * Who could be asked: offered to help lift, active, not snoozed, free at that
 * time by their weekly availability (no rules on file counts as free, as for
 * rides), not already on a ride then, in the area when one is given. Capped,
 * so it can never become a blast.
 */
export async function suggestHelpers(requestId: string) {
  const r = await loadRequest(requestId);
  const at = new Date(r.starts_at);
  const weekday = localWeekday(at);
  const minute = localMinuteOfDay(at);
  const iso = at.toISOString();
  const rows = await db.execute<{ id: string; full_name: string; service_area: string | null }>(raw`
    select u.id, u.full_name, u.service_area
      from users u join lift_assist_helpers h on h.user_id = u.id
     where u.deleted_at is null and u.status = 'active' and u.role = 'volunteer'
       and (u.muted_until is null or u.muted_until <= now())
       and (
         not exists (select 1 from availability_rules ar where ar.user_id = u.id)
         or exists (select 1 from availability_rules ar where ar.user_id = u.id and ar.weekday = ${weekday}
                     and ${minute} >= ar.start_minute and ${minute} < ar.end_minute)
       )
       and not exists (select 1 from availability_exceptions ae where ae.user_id = u.id and ae.kind = 'unavailable'
                        and ${iso}::timestamptz >= ae.starts_at and ${iso}::timestamptz < ae.ends_at)
       and not exists (select 1 from trips t where t.assigned_volunteer_id = u.id and t.deleted_at is null
                        and t.status in ('assigned','accepted','en_route','in_progress')
                        and abs(extract(epoch from (t.pickup_at - ${iso}::timestamptz))) < 90 * 60)
       and (${r.area ?? null}::text is null or u.service_area ilike '%' || ${r.area ?? ''} || '%')
       and not exists (select 1 from lift_assist_invites i where i.request_id = ${requestId} and i.user_id = u.id)
     order by u.last_offered_at nulls first, u.full_name
     limit ${LIFT_ASSIST_MAX_AUDIENCE}`);
  return rows.map((x) => ({ id: x.id, fullName: x.full_name, area: x.service_area }));
}

export function liftAudienceHash(requestId: string, userIds: string[]): string {
  return createHash('sha256').update(`lift|${requestId}|${[...new Set(userIds)].sort().join(',')}`).digest('hex');
}

/** Exactly who would be asked, and how many, before anything is sent. */
export async function previewLiftAudience(requestId: string, chosen?: string[]) {
  const r = await loadRequest(requestId);
  if (r.status !== 'open') throw Errors.conflict('This request is no longer open.');
  const suggested = await suggestHelpers(requestId);
  const picked = chosen ? suggested.filter((s) => chosen.includes(s.id)) : suggested;
  if (chosen && picked.length !== new Set(chosen).size) {
    throw Errors.validation('Some of the people chosen are not free or have not offered to help lift.');
  }
  const ids = picked.map((p) => p.id);
  return {
    needed: Number(r.needed),
    count: picked.length,
    recipients: picked,
    audienceHash: liftAudienceHash(requestId, ids),
    enough: picked.length >= Number(r.needed),
  };
}

/** Sends the invitations once, to exactly the previewed people. */
export async function inviteHelpers(actor: AuditActor, requestId: string, userIds: string[], hash: string) {
  if (liftAudienceHash(requestId, userIds) !== hash) {
    throw Errors.validation('The people chosen changed since the preview. Preview again before sending.');
  }
  const preview = await previewLiftAudience(requestId, userIds);
  const r = await loadRequest(requestId);
  const when = new Date(r.starts_at).toLocaleString('en-CA', { timeZone: 'America/Toronto', weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  return db.transaction(async (tx) => {
    const claimed = await tx.execute(raw`
      insert into lift_assist_sends (request_id, audience_hash, recipients, sent_by_id)
      values (${requestId}, ${hash}, ${preview.count}, ${actor.userId}) on conflict do nothing returning request_id`);
    if (!claimed.length) throw Errors.conflict('These people were already asked.');
    for (const p of preview.recipients) {
      await tx.execute(raw`insert into lift_assist_invites (request_id, user_id) values (${requestId}, ${p.id}) on conflict do nothing`);
      await notify({
        userId: p.id, event: 'lift_assist.invite', title: 'Can you help lift?',
        body: `${r.title}, ${when} at ${r.location}. ${r.needed} people needed. Open the app to say yes or no.`,
        payload: { liftAssistId: requestId },
      }, tx);
    }
    await recordAudit({ actor, action: 'lift_assist.invited', entityType: 'lift_assist', entityId: requestId, next: { recipients: preview.count, audienceHash: hash } }, tx);
    return { invited: preview.count };
  });
}

/**
 * A volunteer answers. Yes is accepted only while places remain (row lock,
 * so two last-moment yeses cannot both take the last place). The first yes
 * becomes the lead unless the coordinator chose one. When enough have said
 * yes the request closes and each helper is told who the lead is.
 */
export async function respond(actor: AuditActor, requestId: string, userId: string, accept: boolean) {
  return db.transaction(async (tx) => {
    const [r] = await tx.execute<RequestRow>(raw`select * from lift_assist_requests where id = ${requestId} for update`);
    const [inv] = await tx.execute<{ status: string }>(raw`
      select status from lift_assist_invites where request_id = ${requestId} and user_id = ${userId}`);
    if (!r || !inv) throw Errors.notFound('Invitation');
    if (inv.status === 'accepted' && accept) return { status: r.status, accepted: true };
    if (!accept) {
      if (inv.status === 'accepted') throw Errors.conflict('You already said yes; ask the coordinator to take you off.');
      await tx.execute(raw`update lift_assist_invites set status = 'declined', responded_at = now() where request_id = ${requestId} and user_id = ${userId}`);
      await recordAudit({ actor, action: 'lift_assist.declined', entityType: 'lift_assist', entityId: requestId }, tx);
      return { status: r.status, accepted: false };
    }
    if (r.status !== 'open') throw Errors.conflict('Thank you. Enough people have already said yes.');
    await tx.execute(raw`update lift_assist_invites set status = 'accepted', responded_at = now() where request_id = ${requestId} and user_id = ${userId}`);
    if (!r.lead_user_id) await tx.execute(raw`update lift_assist_requests set lead_user_id = ${userId} where id = ${requestId}`);
    const [{ n }] = await tx.execute<{ n: number }>(raw`
      select count(*)::int as n from lift_assist_invites where request_id = ${requestId} and status = 'accepted'`) as unknown as [{ n: number }];
    let status = r.status;
    if (Number(n) >= Number(r.needed)) {
      status = 'filled';
      await tx.execute(raw`update lift_assist_requests set status = 'filled' where id = ${requestId}`);
      const team = await tx.execute<{ user_id: string; full_name: string }>(raw`
        select i.user_id, u.full_name from lift_assist_invites i join users u on u.id = i.user_id
         where i.request_id = ${requestId} and i.status = 'accepted'`);
      const [lead] = await tx.execute<{ full_name: string }>(raw`
        select u.full_name from lift_assist_requests q join users u on u.id = q.lead_user_id where q.id = ${requestId}`);
      for (const m of team) {
        await notify({
          userId: m.user_id, event: 'lift_assist.confirmed', title: 'Lift assist confirmed',
          body: `${r.title} at ${r.location}: ${team.length} helpers. ${lead?.full_name ?? 'The first to arrive'} leads.`,
          payload: { liftAssistId: requestId },
        }, tx);
      }
    }
    await recordAudit({ actor, action: 'lift_assist.accepted', entityType: 'lift_assist', entityId: requestId, next: { accepted: Number(n), status } }, tx);
    return { status, accepted: true };
  });
}

export async function setLead(actor: AuditActor, requestId: string, userId: string) {
  const rows = await db.execute(raw`
    update lift_assist_requests q set lead_user_id = ${userId}
     where q.id = ${requestId}
       and exists (select 1 from lift_assist_invites i where i.request_id = q.id and i.user_id = ${userId} and i.status = 'accepted')
    returning id`);
  if (!rows.length) throw Errors.validation('The lead must be someone who said yes.');
  await recordAudit({ actor, action: 'lift_assist.lead_set', entityType: 'lift_assist', entityId: requestId, next: { lead: userId } });
}

export async function cancelLiftAssist(actor: AuditActor, requestId: string) {
  const rows = await db.execute(raw`update lift_assist_requests set status = 'cancelled' where id = ${requestId} and status <> 'cancelled' returning id`);
  if (!rows.length) throw Errors.notFound('Lift assist request');
  await recordAudit({ actor, action: 'lift_assist.cancelled', entityType: 'lift_assist', entityId: requestId });
}

/** A coordinator sees everything; a volunteer sees only requests they were
 *  asked to, without the other people's names (except the lead's). */
export async function getLiftAssist(user: AuthenticatedUser, requestId: string) {
  const r = await loadRequest(requestId);
  const invites = await db.execute<{ user_id: string; full_name: string; status: string }>(raw`
    select i.user_id, u.full_name, i.status from lift_assist_invites i join users u on u.id = i.user_id
     where i.request_id = ${requestId} order by u.full_name`);
  const mine = invites.find((i) => i.user_id === user.id);
  if (!isStaff(user) && !mine) throw Errors.notFound('Lift assist request');
  const lead = invites.find((i) => i.user_id === r.lead_user_id);
  const accepted = invites.filter((i) => i.status === 'accepted').length;
  return {
    id: r.id, title: r.title, location: r.location, startsAt: new Date(r.starts_at).toISOString(),
    durationMinutes: Number(r.duration_minutes), needed: Number(r.needed), accepted, status: r.status, notes: r.notes,
    leadName: lead?.full_name ?? null,
    myStatus: mine?.status ?? null,
    invites: isStaff(user) ? invites.map((i) => ({ userId: i.user_id, fullName: i.full_name, status: i.status })) : undefined,
  };
}

export async function listLiftAssists(user: AuthenticatedUser) {
  const rows = await db.execute<{ id: string }>(isStaff(user)
    ? raw`select id from lift_assist_requests order by starts_at desc limit 50`
    : raw`select q.id from lift_assist_requests q join lift_assist_invites i on i.request_id = q.id and i.user_id = ${user.id}
           where q.starts_at > now() - interval '1 day' order by q.starts_at`);
  return Promise.all(rows.map((r) => getLiftAssist(user, r.id)));
}

import { createHash } from 'node:crypto';
import { sql as raw } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  distributionRunSchema, foodItemSchema, foodVendorSchema, prepSlotSchema, shoppingListSchema,
} from '@rvc/shared';
import { db } from '../db/client.js';
import type { AuditActor } from '../lib/audit.js';
import { recordAudit } from '../lib/audit.js';
import { Errors } from '../lib/errors.js';
import { addDaysToDateString, localDateString, weekdayOfDateString } from '../lib/time.js';
import { notify } from '../services/notification.service.js';

/**
 * Food operations (item 5): stock and vendors, weekly preparation slots with
 * the staff and ingredients each needs, distribution runs, and shopping lists
 * that go to a chosen few people exactly once.
 *
 * Separate from the hospital_food trip type, which is unchanged.
 */

const pgUuids = (ids: string[]) => `{${ids.join(',')}}`;

// --- vendors and stock ------------------------------------------------------

export async function listVendors() {
  return db.execute(raw`select id, name, phone, email, notes, active from food_vendors order by active desc, name`);
}

export async function createVendor(actor: AuditActor, v: z.infer<typeof foodVendorSchema>) {
  const [row] = await db.execute<{ id: string }>(raw`
    insert into food_vendors (name, phone, email, notes) values (${v.name}, ${v.phone ?? null}, ${v.email ?? null}, ${v.notes ?? null})
    returning id`);
  await recordAudit({ actor, action: 'food.vendor_created', entityType: 'food_vendor', entityId: row!.id, next: { name: v.name } });
  return row!.id;
}

export async function listItems() {
  return db.execute(raw`
    select i.id, i.name, i.unit, i.on_hand::float as "onHand", i.par_level::float as "parLevel", i.notes,
           v.id as "vendorId", v.name as "vendorName",
           (i.par_level is not null and i.on_hand < i.par_level) as "low"
      from food_items i left join food_vendors v on v.id = i.vendor_id
     where i.active order by "low" desc, i.name`);
}

export async function createItem(actor: AuditActor, it: z.infer<typeof foodItemSchema>) {
  const [row] = await db.execute<{ id: string }>(raw`
    insert into food_items (name, unit, vendor_id, on_hand, par_level, notes)
    values (${it.name}, ${it.unit}, ${it.vendorId ?? null}, ${it.onHand}, ${it.parLevel ?? null}, ${it.notes ?? null})
    returning id`).catch((err: unknown) => {
      if (String((err as { cause?: { code?: string } }).cause?.code ?? '') === '23505') throw Errors.conflict('There is already an item with that name.');
      throw err;
    });
  await recordAudit({ actor, action: 'food.item_created', entityType: 'food_item', entityId: row!.id, next: { name: it.name, onHand: it.onHand } });
  return row!.id;
}

/** Counts stock in or out. Never below zero; every change is audited. */
export async function adjustStock(actor: AuditActor, itemId: string, change: number, reason: string) {
  return db.transaction(async (tx) => {
    const [item] = await tx.execute<{ on_hand: string; name: string }>(raw`select on_hand, name from food_items where id = ${itemId} and active for update`);
    if (!item) throw Errors.notFound('Item');
    const next = Number(item.on_hand) + change;
    if (next < 0) throw Errors.validation(`Only ${Number(item.on_hand)} on hand; cannot take out ${-change}.`);
    await tx.execute(raw`update food_items set on_hand = ${next}, updated_at = now() where id = ${itemId}`);
    await recordAudit({
      actor, action: 'food.stock_adjusted', entityType: 'food_item', entityId: itemId,
      previous: { onHand: Number(item.on_hand) }, next: { onHand: next }, metadata: { change, reason },
    }, tx);
    return next;
  });
}

// --- preparation slots --------------------------------------------------------

export async function createPrepSlot(actor: AuditActor, s: z.infer<typeof prepSlotSchema>) {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(raw`
      insert into food_prep_slots (title, weekday, start_minute, end_minute, staff_needed, notes)
      values (${s.title}, ${s.weekday}, ${s.startMinute}, ${s.endMinute}, ${s.staffNeeded}, ${s.notes ?? null}) returning id`);
    for (const it of s.items) {
      await tx.execute(raw`insert into food_prep_slot_items (slot_id, item_id, quantity) values (${row!.id}, ${it.itemId}, ${it.quantity})`);
    }
    await recordAudit({ actor, action: 'food.prep_slot_created', entityType: 'food_prep_slot', entityId: row!.id, next: { title: s.title, weekday: s.weekday, staffNeeded: s.staffNeeded } }, tx);
    return row!.id;
  });
}

export async function setPrepSlotActive(actor: AuditActor, slotId: string, active: boolean) {
  const rows = await db.execute(raw`update food_prep_slots set active = ${active} where id = ${slotId} returning id`);
  if (!rows.length) throw Errors.notFound('Preparation slot');
  await recordAudit({ actor, action: active ? 'food.prep_slot_resumed' : 'food.prep_slot_stopped', entityType: 'food_prep_slot', entityId: slotId });
}

type SlotRow = {
  id: string; title: string; weekday: number; start_minute: number; end_minute: number; staff_needed: number; notes: string | null;
};

/** The next `days` days of slot occurrences, with who has signed up. */
export async function upcomingSlots(days: number, viewerId: string, showNames: boolean) {
  const slots = await db.execute<SlotRow>(raw`
    select id, title, weekday, start_minute, end_minute, staff_needed, notes from food_prep_slots where active order by start_minute`);
  const items = await db.execute<{ slot_id: string; name: string; unit: string; quantity: string }>(raw`
    select si.slot_id, i.name, i.unit, si.quantity from food_prep_slot_items si join food_items i on i.id = si.item_id order by i.name`);
  const today = localDateString(new Date());
  const dates: Array<{ date: string; weekday: number }> = [];
  for (let d = 0; d < days; d++) {
    const date = addDaysToDateString(today, d);
    dates.push({ date, weekday: weekdayOfDateString(date) });
  }
  const signups = await db.execute<{ slot_id: string; on_date: string; user_id: string; full_name: string }>(raw`
    select s.slot_id, to_char(s.on_date, 'YYYY-MM-DD') as on_date, s.user_id, u.full_name
      from food_prep_signups s join users u on u.id = s.user_id
     where s.on_date between ${dates[0]!.date}::date and ${dates[dates.length - 1]!.date}::date`);
  const out = [];
  for (const { date, weekday } of dates) {
    for (const s of slots.filter((x) => Number(x.weekday) === weekday)) {
      const who = signups.filter((x) => x.slot_id === s.id && x.on_date === date);
      out.push({
        slotId: s.id, date, title: s.title, startMinute: Number(s.start_minute), endMinute: Number(s.end_minute),
        staffNeeded: Number(s.staff_needed), signedUp: who.length,
        stillNeeded: Math.max(0, Number(s.staff_needed) - who.length),
        iAmSignedUp: who.some((x) => x.user_id === viewerId),
        names: showNames ? who.map((x) => x.full_name) : undefined,
        notes: s.notes,
        items: items.filter((i) => i.slot_id === s.id).map((i) => ({ name: i.name, unit: i.unit, quantity: Number(i.quantity) })),
      });
    }
  }
  return out;
}

export async function signUp(actor: AuditActor, slotId: string, userId: string, onDate: string) {
  const [slot] = await db.execute<{ weekday: number; staff_needed: number; active: boolean }>(raw`
    select weekday, staff_needed, active from food_prep_slots where id = ${slotId}`);
  if (!slot || !slot.active) throw Errors.notFound('Preparation slot');
  if (weekdayOfDateString(onDate) !== Number(slot.weekday)) throw Errors.validation('That slot does not run on that day.');
  if (onDate < localDateString(new Date())) throw Errors.validation('That day has passed.');
  return db.transaction(async (tx) => {
    // Lock the slot so two people cannot both take the last place.
    await tx.execute(raw`select id from food_prep_slots where id = ${slotId} for update`);
    const [{ n }] = await tx.execute<{ n: number }>(raw`
      select count(*)::int as n from food_prep_signups where slot_id = ${slotId} and on_date = ${onDate}::date`) as unknown as [{ n: number }];
    const already = await tx.execute(raw`select 1 from food_prep_signups where slot_id = ${slotId} and on_date = ${onDate}::date and user_id = ${userId}`);
    if (already.length) return { ok: true, already: true };
    if (Number(n) >= Number(slot.staff_needed)) throw Errors.conflict('This slot is already full. Thank you for offering.');
    await tx.execute(raw`insert into food_prep_signups (slot_id, on_date, user_id) values (${slotId}, ${onDate}::date, ${userId})`);
    await recordAudit({ actor, action: 'food.prep_signup', entityType: 'food_prep_slot', entityId: slotId, next: { onDate, userId } }, tx);
    return { ok: true, already: false };
  });
}

export async function withdraw(actor: AuditActor, slotId: string, userId: string, onDate: string) {
  const rows = await db.execute(raw`
    delete from food_prep_signups where slot_id = ${slotId} and on_date = ${onDate}::date and user_id = ${userId} returning slot_id`);
  if (rows.length) await recordAudit({ actor, action: 'food.prep_withdrawn', entityType: 'food_prep_slot', entityId: slotId, previous: { onDate, userId } });
}

// --- distribution runs ----------------------------------------------------------

export async function createRun(actor: AuditActor, r: z.infer<typeof distributionRunSchema>) {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(raw`
      insert into food_distribution_runs (run_date, route, recipients_count, notes, created_by_id)
      values (${r.runDate}::date, ${r.route}, ${r.recipientsCount}, ${r.notes ?? null}, ${actor.userId}) returning id`);
    for (const id of [...new Set(r.volunteerIds)]) {
      await tx.execute(raw`insert into food_run_volunteers (run_id, user_id) values (${row!.id}, ${id})`);
    }
    await recordAudit({ actor, action: 'food.run_created', entityType: 'food_run', entityId: row!.id, next: { runDate: r.runDate, recipientsCount: r.recipientsCount, volunteers: r.volunteerIds.length } }, tx);
    return row!.id;
  });
}

export async function setRunStatus(actor: AuditActor, runId: string, status: 'planned' | 'done' | 'cancelled', recipientsCount?: number) {
  const rows = await db.execute(raw`
    update food_distribution_runs set status = ${status}, recipients_count = coalesce(${recipientsCount ?? null}::int, recipients_count)
     where id = ${runId} returning id`);
  if (!rows.length) throw Errors.notFound('Distribution run');
  await recordAudit({ actor, action: 'food.run_updated', entityType: 'food_run', entityId: runId, next: { status, recipientsCount } });
}

export async function listRuns(viewer: { id: string; isStaff: boolean }) {
  return db.execute(raw`
    select r.id, to_char(r.run_date, 'YYYY-MM-DD') as "runDate", r.route, r.recipients_count as "recipientsCount", r.status, r.notes,
           coalesce(array_agg(u.full_name order by u.full_name) filter (where u.id is not null), '{}') as volunteers
      from food_distribution_runs r
      left join food_run_volunteers rv on rv.run_id = r.id
      left join users u on u.id = rv.user_id
     where ${viewer.isStaff} or exists (select 1 from food_run_volunteers x where x.run_id = r.id and x.user_id = ${viewer.id})
     group by r.id order by r.run_date desc limit 100`);
}

// --- shopping lists -------------------------------------------------------------

export async function createShoppingList(actor: AuditActor, l: z.infer<typeof shoppingListSchema>) {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(raw`
      insert into food_shopping_lists (title, created_by_id) values (${l.title}, ${actor.userId}) returning id`);
    let position = 0;
    for (const it of l.items) {
      await tx.execute(raw`insert into food_shopping_list_items (list_id, position, name, quantity, unit) values (${row!.id}, ${position++}, ${it.name}, ${it.quantity}, ${it.unit})`);
    }
    await recordAudit({ actor, action: 'food.shopping_list_created', entityType: 'food_shopping_list', entityId: row!.id, next: { title: l.title, items: l.items.length } }, tx);
    return row!.id;
  });
}

export async function getShoppingList(listId: string) {
  const [list] = await db.execute<{ id: string; title: string; created_at: Date }>(raw`select id, title, created_at from food_shopping_lists where id = ${listId}`);
  if (!list) throw Errors.notFound('Shopping list');
  const items = await db.execute<{ name: string; quantity: string; unit: string }>(raw`
    select name, quantity, unit from food_shopping_list_items where list_id = ${listId} order by position`);
  const sends = await db.execute<{ recipients: number; sent_at: Date }>(raw`
    select recipients, sent_at from food_shopping_list_sends where list_id = ${listId} order by sent_at`);
  return {
    id: list.id, title: list.title,
    items: items.map((i) => ({ name: i.name, quantity: Number(i.quantity), unit: i.unit })),
    sends: sends.map((s) => ({ recipients: Number(s.recipients), sentAt: new Date(s.sent_at).toISOString() })),
  };
}

export async function listShoppingLists() {
  return db.execute(raw`
    select l.id, l.title, l.created_at as "createdAt",
           (select count(*)::int from food_shopping_list_items i where i.list_id = l.id) as items,
           (select max(sent_at) from food_shopping_list_sends s where s.list_id = l.id) as "lastSentAt"
      from food_shopping_lists l order by l.created_at desc limit 100`);
}

/** The same people in any order give the same fingerprint. */
export function audienceHash(listId: string, userIds: string[]): string {
  return createHash('sha256').update(`${listId}|${[...new Set(userIds)].sort().join(',')}`).digest('hex');
}

async function resolveAudience(userIds: string[]) {
  const unique = [...new Set(userIds)];
  const rows = await db.execute<{ id: string; full_name: string; notification_preference: string }>(raw`
    select id, full_name, notification_preference from users
     where id = any(${pgUuids(unique)}::uuid[]) and deleted_at is null and status = 'active' and role in ('volunteer', 'dispatcher', 'admin')
     order by full_name`);
  if (rows.length !== unique.length) throw Errors.validation('Some of the people chosen are not active.');
  return rows;
}

/** What the sender must see before sending: who, how many, and whether this
 *  exact audience already got the list. */
export async function previewShoppingList(listId: string, userIds: string[]) {
  await getShoppingList(listId);
  const people = await resolveAudience(userIds);
  const hash = audienceHash(listId, userIds);
  const sent = await db.execute(raw`select 1 from food_shopping_list_sends where list_id = ${listId} and audience_hash = ${hash}`);
  return {
    count: people.length,
    recipients: people.map((p) => ({ id: p.id, fullName: p.full_name, preference: p.notification_preference })),
    audienceHash: hash,
    alreadySent: sent.length > 0,
  };
}

/**
 * Sends the list once to exactly the previewed people. The unique
 * (list, audience) row is claimed before anything is sent, inside the same
 * transaction as the messages being queued, so a double press, a retry or
 * two people pressing together queue it once.
 */
export async function sendShoppingList(actor: AuditActor, listId: string, userIds: string[], hash: string) {
  if (audienceHash(listId, userIds) !== hash) {
    throw Errors.validation('The people chosen changed since the preview. Preview again before sending.');
  }
  const list = await getShoppingList(listId);
  const people = await resolveAudience(userIds);
  const body = list.items.map((i) => `- ${i.quantity} ${i.unit} ${i.name}`).join('\n');
  return db.transaction(async (tx) => {
    const claimed = await tx.execute(raw`
      insert into food_shopping_list_sends (list_id, audience_hash, recipients, sent_by_id)
      values (${listId}, ${hash}, ${people.length}, ${actor.userId}) on conflict do nothing returning list_id`);
    if (!claimed.length) throw Errors.conflict('This list was already sent to these people.');
    for (const p of people) {
      await notify({
        userId: p.id, event: 'food.shopping_list', title: `Shopping list: ${list.title}`,
        subject: `Shopping list: ${list.title}`, body: `${list.title}\n${body}`,
        payload: { listId },
      }, tx);
    }
    await recordAudit({ actor, action: 'food.shopping_list_sent', entityType: 'food_shopping_list', entityId: listId, next: { recipients: people.length, audienceHash: hash } }, tx);
    return { sentTo: people.length };
  });
}

import { sql as raw } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { localMinuteOfDay, localWeekday } from '../lib/time.js';
import { pgArray } from '../lib/pg.js';
import { logger } from '../lib/logger.js';

/**
 * Who should be asked.
 *
 * The legacy system offered every trip to every member of a group. That is
 * affordable at 150 volunteers and ruinous at 500 — not because of the
 * database, but because every offer is an SMS segment and a phone buzzing in
 * somebody's pocket. A volunteer who is asked forty times a week for rides she
 * cannot do stops reading the messages, and then she misses the one she could
 * have taken. Targeting exists to protect attention, and the cost follows.
 *
 * Six hard filters, in the order a dispatcher would apply them:
 *
 *   1. membership   — active volunteer in this trip's group
 *   2. service      — has opted in to this kind of work
 *   3. capability   — can physically handle what the passenger needs
 *   4. availability — the pickup time falls inside their stated hours
 *   5. conflict     — not already committed to a trip at that hour
 *   6. snooze       — not muted right now
 *
 * Then a soft ordering, because who is asked *first* matters as much as who is
 * asked at all: the recurring ride's usual driver, then people who have driven
 * this caller before, then whoever has been asked least recently.
 *
 * Priority relaxes the filters rather than bypassing the mechanism:
 *   - routine  : all filters apply
 *   - urgent   : all filters apply; if nobody qualifies, availability and
 *                snooze are dropped and the trip is offered to the rest with
 *                that fact recorded on the offer round
 *   - emergency: availability and snooze never apply
 *
 * Nothing here is an authorisation boundary. It decides who is *asked*; what a
 * volunteer may see and do is enforced separately in the service layer.
 */

/** A volunteer already committed to a trip within this many minutes is skipped. */
export const CONFLICT_WINDOW_MINUTES = 90;

export interface Candidate {
  id: string;
  fullName: string;
  phone: string | null;
  email: string;
  notificationPreference: string;
  /** Higher is better. Used only for ordering, never for filtering. */
  score: number;
  familiarity: number;
  lastOfferedAt: Date | null;
  isPreferred: boolean;
}

export interface Excluded {
  id: string;
  fullName: string;
  reasons: string[];
}

export interface TargetingResult {
  eligible: Candidate[];
  excluded: Excluded[];
  /** True when the filters were relaxed because nobody qualified. */
  relaxed: boolean;
  relaxedReason?: string;
}

export interface TargetingInput {
  groupId: string;
  tripType: string;
  priority: string;
  pickupAt: Date;
  mobilityNeeds: string[];
  callerId?: string | null;
  preferredVolunteerId?: string | null;
  /** When the dispatcher names people explicitly, only they are considered. */
  restrictToUserIds?: string[] | null;
  /** The trip being offered, excluded from its own conflict check. */
  excludeTripId?: string | null;
  limit?: number;
}

interface Row {
  id: string;
  full_name: string;
  phone: string | null;
  email: string;
  notification_preference: string;
  last_offered_at: Date | null;
  in_group: boolean;
  has_service: boolean;
  has_capability: boolean;
  is_available: boolean;
  is_free: boolean;
  not_muted: boolean;
  familiarity: number;
  is_preferred: boolean;
}

/**
 * One query answers both "who is eligible" and "why was everyone else skipped".
 *
 * The reasons are not decoration: the single most common dispatcher question in
 * the old system was "why didn't he get it?", and the only way to answer it was
 * to guess. Each filter is computed as a column so the answer is a fact.
 */
export async function evaluateCandidates(
  input: TargetingInput,
  exec: Executor = db,
): Promise<TargetingResult> {
  const needs = (input.mobilityNeeds ?? []).filter((n) => n && n !== 'none');
  const weekday = localWeekday(input.pickupAt);
  const minuteOfDay = localMinuteOfDay(input.pickupAt);
  const limit = input.limit ?? 500;
  // postgres-js infers a parameter's type from Postgres's own description of
  // the statement. In `pickup_at - $n` and inside the availability EXISTS
  // clauses that description came back as `text`, and serialising a Date as
  // text throws. Passing the ISO string with an explicit ::timestamptz removes
  // the ambiguity instead of relying on inference.
  const pickupIso = input.pickupAt.toISOString();
  const needsLiteral = pgArray(needs);
  const restrictLiteral = input.restrictToUserIds?.length ? pgArray(input.restrictToUserIds) : null;

  // If the service type is missing, do not silently exclude the entire roster.
  const svcRows = (await exec.execute(
    raw`select id from service_types where slug = ${input.tripType} and active`,
  )) as unknown as Array<{ id: string }>;
  const serviceKnown = svcRows.length > 0;
  if (!serviceKnown) {
    logger.warn(
      { tripType: input.tripType },
      'no active service_type matches this trip type; service opt-in filter skipped',
    );
  }

  const rows = (await exec.execute(raw`
    select
      u.id,
      u.full_name,
      u.phone,
      u.email,
      u.notification_preference,
      u.last_offered_at,
      (ug.user_id is not null)                                as in_group,
      (${!serviceKnown} or vs.user_id is not null)            as has_service,
      (
        ${needs.length} = 0
        or ${needsLiteral}::text[] <@ u.capabilities
      )                                                       as has_capability,
      (
        -- No rules on file means "no stated restriction", which is availability,
        -- not unavailability. Any other reading silences the whole roster the
        -- day this ships.
        (
          not exists (select 1 from availability_rules ar where ar.user_id = u.id)
          or exists (
            select 1 from availability_rules ar
            where ar.user_id = u.id
              and ar.weekday = ${weekday}
              and ${minuteOfDay} >= ar.start_minute
              and ${minuteOfDay} <  ar.end_minute
          )
          or exists (
            select 1 from availability_exceptions ae
            where ae.user_id = u.id and ae.kind = 'available'
              and ${pickupIso}::timestamptz >= ae.starts_at and ${pickupIso}::timestamptz < ae.ends_at
          )
        )
        and not exists (
          select 1 from availability_exceptions ae
          where ae.user_id = u.id and ae.kind = 'unavailable'
            and ${pickupIso}::timestamptz >= ae.starts_at and ${pickupIso}::timestamptz < ae.ends_at
        )
      )                                                       as is_available,
      not exists (
        select 1 from trips t2
        where t2.assigned_volunteer_id = u.id
          and t2.deleted_at is null
          and t2.status in ('assigned','accepted','en_route','in_progress')
          and (${input.excludeTripId ?? null}::uuid is null or t2.id <> ${input.excludeTripId ?? null}::uuid)
          and abs(extract(epoch from (t2.pickup_at - ${pickupIso}::timestamptz))) < ${CONFLICT_WINDOW_MINUTES} * 60
      )                                                       as is_free,
      (u.muted_until is null or u.muted_until <= now())       as not_muted,
      coalesce(fam.n, 0)::int                                 as familiarity,
      (${input.preferredVolunteerId ?? null}::uuid is not null
        and u.id = ${input.preferredVolunteerId ?? null}::uuid)  as is_preferred
    from users u
    left join user_groups ug
      on ug.user_id = u.id and ug.group_id = ${input.groupId}::uuid
    left join volunteer_services vs
      on vs.user_id = u.id
     and vs.service_type_id in (select id from service_types where slug = ${input.tripType} and active)
    left join lateral (
      select count(*) as n from trips t3
      where t3.assigned_volunteer_id = u.id
        and t3.status = 'completed'
        and ${input.callerId ?? null}::uuid is not null
        and t3.caller_id = ${input.callerId ?? null}::uuid
    ) fam on true
    where u.deleted_at is null
      and u.status = 'active'
      and u.role = 'volunteer'
      and (${restrictLiteral}::uuid[] is null or u.id = any(${restrictLiteral}::uuid[]))
    order by u.full_name
  `)) as unknown as Row[];

  const build = (relaxAvailability: boolean): { eligible: Candidate[]; excluded: Excluded[] } => {
    const eligible: Candidate[] = [];
    const excluded: Excluded[] = [];
    for (const r of rows) {
      const reasons: string[] = [];
      if (!r.in_group) reasons.push('not in this group');
      if (!r.has_service) reasons.push('has not opted in to this service');
      if (!r.has_capability) reasons.push(`cannot cover: ${needs.join(', ')}`);
      if (!relaxAvailability && !r.is_available) reasons.push('not available at this time');
      if (!r.is_free) reasons.push('already on another trip at this time');
      if (!relaxAvailability && !r.not_muted) reasons.push('notifications snoozed');

      if (reasons.length) {
        excluded.push({ id: r.id, fullName: r.full_name, reasons });
        continue;
      }
      eligible.push({
        id: r.id,
        fullName: r.full_name,
        phone: r.phone,
        email: r.email,
        notificationPreference: r.notification_preference,
        familiarity: Number(r.familiarity),
        lastOfferedAt: r.last_offered_at ? new Date(r.last_offered_at) : null,
        isPreferred: Boolean(r.is_preferred),
        score: 0,
      });
    }
    return { eligible, excluded };
  };

  const emergency = input.priority === 'emergency';
  let { eligible, excluded } = build(emergency);
  let relaxed = emergency;
  let relaxedReason = emergency ? 'emergency priority ignores availability and snooze' : undefined;

  // Urgent trips try the strict pool first and widen only if it is empty. A
  // wider pool is a real cost (more messages, more interruption), so it is paid
  // only when the alternative is nobody being asked at all.
  if (eligible.length === 0 && input.priority === 'urgent' && !relaxed) {
    const retry = build(true);
    if (retry.eligible.length > 0) {
      eligible = retry.eligible;
      excluded = retry.excluded;
      relaxed = true;
      relaxedReason = 'urgent trip had no strictly-eligible volunteers; availability and snooze relaxed';
    }
  }

  // Ordering. Preferred driver, then familiarity with this caller, then the
  // person asked least recently — which is what stops the same six names
  // carrying the whole roster.
  eligible.sort((a, b) => {
    if (a.isPreferred !== b.isPreferred) return a.isPreferred ? -1 : 1;
    if (a.familiarity !== b.familiarity) return b.familiarity - a.familiarity;
    const at = a.lastOfferedAt?.getTime() ?? 0;
    const bt = b.lastOfferedAt?.getTime() ?? 0;
    if (at !== bt) return at - bt;
    return a.fullName.localeCompare(b.fullName);
  });
  eligible.forEach((c, i) => {
    c.score = eligible.length - i;
  });

  return { eligible: eligible.slice(0, limit), excluded, relaxed, relaxedReason };
}

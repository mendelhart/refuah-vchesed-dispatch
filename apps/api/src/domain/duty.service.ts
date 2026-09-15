import { and, asc, eq, isNull, sql as raw } from 'drizzle-orm';
import { DUTY_KINDS, SETTING_KEYS } from '@rvc/shared';
import { db } from '../db/client.js';
import { dutyShifts, users } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from '../lib/audit.js';
import { getNumberSetting } from '../lib/settings.js';
import { notify } from '../services/notification.service.js';
import { renderTemplate } from '../services/templates.service.js';
import { formatClock } from '../lib/time.js';
import { logger } from '../lib/logger.js';

/**
 * The phone duty roster.
 *
 * Someone has to answer the organisation's line. In the legacy system that was
 * a WhatsApp message and a shared memory, which produced both failure modes:
 * two people answering, and nobody answering.
 *
 * Overlap is prevented by the database, not by this code — `duty_shifts` has a
 * GiST exclusion constraint on (kind, time range) so two live shifts of the
 * same kind cannot exist at once. Two dispatchers pressing save at the same
 * moment is a constraint violation, not a race.
 */

export async function createShift(
  actor: AuditActor,
  input: { kind?: string; userId: string; startsAt: Date; endsAt: Date; notes?: string | null },
) {
  const kind = input.kind ?? 'phone';
  if (!DUTY_KINDS.includes(kind as never)) {
    throw Errors.validation(`kind must be one of: ${DUTY_KINDS.join(', ')}`);
  }
  if (input.endsAt <= input.startsAt) {
    throw Errors.validation('A shift must end after it starts.');
  }
  if (input.endsAt.getTime() - input.startsAt.getTime() > 7 * 86_400_000) {
    throw Errors.validation('A shift longer than a week is almost certainly a typo.');
  }

  const [person] = await db
    .select({ id: users.id, fullName: users.fullName, status: users.status })
    .from(users)
    .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
    .limit(1);
  if (!person || person.status !== 'active') {
    throw Errors.validation('That person is not an active member.');
  }

  try {
    const [row] = await db
      .insert(dutyShifts)
      .values({
        kind,
        userId: input.userId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        notes: input.notes ?? null,
        createdById: actor.userId,
      })
      .returning();

    await recordAudit({
      actor,
      action: 'duty.shift_created',
      entityType: 'duty_shift',
      entityId: row!.id,
      next: { kind, userId: input.userId, startsAt: input.startsAt, endsAt: input.endsAt },
    });
    return row!;
  } catch (err) {
    // 23P01 is exclusion_violation — the overlap guard.
    if ((err as { code?: string }).code === '23P01') {
      const clash = await shiftAt(input.startsAt, kind);
      throw Errors.conflict(
        clash
          ? `${clash.fullName} is already on ${kind} duty then. Change theirs first, or pick a different time.`
          : `Somebody is already on ${kind} duty during that period.`,
        { conflictsWith: clash?.id ?? null },
      );
    }
    throw err;
  }
}

export async function removeShift(actor: AuditActor, id: string) {
  const [row] = await db
    .update(dutyShifts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(dutyShifts.id, id), isNull(dutyShifts.deletedAt)))
    .returning();
  if (!row) throw Errors.notFound('That shift is no longer on the roster.');
  await recordAudit({
    actor,
    action: 'duty.shift_removed',
    entityType: 'duty_shift',
    entityId: id,
    previous: { userId: row.userId, startsAt: row.startsAt, endsAt: row.endsAt },
  });
  return row;
}

export async function listShifts(from: Date, to: Date, kind?: string) {
  return db
    .select({
      id: dutyShifts.id,
      kind: dutyShifts.kind,
      startsAt: dutyShifts.startsAt,
      endsAt: dutyShifts.endsAt,
      notes: dutyShifts.notes,
      userId: dutyShifts.userId,
      fullName: users.fullName,
      phone: users.phone,
    })
    .from(dutyShifts)
    .innerJoin(users, eq(users.id, dutyShifts.userId))
    .where(
      and(
        isNull(dutyShifts.deletedAt),
        raw`${dutyShifts.endsAt} > ${from.toISOString()}::timestamptz`,
        raw`${dutyShifts.startsAt} < ${to.toISOString()}::timestamptz`,
        kind ? eq(dutyShifts.kind, kind) : raw`true`,
      ),
    )
    .orderBy(asc(dutyShifts.startsAt));
}

/** Who is on duty at a given moment — shown on the dispatcher board. */
export async function shiftAt(at: Date = new Date(), kind = 'phone') {
  const [row] = await db
    .select({
      id: dutyShifts.id,
      userId: users.id,
      fullName: users.fullName,
      phone: users.phone,
      startsAt: dutyShifts.startsAt,
      endsAt: dutyShifts.endsAt,
    })
    .from(dutyShifts)
    .innerJoin(users, eq(users.id, dutyShifts.userId))
    .where(
      and(
        isNull(dutyShifts.deletedAt),
        eq(dutyShifts.kind, kind),
        raw`${dutyShifts.startsAt} <= ${at.toISOString()}::timestamptz`,
        raw`${dutyShifts.endsAt} > ${at.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Reminds whoever is next on, shortly before their shift. */
export async function sendShiftReminders(now = new Date()): Promise<number> {
  const leadMinutes = await getNumberSetting(SETTING_KEYS.dutyShiftReminderMinutes);
  const windowEnd = new Date(now.getTime() + leadMinutes * 60_000);

  const due = await db
    .select({
      id: dutyShifts.id,
      kind: dutyShifts.kind,
      userId: dutyShifts.userId,
      startsAt: dutyShifts.startsAt,
      endsAt: dutyShifts.endsAt,
    })
    .from(dutyShifts)
    .where(
      and(
        isNull(dutyShifts.deletedAt),
        isNull(dutyShifts.reminderSentAt),
        raw`${dutyShifts.startsAt} between ${now.toISOString()}::timestamptz and ${windowEnd.toISOString()}::timestamptz`,
      ),
    );

  let sent = 0;
  for (const shift of due) {
    try {
      const rendered = await renderTemplate('duty.shift_reminder', 'sms', {
        kind: shift.kind,
        startClock: formatClock(shift.startsAt),
        endClock: formatClock(shift.endsAt),
        orgPhone: '',
      });
      await notify({
        userId: shift.userId,
        event: 'duty.shift_reminder',
        title: 'You are on duty shortly',
        body: rendered.body,
      });
      await db
        .update(dutyShifts)
        .set({ reminderSentAt: new Date() })
        .where(eq(dutyShifts.id, shift.id));
      sent++;
    } catch (err) {
      logger.error({ err, shiftId: shift.id }, 'duty reminder failed');
    }
  }
  if (sent) {
    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: 'duty.reminders_sent',
      entityType: 'duty_shift',
      entityId: 'batch',
      metadata: { sent },
    });
  }
  return sent;
}

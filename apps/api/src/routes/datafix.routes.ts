import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql as raw } from 'drizzle-orm';
import { TERMINAL_TRIP_STATUSES, uuidSchema } from '@rvc/shared';
import { db } from '../db/client.js';
import { trips } from '../db/schema.js';
import { actorFrom, requireAdmin } from '../auth/guards.js';
import { recordAudit } from '../lib/audit.js';
import { Errors } from '../lib/errors.js';

/**
 * Admin > Data fixes. The small, repeatable corrections that used to be done
 * as one-off database edits. Admin only, each change needs a reason, and each
 * one is written to the audit log with the before and after.
 *
 * Removing an account that was never set up uses the ordinary Remove route
 * (POST /api/users/:id/deactivate); this file only finds them.
 */
const idParam = z.object({ id: uuidSchema });
const outcomeSchema = z.object({
  status: z.enum(['completed', 'cancelled']),
  reason: z.string().trim().min(3, 'Say why, in a few words').max(500),
});

export async function dataFixRoutes(app: FastifyInstance): Promise<void> {
  /** People invited more than 7 days ago who never set a password. */
  app.get('/api/admin/data-fixes/never-set-up', { preHandler: requireAdmin }, async () => {
    const rows = (await db.execute(raw`
      select u.id, u.full_name as "fullName", u.email, u.phone, u.role, u.created_at as "createdAt",
             exists (
               select 1 from auth_tokens t
               where t.user_id = u.id and t.kind = 'invite' and t.used_at is null and t.expires_at > now()
             ) as "hasLiveInvite"
      from users u
      where u.password_hash is null and u.deleted_at is null and u.created_at < now() - interval '7 days'
      order by u.created_at asc
      limit 200
    `)) as unknown as Array<Record<string, unknown>>;
    return { people: rows };
  });

  /** Look up a finished ride by its reference, to correct how it ended. */
  app.get('/api/admin/data-fixes/trips/by-reference/:reference', { preHandler: requireAdmin }, async (req) => {
    const { reference } = z.object({ reference: z.string().trim().min(3).max(40) }).parse(req.params);
    const [trip] = await db
      .select({
        id: trips.id, reference: trips.reference, status: trips.status, pickupAt: trips.pickupAt,
        completedAt: trips.completedAt, cancelledAt: trips.cancelledAt, cancellationReason: trips.cancellationReason,
      })
      .from(trips)
      .where(and(eq(trips.reference, reference.toUpperCase()), isNull(trips.deletedAt)))
      .limit(1);
    if (!trip) throw Errors.notFound('No ride with that reference.');
    return { trip, canCorrect: (TERMINAL_TRIP_STATUSES as readonly string[]).includes(trip.status) };
  });

  /**
   * Correct how a finished ride ended: marked done but did not happen, or
   * cancelled by mistake after it was driven. Open rides are not touched here;
   * they go through the board like any other change.
   */
  app.post('/api/admin/data-fixes/trips/:id/outcome', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = outcomeSchema.parse(req.body);
    const actor = actorFrom(req);
    return db.transaction(async (tx) => {
      const [trip] = await tx
        .select()
        .from(trips)
        .where(and(eq(trips.id, id), isNull(trips.deletedAt), inArray(trips.status, [...TERMINAL_TRIP_STATUSES])))
        .limit(1)
        .for('update');
      if (!trip) throw Errors.conflict('Only a finished ride (done or cancelled) can be corrected here.');
      if (trip.status === body.status) throw Errors.conflict(`That ride is already marked ${body.status === 'completed' ? 'done' : 'cancelled'}.`);
      const now = new Date();
      const next = body.status === 'completed'
        ? { status: 'completed', completedAt: trip.completedAt ?? now, cancelledAt: null, cancellationReason: null }
        : { status: 'cancelled', cancelledAt: now, cancellationReason: `Corrected by admin: ${body.reason}` };
      await tx.update(trips).set({ ...next, updatedAt: now }).where(eq(trips.id, id));
      await recordAudit(
        {
          actor,
          action: 'trip.outcome_corrected',
          entityType: 'trip',
          entityId: id,
          previous: { status: trip.status, completedAt: trip.completedAt, cancelledAt: trip.cancelledAt, cancellationReason: trip.cancellationReason },
          next,
          metadata: { reason: body.reason, reference: trip.reference },
        },
        tx,
      );
      return { trip: { id, reference: trip.reference, status: body.status } };
    });
  });
}


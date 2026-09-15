import { asc, eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditEvents, tripAssignments, tripOffers, users } from '../db/schema.js';

/** The full life of one trip: every audited transition, every offer, every
 *  assignment. This is what "reconstruct what happened after an incident"
 *  means in practice, and it is why audit writes live in the same transaction
 *  as the change. */
export async function tripHistory(tripId: string) {
  const [events, offers, assignments] = await Promise.all([
    db.select().from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'trip'), eq(auditEvents.entityId, tripId)))
      .orderBy(asc(auditEvents.occurredAt)),
    db.select({
      id: tripOffers.id, volunteerId: tripOffers.volunteerId, volunteerName: users.fullName,
      status: tripOffers.status, round: tripOffers.round, offeredAt: tripOffers.offeredAt,
      expiresAt: tripOffers.expiresAt, respondedAt: tripOffers.respondedAt,
      responseChannel: tripOffers.responseChannel,
    }).from(tripOffers).innerJoin(users, eq(users.id, tripOffers.volunteerId))
      .where(eq(tripOffers.tripId, tripId)).orderBy(asc(tripOffers.offeredAt)),
    db.select({
      id: tripAssignments.id, volunteerId: tripAssignments.volunteerId, volunteerName: users.fullName,
      source: tripAssignments.source, assignedAt: tripAssignments.assignedAt,
      unassignedAt: tripAssignments.unassignedAt, unassignedReason: tripAssignments.unassignedReason,
    }).from(tripAssignments).innerJoin(users, eq(users.id, tripAssignments.volunteerId))
      .where(eq(tripAssignments.tripId, tripId)).orderBy(asc(tripAssignments.assignedAt)),
  ]);
  return { events, offers, assignments };
}

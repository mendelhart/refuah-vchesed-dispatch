import { and, asc, desc, eq, isNull, sql as raw } from 'drizzle-orm';
import { THREAD_STATUSES } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { smsMessages, smsThreads, users } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { notify } from '../services/notification.service.js';
import { callerByPhone } from './callers.service.js';
import { logger } from '../lib/logger.js';

/**
 * Two-way SMS.
 *
 * The legacy webhook understood four words — YES, Y, ACCEPT and a four-digit
 * code — and discarded everything else. Every other reply a volunteer or a
 * caller ever sent went into a table nobody read: "I can do it but I'll be ten
 * minutes late", "she's not ready, can you push it an hour", "wrong number,
 * please stop texting me". Those are conversations, and the organisation was
 * having them without knowing.
 *
 * The model is a queue, not an inbox. A thread has a status, an owner and an
 * unread count; the database trigger in migration 0004 maintains the counters,
 * so a message inserted by any code path updates the thread correctly.
 *
 * Privacy: threads are dispatcher-and-above. A volunteer sees their own
 * messages in the app, never anybody else's, and a caller's thread is never
 * visible to volunteers at all.
 */

export interface ThreadSummary {
  id: string;
  phone: string;
  displayName: string | null;
  partyType: string;
  status: string;
  unreadCount: number;
  lastMessageAt: Date;
  lastInboundAt: Date | null;
  ownerId: string | null;
  ownerName: string | null;
  preview: string | null;
  tripId: string | null;
}

/**
 * Finds or creates the conversation for a phone number.
 *
 * One open thread per number: a second conversation with the same person is
 * the same conversation. Identity is resolved once, here — volunteer first,
 * then caller, then unknown — so the console can show a name instead of digits.
 */
export async function threadForPhone(
  phone: string,
  exec: Executor = db,
  hints: { tripId?: string | null } = {},
): Promise<{ id: string; created: boolean; partyType: string; userId: string | null }> {
  const [open] = await exec
    .select()
    .from(smsThreads)
    .where(and(eq(smsThreads.phone, phone), raw`${smsThreads.status} <> 'closed'`))
    .limit(1);
  if (open) {
    return { id: open.id, created: false, partyType: open.partyType, userId: open.userId };
  }

  /**
   * A message soon after a thread was closed is the same conversation.
   *
   * "Thanks, that worked" arriving ten minutes after a dispatcher marked the
   * thread done should not open a second one — the reply belongs with the
   * exchange it answers. After a week it is a new subject and gets a new
   * thread, so the queue does not accumulate one endless conversation per
   * phone number. The trigger in migration 0004 flips the status back to open.
   */
  const [recentlyClosed] = await exec
    .select()
    .from(smsThreads)
    .where(
      and(
        eq(smsThreads.phone, phone),
        eq(smsThreads.status, 'closed'),
        raw`${smsThreads.closedAt} > now() - interval '7 days'`,
      ),
    )
    .orderBy(desc(smsThreads.lastMessageAt))
    .limit(1);
  if (recentlyClosed) {
    return {
      id: recentlyClosed.id,
      created: false,
      partyType: recentlyClosed.partyType,
      userId: recentlyClosed.userId,
    };
  }

  const [volunteer] = await exec
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(and(eq(users.phone, phone), isNull(users.deletedAt)))
    .limit(1);

  const caller = volunteer ? null : await callerByPhone(phone, exec);

  const [row] = await exec
    .insert(smsThreads)
    .values({
      phone,
      partyType: volunteer ? 'volunteer' : caller ? 'caller' : 'unknown',
      userId: volunteer?.id ?? null,
      callerId: caller?.id ?? null,
      displayName: volunteer?.fullName ?? caller?.name ?? null,
      tripId: hints.tripId ?? null,
    })
    .returning();

  return {
    id: row!.id,
    created: true,
    partyType: row!.partyType,
    userId: row!.userId,
  };
}

/**
 * Records an inbound message.
 *
 * Called from the SMS webhook after signature validation, for any message that
 * is not a recognised command. The thread's counters are updated by trigger.
 */
export async function recordInbound(
  phone: string,
  body: string,
  opts: { providerSid?: string | null; tripId?: string | null } = {},
  exec: Executor = db,
): Promise<{ threadId: string; messageId: string; created: boolean }> {
  const thread = await threadForPhone(phone, exec, { tripId: opts.tripId });
  const [message] = await exec
    .insert(smsMessages)
    .values({
      threadId: thread.id,
      direction: 'inbound',
      body: body.slice(0, 2000),
      channel: 'sms',
      providerSid: opts.providerSid ?? null,
      status: 'received',
    })
    .onConflictDoNothing()
    .returning();

  if (!message) {
    // Duplicate provider SID — Twilio redelivered. Nothing more to do.
    const [existing] = await exec
      .select({ id: smsMessages.id })
      .from(smsMessages)
      .where(eq(smsMessages.providerSid, opts.providerSid ?? ''))
      .limit(1);
    return { threadId: thread.id, messageId: existing?.id ?? '', created: false };
  }

  return { threadId: thread.id, messageId: message.id, created: true };
}

/** The dispatcher queue: open conversations, oldest waiting first. */
export async function listThreads(
  filter: { status?: string; ownerId?: string; mine?: string; limit?: number } = {},
): Promise<ThreadSummary[]> {
  const status = filter.status ?? 'open';
  const rows = (await db.execute(raw`
    select t.id, t.phone, t.display_name, t.party_type, t.status, t.unread_count,
           t.last_message_at, t.last_inbound_at, t.owner_id, t.trip_id,
           o.full_name as owner_name,
           (select body from sms_messages m where m.thread_id = t.id
             order by m.created_at desc limit 1) as preview
    from sms_threads t
    left join users o on o.id = t.owner_id
    where (${status}::text = 'all' or t.status = ${status})
      and (${filter.ownerId ?? null}::uuid is null or t.owner_id = ${filter.ownerId ?? null}::uuid)
    order by (t.unread_count > 0) desc, t.last_message_at desc
    limit ${filter.limit ?? 100}
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    phone: String(r.phone),
    displayName: (r.display_name as string) ?? null,
    partyType: String(r.party_type),
    status: String(r.status),
    unreadCount: Number(r.unread_count),
    lastMessageAt: new Date(r.last_message_at as string),
    lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at as string) : null,
    ownerId: (r.owner_id as string) ?? null,
    ownerName: (r.owner_name as string) ?? null,
    preview: (r.preview as string) ?? null,
    tripId: (r.trip_id as string) ?? null,
  }));
}

export async function getThread(threadId: string) {
  // The owner's NAME, not just their id: the console header has to say who has
  // this conversation, and a second round-trip for one string is silly.
  const [row] = await db
    .select({ thread: smsThreads, ownerName: users.fullName })
    .from(smsThreads)
    .leftJoin(users, eq(users.id, smsThreads.ownerId))
    .where(eq(smsThreads.id, threadId))
    .limit(1);
  if (!row) throw Errors.notFound('That conversation no longer exists.');
  const thread = { ...row.thread, ownerName: row.ownerName };

  const messages = await db
    .select({
      id: smsMessages.id,
      direction: smsMessages.direction,
      body: smsMessages.body,
      channel: smsMessages.channel,
      status: smsMessages.status,
      failureReason: smsMessages.failureReason,
      createdAt: smsMessages.createdAt,
      sentById: smsMessages.sentById,
      sentByName: users.fullName,
    })
    .from(smsMessages)
    .leftJoin(users, eq(users.id, smsMessages.sentById))
    .where(eq(smsMessages.threadId, threadId))
    .orderBy(asc(smsMessages.createdAt));

  return { thread, messages };
}

/** Marks everything in the thread read by this dispatcher. */
export async function markRead(actor: AuditActor, threadId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(smsMessages)
      .set({ readAt: new Date(), readById: actor.userId })
      .where(and(eq(smsMessages.threadId, threadId), isNull(smsMessages.readAt)));
    await tx.update(smsThreads).set({ unreadCount: 0 }).where(eq(smsThreads.id, threadId));
  });
}

/**
 * Takes ownership of a conversation.
 *
 * Ownership is how two dispatchers avoid answering the same person twice — the
 * single most common complaint about a shared inbox. Claiming is not exclusive:
 * anyone may reply, but the queue shows who has it.
 */
export async function claimThread(actor: AuditActor, threadId: string) {
  const [row] = await db
    .update(smsThreads)
    .set({ ownerId: actor.userId, updatedAt: new Date() })
    .where(eq(smsThreads.id, threadId))
    .returning();
  if (!row) throw Errors.notFound('That conversation no longer exists.');
  await recordAudit({
    actor,
    action: 'conversation.claimed',
    entityType: 'sms_thread',
    entityId: threadId,
    next: { ownerId: actor.userId },
  });
  return row;
}

export async function releaseThread(actor: AuditActor, threadId: string) {
  const [row] = await db
    .update(smsThreads)
    .set({ ownerId: null, updatedAt: new Date() })
    .where(eq(smsThreads.id, threadId))
    .returning();
  if (!row) throw Errors.notFound('That conversation no longer exists.');
  await recordAudit({
    actor,
    action: 'conversation.released',
    entityType: 'sms_thread',
    entityId: threadId,
  });
  return row;
}

export async function setThreadStatus(actor: AuditActor, threadId: string, status: string) {
  if (!THREAD_STATUSES.includes(status as never)) {
    throw Errors.validation(`status must be one of: ${THREAD_STATUSES.join(', ')}`);
  }
  const row = await db.transaction(async (tx) => {
    // Closing a conversation means it has been dealt with, so it stops being
    // unread. Otherwise the queue badge counts work somebody already finished.
    if (status === 'closed') {
      await tx
        .update(smsMessages)
        .set({ readAt: new Date(), readById: actor.userId })
        .where(and(eq(smsMessages.threadId, threadId), isNull(smsMessages.readAt)));
    }
    const [updated] = await tx
      .update(smsThreads)
      .set({
        status,
        ...(status === 'closed' ? { unreadCount: 0 } : {}),
        closedAt: status === 'closed' ? new Date() : null,
        closedById: status === 'closed' ? actor.userId : null,
        updatedAt: new Date(),
      })
      .where(eq(smsThreads.id, threadId))
      .returning();
    return updated;
  });
  if (!row) throw Errors.notFound('That conversation no longer exists.');
  await recordAudit({
    actor,
    action: `conversation.${status}`,
    entityType: 'sms_thread',
    entityId: threadId,
    next: { status },
  });
  return row;
}

/**
 * Sends a reply.
 *
 * Two paths on purpose. A thread belonging to a known volunteer goes through
 * `notify()`, so the message gets a delivery record, retries and failure
 * visibility like everything else. A thread belonging to a caller or an unknown
 * number has no user row to notify, so it is sent directly and the outcome is
 * written onto the message. Both end up as a row on the thread.
 */
export async function replyToThread(
  actor: AuditActor,
  threadId: string,
  body: string,
): Promise<{ messageId: string }> {
  const text = body.trim();
  if (!text) throw Errors.validation('An empty message cannot be sent.');
  if (text.length > 1200) {
    throw Errors.validation('That is longer than eight SMS segments — shorten it.');
  }

  const [thread] = await db.select().from(smsThreads).where(eq(smsThreads.id, threadId)).limit(1);
  if (!thread) throw Errors.notFound('That conversation no longer exists.');

  if (thread.userId) {
    await notify({
      userId: thread.userId,
      event: 'sms.reply_received',
      title: 'Message from dispatch',
      body: text,
      threadId,
      forceChannels: ['sms'],
    });
    // notify() writes the thread message once the send succeeds, so the console
    // never shows a reply that did not actually leave.
    await recordAudit({
      actor,
      action: 'conversation.replied',
      entityType: 'sms_thread',
      entityId: threadId,
      next: { length: text.length, via: 'notification' },
    });
    return { messageId: '' };
  }

  const { smsProvider } = await import('../services/providers/index.js');
  let providerSid: string | null = null;
  let status = 'sent';
  let failureReason: string | null = null;
  try {
    const result = await smsProvider.send(thread.phone, text);
    providerSid = result.providerMessageId;
  } catch (err) {
    status = 'failed';
    failureReason = (err as Error).message.slice(0, 500);
    logger.error({ err, threadId }, 'reply to a non-volunteer thread failed to send');
  }

  const [message] = await db
    .insert(smsMessages)
    .values({
      threadId,
      direction: 'outbound',
      body: text,
      channel: 'sms',
      providerSid,
      sentById: actor.userId,
      status,
      failureReason,
    })
    .returning();

  await recordAudit({
    actor,
    action: 'conversation.replied',
    entityType: 'sms_thread',
    entityId: threadId,
    next: { length: text.length, via: 'direct', status },
  });

  if (status === 'failed') {
    throw Errors.upstream(`The message could not be sent: ${failureReason}`);
  }
  return { messageId: message!.id };
}

/** Links a conversation to a trip, so the job card shows what was said. */
export async function attachThreadToTrip(actor: AuditActor, threadId: string, tripId: string | null) {
  const [row] = await db
    .update(smsThreads)
    .set({ tripId, updatedAt: new Date() })
    .where(eq(smsThreads.id, threadId))
    .returning();
  if (!row) throw Errors.notFound('That conversation no longer exists.');
  await recordAudit({
    actor,
    action: 'conversation.attached',
    entityType: 'sms_thread',
    entityId: threadId,
    next: { tripId },
  });
  return row;
}

/** Messages relating to one trip, for the job card's communication history. */
export async function messagesForTrip(tripId: string) {
  return db
    .select({
      id: smsMessages.id,
      threadId: smsMessages.threadId,
      direction: smsMessages.direction,
      body: smsMessages.body,
      createdAt: smsMessages.createdAt,
      displayName: smsThreads.displayName,
      phone: smsThreads.phone,
    })
    .from(smsMessages)
    .innerJoin(smsThreads, eq(smsThreads.id, smsMessages.threadId))
    .where(eq(smsThreads.tripId, tripId))
    .orderBy(desc(smsMessages.createdAt))
    .limit(50);
}

export async function unreadThreadCount(): Promise<number> {
  const [row] = await db
    .select({ n: raw<number>`count(*)::int` })
    .from(smsThreads)
    .where(and(eq(smsThreads.status, 'open'), raw`${smsThreads.unreadCount} > 0`));
  return row?.n ?? 0;
}

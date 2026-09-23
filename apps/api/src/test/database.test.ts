import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditEvents, trips } from '../db/schema.js';
import { api, createTestUser, getApp, rejectsWith, resetDb, sampleTrip, shutdown, type TestUser } from './harness.js';

/**
 * Database guarantees.
 *
 * These assert the invariants the application must not be able to violate even
 * if a future code path forgets to check — the difference between "we are
 * careful" and "it cannot happen".
 */
describe('database guarantees', () => {
  let dispatcher: TestUser;

  beforeAll(async () => { await getApp(); });
  afterAll(async () => { await shutdown(); });
  beforeEach(async () => {
    await resetDb();
    dispatcher = await createTestUser({ role: 'dispatcher', groups: [] });
  });

  it('refuses a trip in an engaged state with no volunteer', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    // The exact shape of the audit's headline defect.
    await rejectsWith(
      db.execute(sql`update trips set status = 'accepted' where id = ${tripId}`),
      /trips_engaged_requires_volunteer_chk/
    );
  });

  it('refuses a cancelled trip with no reason', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await rejectsWith(
      db.execute(sql`update trips set status = 'cancelled', cancelled_at = now() where id = ${tripId}`),
      /trips_cancelled_has_reason_chk/
    );
  });

  it('refuses an unknown status', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await rejectsWith(
      db.execute(sql`update trips set status = 'whatever' where id = ${tripId}`),
      /trips_status_chk/
    );
  });

  it('refuses a non-E.164 phone number', async () => {
    await rejectsWith(
      db.execute(sql`update users set phone = '5145551234' where id = ${dispatcher.id}`),
      /users_phone_e164_chk/
    );
  });

  it('keeps phone numbers unique among live users, so SMS resolves one person', async () => {
    const a = await createTestUser({ role: 'volunteer' });
    const b = await createTestUser({ role: 'volunteer' });
    await rejectsWith(
      db.execute(sql`update users set phone = ${a.phone} where id = ${b.id}`),
      /users_phone_live_uq/
    );
  });

  it('allows at most one accepted offer per trip', async () => {
    const v1 = await createTestUser({ role: 'volunteer' });
    const v2 = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/offer`, { cookie: dispatcher.cookie, payload: {} });
    await api('POST', `/api/trips/${tripId}/claim`, { cookie: v1.cookie, payload: {} });
    void v2;
    await rejectsWith(
      db.execute(sql`update trip_offers set status = 'accepted', responded_at = now() where trip_id = ${tripId} and status <> 'accepted'`),
      /trip_offers_one_accepted_uq/
    );
  });

  it('allows at most one live assignment per trip', async () => {
    const v = await createTestUser({ role: 'volunteer' });
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await api('POST', `/api/trips/${tripId}/assign`, { cookie: dispatcher.cookie, payload: { volunteerId: v.id } });
    await rejectsWith(
      db.execute(sql`
        insert into trip_assignments (trip_id, volunteer_id, source)
        values (${tripId}, ${v.id}, 'dispatcher')
      `),
      /trip_assignments_one_live_uq/
    );
  });

  it('makes audit_events append-only', async () => {
    await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const before = await db.select().from(auditEvents);
    expect(before.length).toBeGreaterThan(0);

    await rejectsWith(db.execute(sql`update audit_events set action = 'tampered'`), /append-only/);
    await rejectsWith(db.execute(sql`delete from audit_events`), /append-only/);

    const after = await db.select().from(auditEvents);
    expect(after).toHaveLength(before.length);
  });

  it('rolls the whole transaction back when any step fails', async () => {
    const countTrips = async () => (await db.select().from(trips)).length;
    const before = await countTrips();
    await rejectsWith(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into addresses (line1) values ('1 Test'), ('2 Test')
        `);
        await tx.execute(sql`
          insert into trips (reference, status, group_id, pickup_address_id, dropoff_address_id, pickup_at)
          select 'TX-1', 'pending', (select id from volunteer_groups limit 1),
                 (select id from addresses limit 1), (select id from addresses offset 1 limit 1), now()
        `);
        throw new Error('deliberate failure after the writes');
      }),
      /deliberate failure/
    );
    expect(await countTrips()).toBe(before);
  });

  it('enforces referential integrity on the assigned volunteer', async () => {
    const created = await api('POST', '/api/trips', { cookie: dispatcher.cookie, payload: sampleTrip() });
    const tripId = (created.body.trip as { id: string }).id;
    await rejectsWith(
      db.execute(sql`
        update trips set status = 'assigned', assigned_volunteer_id = '00000000-0000-0000-0000-000000000000'
        where id = ${tripId}
      `),
      /foreign key|violates/i
    );
  });

  it('issues unique trip references even under concurrency', async () => {
    const refs = await Promise.all(
      Array.from({ length: 25 }, () =>
        db.execute(sql`select next_trip_reference() as reference`) as unknown as Promise<Array<{ reference: string }>>,
      ),
    );
    const values = refs.map((r) => r[0]!.reference);
    expect(new Set(values).size).toBe(25);
  });
});

import { sql as raw } from 'drizzle-orm';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { recordAudit, SYSTEM_ACTOR } from '../lib/audit.js';

export interface PersonalRetentionPolicy {
  removedLicenceDays: number;
  rejectedApplicationDays: number;
  oldTripDays: number;
}

/** The scheduled entry point stays off until an owner-approved policy is configured. */
export async function cleanupPersonalRetention(): Promise<{ disabled: boolean }> {
  if (!env.PERSONAL_RETENTION_ENABLED) return { disabled: true };
  const policy = {
    removedLicenceDays: env.REMOVED_LICENCE_RETENTION_DAYS,
    rejectedApplicationDays: env.REJECTED_APPLICATION_RETENTION_DAYS,
    oldTripDays: env.OLD_TRIP_PERSONAL_RETENTION_DAYS,
  };
  if (Object.values(policy).some((days) => !days)) throw new Error('All approved personal retention periods must be configured');
  await applyPersonalRetention(policy as PersonalRetentionPolicy);
  return { disabled: false };
}

/** Separately callable for isolated restore/test rehearsal. Never assumes proposed periods. */
export async function applyPersonalRetention(policy: PersonalRetentionPolicy): Promise<void> {
  if (Object.values(policy).some((days) => !Number.isInteger(days) || days <= 0)) throw new Error('Positive integer retention periods required');
  const cutoff = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  await db.transaction(async (tx) => {
    // A private replacement avoids modifying a shared directory/recurring-ride address.
    const oldTrips = await tx.execute(raw`
      select id, pickup_address_id, dropoff_address_id from trips where status in ('completed', 'cancelled')
        and coalesce(completed_at, cancelled_at) < ${cutoff(policy.oldTripDays)}::timestamptz
        and (caller_name is not null or caller_phone is not null or passenger_notes is not null
          or exists (select 1 from addresses a where a.id in (trips.pickup_address_id, trips.dropoff_address_id) and a.line1 <> '[retained trip address removed]'))
      for update
    `);
    for (const trip of oldTrips) {
      const address = await tx.execute(raw`insert into addresses (line1, city, province, country) values ('[retained trip address removed]', '', '', '') returning id`);
      await tx.execute(raw`update trips set pickup_address_id = ${address[0]!.id}, dropoff_address_id = ${address[0]!.id}, caller_id = null,
        caller_name = null, caller_phone = null, callback_number = null, passenger_notes = null,
        pickup_entrance = null, pickup_parking = null, dropoff_entrance = null, dropoff_parking = null,
        cancellation_reason = null where id = ${trip.id}`);
      for (const oldAddress of [trip.pickup_address_id, trip.dropoff_address_id]) {
        await tx.execute(raw`delete from addresses a where a.id = ${oldAddress}
          and not exists (select 1 from trips where pickup_address_id = a.id or dropoff_address_id = a.id)
          and not exists (select 1 from recurring_rides where pickup_address_id = a.id or dropoff_address_id = a.id)
          and not exists (select 1 from contacts where address_id = a.id)
          and not exists (select 1 from caller_addresses where address_id = a.id)`);
      }
      await recordAudit({ actor: SYSTEM_ACTOR, action: 'retention.trip_personal_scrubbed', entityType: 'trip', entityId: String(trip.id), metadata: { days: policy.oldTripDays } }, tx);
    }
    const applications = await tx.execute(raw`update volunteer_applications set full_name = '[removed]', email = '', phone = '',
      address_line = null, city = null, postal_code = null, service_area = null, availability_note = null,
      referred_by = null, notes = null, submitted_ip = null, submitted_user_agent = null, review_notes = null,
      info_request_message = null, availability = null
      where status = 'rejected' and reviewed_at < ${cutoff(policy.rejectedApplicationDays)}::timestamptz and full_name <> '[removed]' returning id`);
    for (const application of applications) await recordAudit({ actor: SYSTEM_ACTOR, action: 'retention.application_personal_scrubbed', entityType: 'volunteer_application', entityId: String(application.id), metadata: { days: policy.rejectedApplicationDays } }, tx);
    const licences = await tx.execute(raw`select l.id, l.front_file_id, l.back_file_id from driver_licences l left join users u on u.id = l.user_id left join volunteer_applications a on a.id = l.application_id
      where (u.deleted_at < ${cutoff(policy.removedLicenceDays)}::timestamptz or (a.status = 'rejected' and a.reviewed_at < ${cutoff(policy.rejectedApplicationDays)}::timestamptz)) and (l.front_file_id is not null or l.back_file_id is not null) for update of l`);
    for (const licence of licences) {
      await tx.execute(raw`update driver_licences set front_file_id = null, back_file_id = null where id = ${licence.id}`);
      for (const file of [licence.front_file_id, licence.back_file_id]) {
        if (!file) continue;
        // Never erase a file still referenced by another licence or export.
        await tx.execute(raw`update stored_files set purge_after = ${new Date().toISOString()}::timestamptz where id = ${file}
          and not exists (select 1 from driver_licences where front_file_id = ${file} or back_file_id = ${file})
          and not exists (select 1 from data_exports where file_id = ${file})`);
      }
      await recordAudit({ actor: SYSTEM_ACTOR, action: 'retention.licence_images_scheduled', entityType: 'driver_licence', entityId: String(licence.id), metadata: { days: policy.removedLicenceDays } }, tx);
    }
  });
}

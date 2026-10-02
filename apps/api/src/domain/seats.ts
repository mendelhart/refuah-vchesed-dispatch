import { sql as raw } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { Errors } from '../lib/errors.js';
import { isOn } from '../lib/flags.js';

/** Seats a trip's passengers need (0 when none are listed or the feature is off). */
export async function seatsNeeded(tripId: string, exec: Executor = db): Promise<number> {
  if (!isOn('multiLegTrips')) return 0;
  const [r] = await exec.execute<{ n: number }>(raw`
    select coalesce(sum(seats), 0)::int as n from trip_passengers where trip_id = ${tripId}`);
  return Number(r?.n ?? 0);
}

/**
 * Refuses a driver whose recorded car is too small for the listed
 * passengers. A driver with no seat count on file is not refused: unknown is
 * not "too small". No passengers listed (every existing trip): no check.
 */
export async function assertSeats(exec: Executor, tripId: string, volunteerId: string): Promise<void> {
  const need = await seatsNeeded(tripId, exec);
  if (need === 0) return;
  const [v] = await exec.execute<{ seats: number | null; full_name: string }>(raw`
    select vehicle_seats as seats, full_name from users where id = ${volunteerId}`);
  if (v && v.seats !== null && Number(v.seats) < need) {
    throw Errors.conflict(`This ride needs ${need} seats; ${v.full_name}'s car has ${v.seats}.`, { seatsNeeded: need, seatsAvailable: Number(v.seats) });
  }
}

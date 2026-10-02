import { z } from 'zod';
import { MOBILITY_NEEDS } from './domain.js';
import { addressSchema, createTripSchema } from './schemas.js';

/**
 * Journeys: one person's outing made of several rides ("legs").
 *
 * Each leg is an ordinary trip, so offers, reminders, reassignment and
 * cancellation work per leg exactly as they do for any ride, and a driver
 * only ever sees the legs they drive. The journey just ties the legs
 * together for the coordinator.
 */

export const JOURNEY_KINDS = ['one_way', 'round_trip', 'multi_stop'] as const;
export type JourneyKind = (typeof JOURNEY_KINDS)[number];
export const RETURN_MODES = ['none', 'scheduled', 'call_when_ready'] as const;
export type ReturnMode = (typeof RETURN_MODES)[number];

export const passengerSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(120),
  mobilityNeeds: z.array(z.enum(MOBILITY_NEEDS)).max(6).default([]),
  seats: z.number().int().min(1).max(8).default(1),
  notes: z.string().trim().max(500).optional().nullable(),
});
export type PassengerInput = z.infer<typeof passengerSchema>;

export const journeyStopSchema = z.object({
  address: addressSchema,
  /** When the driver leaves this stop for the next one. */
  departAt: z.coerce.date(),
  entrance: z.string().trim().max(300).optional().nullable(),
});

export const journeyReturnSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('scheduled'), pickupAt: z.coerce.date() }),
  /** No time yet: the passenger calls when the appointment ends. */
  z.object({ mode: z.literal('call_when_ready'), expectedAt: z.coerce.date().optional().nullable() }),
]);

export const createJourneySchema = z
  .object({
    /** The first leg, exactly as a single ride is described. */
    trip: createTripSchema,
    /** Stops between pickup and final drop-off, in order. */
    stops: z.array(journeyStopSchema).max(4).default([]),
    return: journeyReturnSchema.default({ mode: 'none' }),
    passengers: z.array(passengerSchema).max(8).default([]),
  })
  .superRefine((val, ctx) => {
    let last = val.trip.pickupAt.getTime();
    val.stops.forEach((stop, i) => {
      if (stop.departAt.getTime() <= last) {
        ctx.addIssue({ code: 'custom', path: ['stops', i, 'departAt'], message: 'Each stop must leave after the one before' });
      }
      last = stop.departAt.getTime();
    });
    if (val.return.mode === 'scheduled' && val.return.pickupAt.getTime() <= last) {
      ctx.addIssue({ code: 'custom', path: ['return', 'pickupAt'], message: 'The ride home must be after the ride there' });
    }
  });
export type CreateJourneyInput = z.infer<typeof createJourneySchema>;

export const returnReadySchema = z.object({
  /** When to pick the passenger up; defaults to now. */
  pickupAt: z.coerce.date().optional(),
});

export const replacePassengersSchema = z.object({
  passengers: z.array(passengerSchema).max(8),
});

export interface JourneyLegView {
  legIndex: number;
  isReturn: boolean;
  tripId: string;
  reference: string;
  status: string;
  pickupAt: string;
  from: string;
  to: string;
  volunteerName: string | null;
}

export interface JourneyView {
  id: string;
  kind: JourneyKind;
  returnMode: ReturnMode;
  returnExpectedAt: string | null;
  returnCalledAt: string | null;
  awaitingReturnCall: boolean;
  legs: JourneyLegView[];
  passengers: Array<{ name: string; mobilityNeeds: string[]; seats: number; notes: string | null }>;
  seatsNeeded: number;
}

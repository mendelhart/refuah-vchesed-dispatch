import { z } from 'zod';
import { createTripSchema, phoneInputSchema, uuidSchema } from './schemas.js';

/** Package delivery and lift assist (item 6). */

export const PACKAGE_SIZES = ['small', 'medium', 'large'] as const;

export const packageDetailsSchema = z.object({
  description: z.string().trim().min(1, 'Say what is being delivered').max(300),
  size: z.enum(PACKAGE_SIZES),
  weightKg: z.coerce.number().positive().max(500).optional().nullable(),
  recipientName: z.string().trim().min(1, 'Who receives it?').max(120),
  recipientPhone: phoneInputSchema.optional().nullable(),
  handlingNotes: z.string().trim().max(500).optional().nullable(),
});

/** A package delivery: the trip (pickup, drop-off, time) plus the package. */
export const createPackageSchema = z.object({
  trip: createTripSchema,
  package: packageDetailsSchema,
});

export const proofOfDeliverySchema = z.object({
  receivedBy: z.string().trim().min(1, 'Who took it?').max(120),
  note: z.string().trim().max(500).optional().nullable(),
});

/** Never more than this many people asked at once: no blasts. */
export const LIFT_ASSIST_MAX_AUDIENCE = 20;

export const createLiftAssistSchema = z.object({
  title: z.string().trim().min(1).max(120),
  location: z.string().trim().min(3).max(300),
  startsAt: z.coerce.date(),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  needed: z.number().int().min(2, 'Lift assist needs at least 2 people').max(10),
  area: z.string().trim().max(80).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const liftAssistAudienceSchema = z.object({
  /** Narrow the suggested people to these (all must be suggestions). */
  userIds: z.array(uuidSchema).min(1).max(LIFT_ASSIST_MAX_AUDIENCE).optional(),
});

export const liftAssistInviteSchema = z.object({
  userIds: z.array(uuidSchema).min(1, 'Choose who to ask').max(LIFT_ASSIST_MAX_AUDIENCE),
  audienceHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});

export const liftAssistRespondSchema = z.object({ accept: z.boolean() });

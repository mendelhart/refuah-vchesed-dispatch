import { z } from 'zod';
import { uuidSchema } from './schemas.js';

/** Food operations (item 5). */

const money = z.coerce.number().min(0).max(100000);

export const foodVendorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal('').transform(() => null)),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const foodItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(30).default('each'),
  vendorId: uuidSchema.optional().nullable(),
  onHand: money.default(0),
  parLevel: money.optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

/** Count a delivery in, or what was used. */
export const stockAdjustSchema = z.object({
  change: z.coerce.number().min(-100000).max(100000).refine((n) => n !== 0, 'Enter an amount'),
  reason: z.string().trim().min(1, 'Say why').max(200),
});

export const prepSlotSchema = z.object({
  title: z.string().trim().min(1).max(120),
  weekday: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  staffNeeded: z.number().int().min(1).max(50).default(1),
  notes: z.string().trim().max(1000).optional().nullable(),
  items: z.array(z.object({ itemId: uuidSchema, quantity: z.coerce.number().positive().max(100000) })).max(50).default([]),
}).refine((s) => s.startMinute < s.endMinute, { message: 'The slot must end after it starts', path: ['endMinute'] });

export const prepSignupSchema = z.object({
  onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-05'),
});

export const distributionRunSchema = z.object({
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  route: z.string().trim().min(1, 'Describe the route').max(2000),
  recipientsCount: z.number().int().min(0).max(10000).default(0),
  volunteerIds: z.array(uuidSchema).max(30).default([]),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const shoppingListSchema = z.object({
  title: z.string().trim().min(1).max(120),
  items: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    quantity: z.coerce.number().positive().max(100000),
    unit: z.string().trim().min(1).max(30).default('each'),
  })).min(1, 'Add at least one item').max(100),
});

/** At most this many people per send: a shopping list goes to a few
 *  shoppers, never to the whole roster. */
export const SHOPPING_LIST_MAX_AUDIENCE = 25;

export const shoppingListAudienceSchema = z.object({
  userIds: z.array(uuidSchema).min(1, 'Choose who should get the list').max(SHOPPING_LIST_MAX_AUDIENCE),
});

export const shoppingListSendSchema = shoppingListAudienceSchema.extend({
  /** From the preview: proves the sender saw exactly these people. */
  audienceHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});

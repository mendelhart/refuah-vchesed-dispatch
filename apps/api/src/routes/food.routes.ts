import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  distributionRunSchema, foodItemSchema, foodVendorSchema, prepSignupSchema, prepSlotSchema,
  shoppingListAudienceSchema, shoppingListSchema, shoppingListSendSchema, stockAdjustSchema, uuidSchema,
} from '@rvc/shared';
import { actorFrom, currentUser, requireAuth, requireDispatcher } from '../auth/guards.js';
import { requireFlag } from '../lib/flags.js';
import {
  adjustStock, createItem, createPrepSlot, createRun, createShoppingList, createVendor, getShoppingList,
  listItems, listRuns, listShoppingLists, listVendors, previewShoppingList, sendShoppingList, setPrepSlotActive,
  setRunStatus, signUp, upcomingSlots, withdraw,
} from '../domain/food.service.js';

/** Food operations (item 5). 404 everywhere while FOOD_OPS_ENABLED is off;
 *  role guards run first. Coordinators run it; volunteers see preparation
 *  slots and sign themselves up, and see the runs they are on. */
const on = requireFlag('foodOps');
const staff = [requireDispatcher, on];
const signedIn = [requireAuth, on];
const idParam = z.object({ id: uuidSchema });
const isStaff = (role: string) => role === 'dispatcher' || role === 'admin';

export async function foodRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/food/vendors', { preHandler: staff }, async () => ({ vendors: await listVendors() }));
  app.post('/api/food/vendors', { preHandler: staff }, async (req, reply) => {
    const id = await createVendor(actorFrom(req), foodVendorSchema.parse(req.body));
    reply.status(201);
    return { id };
  });

  app.get('/api/food/items', { preHandler: staff }, async () => ({ items: await listItems() }));
  app.post('/api/food/items', { preHandler: staff }, async (req, reply) => {
    const id = await createItem(actorFrom(req), foodItemSchema.parse(req.body));
    reply.status(201);
    return { id };
  });
  app.post('/api/food/items/:id/adjust', { preHandler: staff, config: { idempotent: true } }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = stockAdjustSchema.parse(req.body);
    return { onHand: await adjustStock(actorFrom(req), id, body.change, body.reason) };
  });

  app.post('/api/food/prep-slots', { preHandler: staff }, async (req, reply) => {
    const id = await createPrepSlot(actorFrom(req), prepSlotSchema.parse(req.body));
    reply.status(201);
    return { id };
  });
  app.post('/api/food/prep-slots/:id/stop', { preHandler: staff }, async (req) => {
    await setPrepSlotActive(actorFrom(req), idParam.parse(req.params).id, false);
    return { ok: true };
  });
  app.get('/api/food/prep-slots/upcoming', { preHandler: signedIn }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(28).default(14) }).parse(req.query);
    const user = currentUser(req);
    return { slots: await upcomingSlots(days, user.id, isStaff(user.role)) };
  });
  app.post('/api/food/prep-slots/:id/signup', { preHandler: signedIn }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { onDate } = prepSignupSchema.parse(req.body);
    return signUp(actorFrom(req), id, currentUser(req).id, onDate);
  });
  app.post('/api/food/prep-slots/:id/withdraw', { preHandler: signedIn }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { onDate } = prepSignupSchema.parse(req.body);
    await withdraw(actorFrom(req), id, currentUser(req).id, onDate);
    return { ok: true };
  });

  app.get('/api/food/runs', { preHandler: signedIn }, async (req) => {
    const user = currentUser(req);
    return { runs: await listRuns({ id: user.id, isStaff: isStaff(user.role) }) };
  });
  app.post('/api/food/runs', { preHandler: staff, config: { idempotent: true } }, async (req, reply) => {
    const id = await createRun(actorFrom(req), distributionRunSchema.parse(req.body));
    reply.status(201);
    return { id };
  });
  app.post('/api/food/runs/:id/status', { preHandler: staff }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({
      status: z.enum(['planned', 'done', 'cancelled']),
      recipientsCount: z.number().int().min(0).max(10000).optional(),
    }).parse(req.body);
    await setRunStatus(actorFrom(req), id, body.status, body.recipientsCount);
    return { ok: true };
  });

  app.get('/api/food/shopping-lists', { preHandler: staff }, async () => ({ lists: await listShoppingLists() }));
  app.post('/api/food/shopping-lists', { preHandler: staff, config: { idempotent: true } }, async (req, reply) => {
    const id = await createShoppingList(actorFrom(req), shoppingListSchema.parse(req.body));
    reply.status(201);
    return { id };
  });
  app.get('/api/food/shopping-lists/:id', { preHandler: staff }, async (req) => ({
    list: await getShoppingList(idParam.parse(req.params).id),
  }));
  app.post('/api/food/shopping-lists/:id/preview', { preHandler: staff }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { userIds } = shoppingListAudienceSchema.parse(req.body);
    return previewShoppingList(id, userIds);
  });
  app.post('/api/food/shopping-lists/:id/send', { preHandler: staff }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = shoppingListSendSchema.parse(req.body);
    return sendShoppingList(actorFrom(req), id, body.userIds, body.audienceHash);
  });
}

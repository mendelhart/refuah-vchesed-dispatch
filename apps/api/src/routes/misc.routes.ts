import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { contactSchema, equipmentSchema, loanEquipmentSchema, uuidSchema, vehicleSchema } from '@rvc/shared';
import { db } from '../db/client.js';
import { addresses, contacts, equipment, equipmentCategories, equipmentLoans, organizationInfo, vehicles } from '../db/schema.js';
import { actorFrom, currentUser, requireAdmin, requireAuth, requireDispatcher } from '../auth/guards.js';
import { recordAudit } from '../lib/audit.js';
import { requirePhone } from '../lib/phone.js';
import { geocodingProvider } from '../services/providers/index.js';
import { Errors } from '../lib/errors.js';

const idParam = z.object({ id: uuidSchema });

/** Supporting CRUD. Same conventions as the dispatch core: server-side
 *  authorisation, soft delete, audit on every mutation, no unbounded reads. */
export async function miscRoutes(app: FastifyInstance): Promise<void> {
  // --- address lookup (proxied; the browser never calls the geocoder) -------
  app.get('/api/addresses/search', {
    preHandler: requireDispatcher,
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req) => {
    const q = z.object({ q: z.string().trim().min(3).max(120) }).parse(req.query);
    return { results: await geocodingProvider.search(q.q) };
  });

  // --- contacts ------------------------------------------------------------
  // A contact's address is a regular addresses row; the contact just points
  // at it, so the phone book and the trip forms speak the same address shape.
  const contactSelect = {
    contact: contacts,
    address: addresses,
  };

  app.get('/api/contacts', { preHandler: requireDispatcher }, async () => {
    const rows = await db
      .select(contactSelect)
      .from(contacts)
      .leftJoin(addresses, eq(addresses.id, contacts.addressId))
      .where(isNull(contacts.deletedAt))
      .orderBy(asc(contacts.name))
      .limit(500);
    return {
      contacts: rows.map((r) => ({
        ...r.contact,
        address: r.address
          ? {
              ...r.address,
              formatted: [r.address.line1, r.address.unit, r.address.city, r.address.province, r.address.postalCode]
                .filter(Boolean)
                .join(', '),
            }
          : null,
      })),
    };
  });

  app.post('/api/contacts', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = contactSchema.parse(req.body);
    let addressId: string | null = null;
    if (body.address) {
      const [addr] = await db.insert(addresses).values({
        line1: body.address.line1,
        unit: body.address.unit ?? null,
        city: body.address.city ?? 'Montreal',
        province: body.address.province ?? 'QC',
        postalCode: body.address.postalCode ?? null,
        country: body.address.country ?? 'CA',
        notes: body.address.notes ?? null,
        latitude: body.address.latitude ?? null,
        longitude: body.address.longitude ?? null,
      }).returning();
      addressId = addr!.id;
    }
    const [row] = await db.insert(contacts).values({
      name: body.name, phone: requirePhone(body.phone), role: body.role ?? null,
      notes: body.notes ?? null, addressId, createdById: currentUser(req).id,
    }).returning();
    await recordAudit({ actor: actorFrom(req), action: 'contact.created', entityType: 'contact', entityId: row!.id, next: { name: row!.name } });
    reply.status(201); return { contact: row };
  });

  app.patch('/api/contacts/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = contactSchema.partial().parse(req.body);
    const [before] = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
    if (!before) throw Errors.notFound('Contact');
    let addressId: string | null | undefined;
    if (body.address === null) {
      addressId = null;
    } else if (body.address) {
      const values = {
        line1: body.address.line1,
        unit: body.address.unit ?? null,
        city: body.address.city ?? 'Montreal',
        province: body.address.province ?? 'QC',
        postalCode: body.address.postalCode ?? null,
        country: body.address.country ?? 'CA',
        notes: body.address.notes ?? null,
        latitude: body.address.latitude ?? null,
        longitude: body.address.longitude ?? null,
      };
      if (before.addressId) {
        await db.update(addresses).set(values).where(eq(addresses.id, before.addressId));
        addressId = before.addressId;
      } else {
        const [addr] = await db.insert(addresses).values(values).returning();
        addressId = addr!.id;
      }
    }
    const [row] = await db.update(contacts).set({
      ...(body.name ? { name: body.name } : {}),
      ...(body.phone ? { phone: requirePhone(body.phone) } : {}),
      ...(body.role !== undefined ? { role: body.role ?? null } : {}),
      ...(body.notes !== undefined ? { notes: body.notes ?? null } : {}),
      ...(addressId !== undefined ? { addressId } : {}),
    }).where(eq(contacts.id, id)).returning();
    await recordAudit({ actor: actorFrom(req), action: 'contact.updated', entityType: 'contact', entityId: id, previous: { name: before.name }, next: { name: row!.name } });
    return { contact: row };
  });

  app.delete('/api/contacts/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    // Soft delete: a call log referencing this contact must stay readable.
    const [row] = await db.update(contacts).set({ deletedAt: new Date() })
      .where(and(eq(contacts.id, id), isNull(contacts.deletedAt))).returning();
    if (!row) throw Errors.notFound('Contact');
    await recordAudit({ actor: actorFrom(req), action: 'contact.deleted', entityType: 'contact', entityId: id, previous: { name: row.name } });
    return { ok: true };
  });

  // --- vehicles ------------------------------------------------------------
  app.get('/api/vehicles', { preHandler: requireAuth }, async () => ({
    vehicles: await db.select().from(vehicles).where(isNull(vehicles.deletedAt)).orderBy(asc(vehicles.label)).limit(500),
  }));

  app.post('/api/vehicles', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = vehicleSchema.parse(req.body);
    const [row] = await db.insert(vehicles).values(body).returning();
    await recordAudit({ actor: actorFrom(req), action: 'vehicle.created', entityType: 'vehicle', entityId: row!.id, next: { label: row!.label } });
    reply.status(201); return { vehicle: row };
  });

  app.patch('/api/vehicles/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = vehicleSchema.partial().parse(req.body);
    // An empty change used to reach the database and come back as a 500.
    if (Object.keys(body).length === 0) throw Errors.validation('Nothing to change');
    const [row] = await db.update(vehicles).set(body).where(and(eq(vehicles.id, id), isNull(vehicles.deletedAt))).returning();
    if (!row) throw Errors.notFound('Vehicle');
    await recordAudit({ actor: actorFrom(req), action: 'vehicle.updated', entityType: 'vehicle', entityId: id, next: body });
    return { vehicle: row };
  });

  app.delete('/api/vehicles/:id', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.update(vehicles).set({ deletedAt: new Date() }).where(eq(vehicles.id, id)).returning();
    if (!row) throw Errors.notFound('Vehicle');
    await recordAudit({ actor: actorFrom(req), action: 'vehicle.deleted', entityType: 'vehicle', entityId: id });
    return { ok: true };
  });

  // --- equipment -----------------------------------------------------------
  app.get('/api/equipment/categories', { preHandler: requireAuth }, async () => ({
    categories: await db.select().from(equipmentCategories).where(isNull(equipmentCategories.deletedAt)).orderBy(asc(equipmentCategories.name)),
  }));

  app.post('/api/equipment/categories', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).optional() }).parse(req.body);
    const [row] = await db.insert(equipmentCategories).values(body).returning();
    await recordAudit({ actor: actorFrom(req), action: 'equipment_category.created', entityType: 'equipment_category', entityId: row!.id, next: body });
    reply.status(201); return { category: row };
  });

  app.get('/api/equipment', { preHandler: requireAuth }, async (req) => {
    const q = z.object({
      status: z.string().max(20).optional(),
      categoryId: uuidSchema.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const conditions = [isNull(equipment.deletedAt)];
    if (q.status) conditions.push(eq(equipment.status, q.status));
    if (q.categoryId) conditions.push(eq(equipment.categoryId, q.categoryId));
    const rows = await db.select().from(equipment).where(and(...conditions)).orderBy(desc(equipment.createdAt)).limit(q.limit);
    return { equipment: rows };
  });

  app.post('/api/equipment', { preHandler: requireDispatcher }, async (req, reply) => {
    const body = equipmentSchema.parse(req.body);
    const [row] = await db.insert(equipment).values(body).returning();
    await recordAudit({ actor: actorFrom(req), action: 'equipment.created', entityType: 'equipment', entityId: row!.id, next: { itemCode: row!.itemCode, type: row!.equipmentType } });
    reply.status(201); return { equipment: row };
  });

  /** Loans are rows with a lifecycle, not fields smeared across the item, and
   *  a partial unique index makes a double loan impossible. */
  app.post('/api/equipment/:id/loan', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = loanEquipmentSchema.parse(req.body);
    const result = await db.transaction(async (tx) => {
      const [item] = await tx.select().from(equipment).where(and(eq(equipment.id, id), isNull(equipment.deletedAt))).limit(1).for('update');
      if (!item) throw Errors.notFound('Equipment');
      if (item.status !== 'available') throw Errors.conflict(`That item is ${item.status}.`);
      const [loan] = await tx.insert(equipmentLoans).values({
        equipmentId: id, borrowerName: body.borrowerName, borrowerPhone: requirePhone(body.borrowerPhone),
        borrowerAddress: body.borrowerAddress ?? null, expectedReturnAt: body.expectedReturnAt ?? null,
        notes: body.notes ?? null, loanedById: currentUser(req).id,
      }).returning();
      await tx.update(equipment).set({ status: 'loaned' }).where(eq(equipment.id, id));
      await recordAudit({ actor: actorFrom(req), action: 'equipment.loaned', entityType: 'equipment', entityId: id, metadata: { loanId: loan!.id } }, tx);
      return loan!;
    });
    return { loan: result };
  });

  app.post('/api/equipment/:id/return', { preHandler: requireDispatcher }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ condition: z.string().max(30).optional(), notes: z.string().max(500).optional() }).parse(req.body ?? {});
    await db.transaction(async (tx) => {
      const [loan] = await tx.update(equipmentLoans)
        .set({ returnedAt: new Date(), returnedById: currentUser(req).id, notes: body.notes ?? null })
        .where(and(eq(equipmentLoans.equipmentId, id), isNull(equipmentLoans.returnedAt))).returning();
      if (!loan) throw Errors.conflict('That item is not currently on loan.');
      await tx.update(equipment).set({ status: 'available', ...(body.condition ? { condition: body.condition } : {}) }).where(eq(equipment.id, id));
      await recordAudit({ actor: actorFrom(req), action: 'equipment.returned', entityType: 'equipment', entityId: id, metadata: { loanId: loan.id } }, tx);
    });
    return { ok: true };
  });

  app.get('/api/equipment/loans', { preHandler: requireDispatcher }, async (req) => {
    const q = z.object({ open: z.coerce.boolean().default(true) }).parse(req.query);
    const rows = await db.select({
      id: equipmentLoans.id, equipmentId: equipmentLoans.equipmentId,
      borrowerName: equipmentLoans.borrowerName, borrowerPhone: equipmentLoans.borrowerPhone,
      loanedAt: equipmentLoans.loanedAt, expectedReturnAt: equipmentLoans.expectedReturnAt,
      returnedAt: equipmentLoans.returnedAt, itemCode: equipment.itemCode, equipmentType: equipment.equipmentType,
    }).from(equipmentLoans).innerJoin(equipment, eq(equipment.id, equipmentLoans.equipmentId))
      .where(q.open ? isNull(equipmentLoans.returnedAt) : undefined)
      .orderBy(asc(equipmentLoans.expectedReturnAt)).limit(300);
    return { loans: rows };
  });

  // --- organisation --------------------------------------------------------
  app.get('/api/organization', { preHandler: requireAuth }, async () => {
    const [row] = await db.select().from(organizationInfo).limit(1);
    return { organization: row ?? null };
  });

  app.put('/api/organization', { preHandler: requireAdmin }, async (req) => {
    const body = z.object({
      name: z.string().trim().min(1).max(120), phone: z.string().max(30).optional().nullable(),
      email: z.string().email().optional().nullable(), website: z.string().max(200).optional().nullable(),
      addressLine: z.string().max(200).optional().nullable(), emergencyContact: z.string().max(200).optional().nullable(),
    }).parse(req.body);
    const [existing] = await db.select({ id: organizationInfo.id }).from(organizationInfo).limit(1);
    const values = { ...body, updatedById: currentUser(req).id };
    const [row] = existing
      ? await db.update(organizationInfo).set(values).where(eq(organizationInfo.id, existing.id)).returning()
      : await db.insert(organizationInfo).values(values).returning();
    await recordAudit({ actor: actorFrom(req), action: 'organization.updated', entityType: 'organization', entityId: row!.id, next: body });
    return { organization: row };
  });
}

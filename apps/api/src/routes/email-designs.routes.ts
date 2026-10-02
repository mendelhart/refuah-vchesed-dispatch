import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { emailDesignInputSchema, emailDesignUpdateSchema, uuidSchema } from '@rvc/shared';
import { actorFrom, currentUser, requireDispatcher } from '../auth/guards.js';
import { recordAudit } from '../lib/audit.js';
import { requireFlag } from '../lib/flags.js';
import {
  createDesign, getDesign, listDesigns, restoreVersion, saveDesign, setArchived, testSend,
} from '../domain/email-builder.service.js';

/** Email builder (item 9). Coordinators and admins. 404 while
 *  EMAIL_BUILDER_ENABLED is off. Test sends go to yourself only, through
 *  the fake email provider; there is no route that sends to anyone else. */
const on = requireFlag('emailBuilder');
const idParam = z.object({ id: uuidSchema });

export async function emailDesignRoutes(app: FastifyInstance): Promise<void> {
  const pre = { preHandler: [requireDispatcher, on] };

  app.get('/api/email-designs', pre, async (req) => {
    const q = z.object({ archived: z.enum(['true', 'false']).default('false') }).parse(req.query);
    return { designs: await listDesigns(q.archived === 'true') };
  });

  app.post('/api/email-designs', pre, async (req, reply) => {
    const input = emailDesignInputSchema.parse(req.body);
    const id = await createDesign(input, currentUser(req).id);
    await recordAudit({ actor: actorFrom(req), action: 'email_design.created', entityType: 'email_design', entityId: id, next: { name: input.name } });
    reply.code(201);
    return getDesign(id);
  });

  app.get('/api/email-designs/:id', pre, async (req) => getDesign(idParam.parse(req.params).id));

  app.put('/api/email-designs/:id', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = emailDesignUpdateSchema.parse(req.body);
    const version = await saveDesign(id, input, currentUser(req).id);
    await recordAudit({ actor: actorFrom(req), action: 'email_design.saved', entityType: 'email_design', entityId: id, next: { version } });
    return getDesign(id);
  });

  app.post('/api/email-designs/:id/restore', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    const { version } = z.object({ version: z.number().int().positive() }).parse(req.body);
    const now = await restoreVersion(id, version, currentUser(req).id);
    await recordAudit({ actor: actorFrom(req), action: 'email_design.restored', entityType: 'email_design', entityId: id, metadata: { from: version, version: now } });
    return getDesign(id);
  });

  app.post('/api/email-designs/:id/archive', pre, async (req) => {
    const { id } = idParam.parse(req.params);
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body);
    await setArchived(id, archived);
    await recordAudit({ actor: actorFrom(req), action: archived ? 'email_design.archived' : 'email_design.unarchived', entityType: 'email_design', entityId: id });
    return getDesign(id);
  });

  app.post('/api/email-designs/:id/test-send', {
    ...pre,
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (req) => {
    const { id } = idParam.parse(req.params);
    const result = await testSend(id, currentUser(req));
    await recordAudit({ actor: actorFrom(req), action: 'email_design.test_sent', entityType: 'email_design', entityId: id, metadata: { provider: result.provider } });
    return result;
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql as raw } from 'drizzle-orm';
import { actorFrom, currentUser, requireAuth } from '../auth/guards.js';
import { db } from '../db/client.js';
import { recordAudit } from '../lib/audit.js';
import { Errors } from '../lib/errors.js';
import { enabledLanguages } from '../lib/flags.js';

/** Languages (item 7). With LANGUAGES_ENABLED unset only English is
 *  available, so nothing changes for anyone. */
export async function languageRoutes(app: FastifyInstance): Promise<void> {
  // Public: the sign-in page offers the choice before anyone signs in.
  app.get('/api/public/languages', async () => ({ available: enabledLanguages() }));

  app.get('/api/me/locale', { preHandler: requireAuth }, async (req) => {
    const [row] = await db.execute<{ locale: string }>(raw`select locale from users where id = ${currentUser(req).id}`);
    const available = enabledLanguages();
    return { locale: available.includes(row?.locale ?? 'en') ? row!.locale : 'en', available };
  });

  app.put('/api/me/locale', { preHandler: requireAuth }, async (req) => {
    const { locale } = z.object({ locale: z.string().max(8) }).parse(req.body);
    if (!enabledLanguages().includes(locale)) throw Errors.validation('That language is not available yet.');
    const user = currentUser(req);
    const [before] = await db.execute<{ locale: string }>(raw`select locale from users where id = ${user.id}`);
    await db.execute(raw`update users set locale = ${locale} where id = ${user.id}`);
    await recordAudit({ actor: actorFrom(req), action: 'user.locale_changed', entityType: 'user', entityId: user.id, previous: { locale: before?.locale }, next: { locale } });
    return { locale };
  });
}

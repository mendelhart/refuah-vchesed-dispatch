/** Applies SQL migrations from ./drizzle. Safe to run repeatedly; used by the
 *  Docker entrypoint, by CI and by `npm run db:migrate`. */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { db, closeDb } from './client.js';
import { logger } from '../lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const folder = path.resolve(here, '../../drizzle');

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  runMigrations()
    .then(async () => {
      logger.info({ folder }, 'migrations applied');
      await closeDb();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'migration failed');
      await closeDb().catch(() => {});
      process.exit(1);
    });
}

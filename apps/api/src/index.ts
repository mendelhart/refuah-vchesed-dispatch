import { env } from './env.js';
import { logger } from './lib/logger.js';
import { buildServer } from './server.js';
import { closeDb } from './db/client.js';
import { worker } from './jobs/worker.js';
import { startEventBridge, stopEventBridge } from './routes/events.routes.js';
import { runMigrations } from './db/migrate.js';
import { logProviderSelection } from './services/providers/index.js';
import { bootstrapReferenceData } from './db/bootstrap.js';
import { bootstrapAdmin } from './db/bootstrap-admin.js';
import { initMonitoring, installProcessHandlers } from './lib/monitoring.js';

async function main(): Promise<void> {
  installProcessHandlers();
  await initMonitoring();
  await runMigrations();
  await bootstrapReferenceData();
  await bootstrapAdmin();
  logProviderSelection();

  const app = await buildServer();
  await startEventBridge();
  if (env.RUN_WORKER_IN_PROCESS) worker.start();

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    // Stop accepting work before closing the database, so nothing is left
    // half-done and no request fails with a closed pool.
    const timeout = setTimeout(() => { logger.error('shutdown timed out'); process.exit(1); }, 15_000);
    try {
      await app.close();
      await worker.stop();
      await stopEventBridge();
      await closeDb();
      clearTimeout(timeout);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});

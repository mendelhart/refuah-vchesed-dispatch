import { env } from '../env.js';
import { logger } from './logger.js';

/**
 * Error reporting.
 *
 * Deliberately dependency-free: structured logs are the baseline, and an
 * aggregator is opt-in. If SENTRY_DSN is set we try to load @sentry/node at
 * runtime; if it is not installed we say so loudly once rather than pretending
 * monitoring is on. That is the honest version of "critical failures must be
 * observable" for an organisation that may not want another vendor.
 */
type Capture = (err: unknown, context?: Record<string, unknown>) => void;

let capture: Capture = (err, context) => {
  logger.error({ err, ...context }, 'captured error');
};

export async function initMonitoring(): Promise<void> {
  if (!env.SENTRY_DSN) {
    logger.info('error aggregation not configured (SENTRY_DSN unset) — errors go to the logs only');
    return;
  }
  try {
    // Resolved at runtime and intentionally untyped: @sentry/node is an
    // optional dependency, so a static import would make the build depend on a
    // package an operator may reasonably choose not to install.
    const specifier = '@sentry/node';
    const sentry = (await import(specifier)) as unknown as {
      init: (o: Record<string, unknown>) => void;
      captureException: (e: unknown, c?: unknown) => void;
    };
    sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, tracesSampleRate: 0 });
    capture = (err, context) => {
      logger.error({ err, ...context }, 'captured error');
      try { sentry.captureException(err, { extra: context }); } catch { /* never mask the original */ }
    };
    logger.info('error aggregation enabled');
  } catch {
    logger.error(
      'SENTRY_DSN is set but @sentry/node is not installed — run `npm i @sentry/node -w @rvc/api`. Errors are going to the logs only.',
    );
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  capture(err, context);
}

/** Last line of defence: never let the process die silently. */
export function installProcessHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    captureException(reason, { source: 'unhandledRejection' });
  });
  process.on('uncaughtException', (err) => {
    captureException(err, { source: 'uncaughtException' });
    // An uncaught exception leaves the process in an unknown state; exit and
    // let the supervisor restart it rather than serving from a broken one.
    setTimeout(() => process.exit(1), 500).unref();
  });
}

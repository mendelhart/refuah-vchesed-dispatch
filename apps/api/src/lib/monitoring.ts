import { env } from '../env.js';
import { logger } from './logger.js';

/**
 * Error reporting.
 *
 * Structured logs are the baseline; @sentry/node is installed and turns on
 * only when SENTRY_DSN is set (Sentry's free plan is enough). It is loaded at
 * runtime, and if it is ever missing we say so loudly once rather than
 * pretending monitoring is on. That is the honest version of "critical failures must be
 * observable" for an organisation that may not want another vendor.
 */
type Capture = (err: unknown, context?: Record<string, unknown>) => void;
type CaptureMsg = (message: string, context?: Record<string, unknown>) => void;

let captureMsg: CaptureMsg = (message, context) => {
  logger.error({ ...context, alert: true }, message);
};

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
      captureMessage: (m: string, c?: unknown) => void;
    };
    sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, tracesSampleRate: 0 });
    capture = (err, context) => {
      logger.error({ err, ...context }, 'captured error');
      try { sentry.captureException(err, { extra: context }); } catch { /* never mask the original */ }
    };
    captureMsg = (message, context) => {
      logger.error({ ...context, alert: true }, message);
      try { sentry.captureMessage(message, { level: 'error', extra: context }); } catch { /* never throw from alerting */ }
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

/** An operational alert that is not an exception (a failing health check). */
export function captureMessage(message: string, context?: Record<string, unknown>): void {
  captureMsg(message, context);
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

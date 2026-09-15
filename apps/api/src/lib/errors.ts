/** One error vocabulary for the whole API. Routes throw these; a single
 *  handler turns them into responses. Nothing else reaches the client. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly logLevel: 'warn' | 'error' = 'warn',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: (msg = 'Sign in to continue') => new AppError(401, 'unauthorized', msg),
  forbidden: (msg = 'You do not have access to this') => new AppError(403, 'forbidden', msg),
  /**
   * Accepts either a noun ("Trip") or a whole sentence. A sentence is used as
   * written — appending " not found" to "That trip no longer exists." reads
   * like a bug to the person who sees it.
   */
  notFound: (what = 'Record') =>
    new AppError(404, 'not_found', /[.!?]$/.test(what) || what.includes(' ') ? what : `${what} not found`),
  validation: (msg: string, details?: unknown) => new AppError(422, 'validation_failed', msg, details),
  conflict: (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details),
  /** The trip moved on before this request landed. */
  staleState: (msg: string, details?: unknown) => new AppError(409, 'stale_state', msg, details),
  /** The thing existed and deliberately does not any more. */
  gone: (msg: string, details?: unknown) => new AppError(410, 'gone', msg, details),
  rateLimited: (msg = 'Too many requests. Slow down and try again.') =>
    new AppError(429, 'rate_limited', msg),
  upstream: (msg: string, details?: unknown) =>
    new AppError(502, 'upstream_failure', msg, details, 'error'),
  internal: (msg = 'Something went wrong on our side') =>
    new AppError(500, 'internal_error', msg, undefined, 'error'),
};

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

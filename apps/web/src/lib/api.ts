/**
 * The one way this app talks to the API.
 *
 * Every response goes through a single error path: a non-2xx response (or a
 * 2xx body that carries an `error` envelope, which the claim endpoints use) is
 * turned into an `ApiError` and thrown. Nothing here ever returns a silent
 * `null` on failure — the old app swallowed errors in `.catch(() => {})` and
 * dispatchers were left staring at an empty board with no idea why.
 */
import type { ApiError as ApiErrorEnvelope } from '@rvc/shared';
import { getViewAs } from './viewAs';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 409s that mean "someone else got there first". */
  get isConflict(): boolean {
    return this.status === 409 || this.code === 'already_taken' || this.code === 'conflict';
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === 'unauthorized';
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | undefined | null | readonly string[];

export function buildQuery(params: Record<string, QueryValue> | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) search.append(key, v);
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

function isErrorEnvelope(body: unknown): body is ApiErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: unknown }).error !== null
  );
}

function viewAsHeader(): Record<string, string> {
  const preview = getViewAs();
  return preview ? { 'X-View-As': preview.id } : {};
}

async function request<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      // Session lives in an httpOnly cookie; it must ride along on every call.
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(viewAsHeader()),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'network_error', 'We could not reach the server. Check your connection and try again.');
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) {
        throw new ApiError(response.status, 'bad_response', `The server returned an unexpected response (${response.status}).`);
      }
      throw new ApiError(response.status, 'bad_response', 'The server returned a response we could not read.');
    }
  }

  // The transition endpoints answer a lost race with 200-shaped bodies in some
  // proxies and 409 in others; treat an `error` envelope as an error either way.
  if (!response.ok || isErrorEnvelope(parsed)) {
    if (isErrorEnvelope(parsed)) {
      const { code, message, details, requestId } = parsed.error;
      throw new ApiError(response.status === 200 ? 409 : response.status, code, message, details, requestId);
    }
    throw new ApiError(response.status, 'http_error', httpFallbackMessage(response.status));
  }

  return parsed as T;
}

function httpFallbackMessage(status: number): string {
  if (status === 401) return 'Your session has ended. Sign in again to continue.';
  if (status === 403) return 'You do not have access to that.';
  if (status === 404) return 'We could not find that.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  return `Request failed (${status}).`;
}

export const api = {
  get: <T>(path: string, params?: Record<string, QueryValue>, signal?: AbortSignal): Promise<T> =>
    request<T>('GET', `${path}${buildQuery(params)}`, undefined, signal),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string, body?: unknown): Promise<T> => request<T>('DELETE', path, body),
};

/** Human-readable text for anything thrown by a mutation, for a toast. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Try again.';
}

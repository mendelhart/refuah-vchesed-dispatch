import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { Errors } from '../lib/errors.js';

/**
 * Checks a Google ID token (item 9, Google sign-in) without a client secret
 * and without any Google library: the token is a JWT signed with one of
 * Google's published keys. We check the signature, that it was issued by
 * Google for our client ID, that it has not expired, that Google verified the
 * email address, and that it carries the one-time value this browser asked
 * for. Anything else is refused.
 *
 * The key source can be replaced in tests, so no test ever calls Google.
 */

export interface GoogleClaims { email: string; sub: string; name?: string }

type KeySource = () => Promise<JsonWebKey[]>;

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
let cache: { keys: JsonWebKey[]; until: number } | null = null;

const fetchGoogleKeys: KeySource = async () => {
  if (cache && cache.until > Date.now()) return cache.keys;
  const res = await fetch(GOOGLE_CERTS, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Google keys: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: JsonWebKey[] };
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  cache = { keys: body.keys, until: Date.now() + Math.min(maxAge, 86_400) * 1000 };
  return body.keys;
};

let keySource: KeySource = fetchGoogleKeys;

/** Tests only: replace where Google's public keys come from. */
export function setGoogleKeySource(source: KeySource | null): void {
  keySource = source ?? fetchGoogleKeys;
  cache = null;
}

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const b64 = (s: string) => Buffer.from(s, 'base64url');

export async function verifyGoogleIdToken(
  token: string,
  expected: { clientId: string; nonce: string; now?: number },
): Promise<GoogleClaims> {
  const refuse = () => Errors.unauthorized('Google sign-in did not work. Try again, or sign in with your password.');
  const parts = token.split('.');
  if (parts.length !== 3) throw refuse();
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64(parts[0]!).toString('utf8'));
    claims = JSON.parse(b64(parts[1]!).toString('utf8'));
  } catch {
    throw refuse();
  }
  if (header.alg !== 'RS256' || !header.kid) throw refuse();

  const jwk = (await keySource()).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw refuse();
  const ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), b64(parts[2]!));
  if (!ok) throw refuse();

  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  const skew = 60;
  if (!ISSUERS.has(String(claims.iss))) throw refuse();
  if (claims.aud !== expected.clientId) throw refuse();
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw refuse();
  if (typeof claims.iat === 'number' && claims.iat - skew > now) throw refuse();
  if (claims.nonce !== expected.nonce) throw refuse();
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw refuse();
  if (typeof claims.email !== 'string' || typeof claims.sub !== 'string') throw refuse();
  return { email: claims.email.toLowerCase(), sub: claims.sub, ...(typeof claims.name === 'string' ? { name: claims.name } : {}) };
}

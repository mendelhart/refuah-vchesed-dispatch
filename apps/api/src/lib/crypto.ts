import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
  randomUUID,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing uses scrypt from the Node standard library.
 *
 * Chosen over argon2/bcrypt deliberately: both need a native build step, which
 * is the usual reason a Docker image or a new developer's machine fails to set
 * up. scrypt is memory-hard, in core since Node 10, and needs nothing installed.
 * Parameters follow OWASP's scrypt guidance (N=2^17, r=8, p=1).
 */
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Still burn comparable time so "no account" and "wrong password" look alike.
    await scrypt('dummy', randomBytes(16), KEYLEN, SCRYPT);
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const actual = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Opaque secrets (session cookies, offer tokens, invite links).
 *
 * 32 bytes of CSPRNG output, base64url. Collision and guessing are both
 * infeasible, which is the property the legacy 4-digit call_id lacked.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored hashed so a database leak does not yield live tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export { randomUUID };

// ---------------------------------------------------------------------------
// Field encryption
//
// Used for the one field the product stores that is both identifying and
// useless to us in clear: a driver's licence number. AES-256-GCM, random 12-byte
// nonce per value, authentication tag appended. The key comes from
// FIELD_ENCRYPTION_KEY and is never written to the database or the log.
//
// If the key is absent, encryptField throws rather than silently storing
// plaintext. That is deliberate: a feature that quietly degrades its own
// confidentiality is worse than one that refuses to run.
// ---------------------------------------------------------------------------

import { createCipheriv, createDecipheriv } from 'node:crypto';

const FIELD_ALGO = 'aes-256-gcm';

function fieldKey(): Buffer {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY is not configured; refusing to store sensitive data unencrypted.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return key;
}

export function fieldEncryptionAvailable(): boolean {
  try {
    fieldKey();
    return true;
  } catch {
    return false;
  }
}

/** Returns `v1.<nonce>.<tag>.<ciphertext>`, all base64url. */
export function encryptField(plaintext: string): string {
  const key = fieldKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(FIELD_ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    nonce.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

export function decryptField(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv(
      FIELD_ALGO,
      fieldKey(),
      Buffer.from(parts[1]!, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3]!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A tampered or wrong-key value is indistinguishable from corruption and is
    // treated as absent rather than throwing into a request handler.
    return null;
  }
}

export function encryptBuffer(plain: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(FIELD_ALGO, fieldKey(), nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

export function decryptBuffer(blob: Buffer): Buffer {
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const decipher = createDecipheriv(FIELD_ALGO, fieldKey(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

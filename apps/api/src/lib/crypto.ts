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

/**
 * Key ring.
 *
 * FIELD_ENCRYPTION_KEY is the current key: everything new is encrypted with it.
 * FIELD_ENCRYPTION_KEY_ID names it (default "k1"), and that id is written into
 * every new value, so a value always says which key made it.
 * FIELD_ENCRYPTION_OLD_KEYS lists retired keys as "id:base64,id:base64". They
 * are only ever used to DECRYPT, so rotating is: add the new key, move the old
 * one into OLD_KEYS, re-encrypt (scripts/rotate-field-key), and only then
 * remove the old key. Nothing is ever destroyed by a rotation.
 *
 * Values written before key ids existed (field "v1.", blobs with no header)
 * are tried against the current key and then every old key.
 */
interface KeyEntry { id: string; key: Buffer }

function decodeKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return key;
}

function currentKey(): KeyEntry {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY is not configured; refusing to store sensitive data unencrypted.',
    );
  }
  const id = (process.env.FIELD_ENCRYPTION_KEY_ID || 'k1').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error('FIELD_ENCRYPTION_KEY_ID must be 1-32 letters, digits, _ or -');
  return { id, key: decodeKey(raw, 'FIELD_ENCRYPTION_KEY') };
}

/** Retired keys, decrypt-only. Malformed entries fail loudly at use. */
export function oldKeys(): KeyEntry[] {
  const raw = process.env.FIELD_ENCRYPTION_OLD_KEYS;
  if (!raw) return [];
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf(':');
    if (i <= 0) throw new Error('FIELD_ENCRYPTION_OLD_KEYS entries must look like id:base64key');
    const id = part.slice(0, i);
    return { id, key: decodeKey(part.slice(i + 1), `FIELD_ENCRYPTION_OLD_KEYS[${id}]`) };
  });
}

function allKeys(): KeyEntry[] {
  const current = currentKey();
  return [current, ...oldKeys().filter((k) => k.id !== current.id)];
}

function keyById(id: string): Buffer | null {
  return allKeys().find((k) => k.id === id)?.key ?? null;
}

/** Id of the key new values are written with. */
export function currentKeyId(): string {
  return currentKey().id;
}

export function fieldEncryptionAvailable(): boolean {
  try {
    currentKey();
    return true;
  } catch {
    return false;
  }
}

function gcmOpen(key: Buffer, nonce: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const decipher = createDecipheriv(FIELD_ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function gcmSeal(key: Buffer, plain: Buffer): { nonce: Buffer; tag: Buffer; ct: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(FIELD_ALGO, key, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), ct };
}

/** Returns `v2.<keyId>.<nonce>.<tag>.<ciphertext>` (base64url parts). */
export function encryptField(plaintext: string): string {
  const { id, key } = currentKey();
  const { nonce, tag, ct } = gcmSeal(key, Buffer.from(plaintext, 'utf8'));
  return ['v2', id, nonce.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Which key a stored field value was written with: an id, "legacy" (v1), or null. */
export function fieldKeyId(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  const parts = encoded.split('.');
  if (parts[0] === 'v2' && parts.length === 5) return parts[1]!;
  if (parts[0] === 'v1' && parts.length === 4) return 'legacy';
  return null;
}

export function decryptField(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  const parts = encoded.split('.');
  try {
    if (parts[0] === 'v2' && parts.length === 5) {
      const key = keyById(parts[1]!);
      if (!key) return null;
      return gcmOpen(key, Buffer.from(parts[2]!, 'base64url'), Buffer.from(parts[3]!, 'base64url'),
        Buffer.from(parts[4]!, 'base64url')).toString('utf8');
    }
    if (parts[0] === 'v1' && parts.length === 4) {
      for (const { key } of allKeys()) {
        try {
          return gcmOpen(key, Buffer.from(parts[1]!, 'base64url'), Buffer.from(parts[2]!, 'base64url'),
            Buffer.from(parts[3]!, 'base64url')).toString('utf8');
        } catch {
          // try the next key
        }
      }
    }
    return null;
  } catch {
    // A tampered or wrong-key value is indistinguishable from corruption and is
    // treated as absent rather than throwing into a request handler.
    return null;
  }
}

/**
 * Blob format: "RVCK" + 1 byte id length + id + nonce(12) + tag(16) + ciphertext.
 * Blobs written before key ids existed have no header: nonce + tag + ciphertext.
 */
const BLOB_MAGIC = Buffer.from('RVCK', 'ascii');

export function encryptBuffer(plain: Buffer): Buffer {
  const { id, key } = currentKey();
  const { nonce, tag, ct } = gcmSeal(key, plain);
  const idBuf = Buffer.from(id, 'ascii');
  return Buffer.concat([BLOB_MAGIC, Buffer.from([idBuf.length]), idBuf, nonce, tag, ct]);
}

function parseHeader(blob: Buffer): { id: string; body: Buffer } | null {
  if (blob.length < 5 || !blob.subarray(0, 4).equals(BLOB_MAGIC)) return null;
  const len = blob[4]!;
  if (len < 1 || len > 32 || blob.length < 5 + len + 28) return null;
  return { id: blob.subarray(5, 5 + len).toString('ascii'), body: blob.subarray(5 + len) };
}

/** Which key a stored blob was written with: an id, or "legacy" (no header). */
export function bufferKeyId(blob: Buffer): string {
  return parseHeader(blob)?.id ?? 'legacy';
}

export function decryptBuffer(blob: Buffer): Buffer {
  const open = (key: Buffer, body: Buffer) =>
    gcmOpen(key, body.subarray(0, 12), body.subarray(12, 28), body.subarray(28));
  const header = parseHeader(blob);
  if (header) {
    const key = keyById(header.id);
    if (key) {
      try {
        return open(key, header.body);
      } catch {
        // A legacy blob whose random nonce happens to start with the magic
        // bytes falls through to the legacy path below.
      }
    }
  }
  let lastErr: unknown = new Error('no key could decrypt this file');
  for (const { key } of allKeys()) {
    try {
      return open(key, blob);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

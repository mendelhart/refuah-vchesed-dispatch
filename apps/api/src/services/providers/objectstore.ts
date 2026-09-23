import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { env } from '../../env.js';
import type { ObjectStore } from './types.js';

/**
 * Where uploaded bytes live.
 *
 * Two implementations, one interface. The local driver writes under
 * FILE_STORAGE_PATH and is the default; it is genuinely adequate for this
 * organisation's volume (a few hundred licence images) on a machine with a
 * persistent volume. The S3 driver is there so that a Fly deployment with
 * ephemeral disks, or a future move to object storage, is a configuration
 * change rather than a rewrite.
 *
 * Keys are generated, never derived from a filename, and the local driver
 * refuses any key that escapes its root — an uploaded name like
 * `../../etc/passwd` is the oldest file-upload bug there is.
 */

const ROOT = resolve(env.FILE_STORAGE_PATH);

function safePath(key: string): string {
  const full = resolve(join(ROOT, key));
  if (full !== ROOT && !full.startsWith(ROOT + '/')) {
    throw new Error(`Refusing storage key outside the storage root: ${key}`);
  }
  return full;
}

export const localObjectStore: ObjectStore = {
  name: 'local',
  async put(key, body) {
    const path = safePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, { mode: 0o600 });
  },
  async get(key) {
    return readFile(safePath(key));
  },
  async delete(key) {
    await rm(safePath(key), { force: true });
  },
  async exists(key) {
    try {
      await stat(safePath(key));
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * S3-compatible storage over the REST API with SigV4.
 *
 * Implemented directly rather than pulling in the AWS SDK: this needs four
 * operations, the SDK is ~20MB of dependency, and a signing routine we can read
 * is easier to reason about than a vendor client we cannot.
 */
import { createHmac, createHash } from 'node:crypto';

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function signedHeaders(
  method: string,
  key: string,
  payload: Buffer,
  contentType?: string,
): { url: string; headers: Record<string, string> } {
  const endpoint = env.S3_ENDPOINT!.replace(/\/$/, '');
  const host = new URL(endpoint).host;
  const path = `/${env.S3_BUCKET}/${key}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(payload);

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaderList = sortedKeys.join(';');
  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${env.S3_REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${env.S3_SECRET_ACCESS_KEY}`, dateStamp), env.S3_REGION), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  return { url: `${endpoint}${path}`, headers };
}

export const s3ObjectStore: ObjectStore = {
  name: 's3',
  async put(key, body, contentType) {
    const { url, headers } = signedHeaders('PUT', key, body, contentType);
    const res = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(body) });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text()}`);
  },
  async get(key) {
    const { url, headers } = signedHeaders('GET', key, Buffer.alloc(0));
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async delete(key) {
    const { url, headers } = signedHeaders('DELETE', key, Buffer.alloc(0));
    const res = await fetch(url, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
  },
  async exists(key) {
    const { url, headers } = signedHeaders('HEAD', key, Buffer.alloc(0));
    const res = await fetch(url, { method: 'HEAD', headers });
    return res.ok;
  },
};

/**
 * Postgres driver (FILE_STORAGE_DRIVER=db).
 *
 * For a host whose disk does not survive a deploy or restart (Render free):
 * the bytes, already encrypted for restricted files, live in
 * `stored_file_blobs`, so they are inside every database backup and restore
 * together with the rows that point at them. Fine for this volume (a few
 * hundred licence images, each capped by the upload limit); move to s3 if that
 * ever stops being true.
 */
import { eq as eqDb } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { storedFileBlobs } from '../../db/schema.js';

export const dbObjectStore: ObjectStore = {
  name: 'db',
  async put(key, body, contentType) {
    await db
      .insert(storedFileBlobs)
      .values({ storageKey: key, contentType, body })
      .onConflictDoUpdate({ target: storedFileBlobs.storageKey, set: { body, contentType } });
  },
  async get(key) {
    const [row] = await db.select({ body: storedFileBlobs.body }).from(storedFileBlobs)
      .where(eqDb(storedFileBlobs.storageKey, key)).limit(1);
    if (!row) throw Object.assign(new Error(`object not found: ${key}`), { code: 'ENOENT' });
    return row.body;
  },
  async delete(key) {
    await db.delete(storedFileBlobs).where(eqDb(storedFileBlobs.storageKey, key));
  },
  async exists(key) {
    const [row] = await db.select({ k: storedFileBlobs.storageKey }).from(storedFileBlobs)
      .where(eqDb(storedFileBlobs.storageKey, key)).limit(1);
    return !!row;
  },
};

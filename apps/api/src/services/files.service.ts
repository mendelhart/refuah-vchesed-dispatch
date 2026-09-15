import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql as raw } from 'drizzle-orm';
import { db, type Executor } from '../db/client.js';
import { storedFiles } from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { recordAudit, type AuditActor } from '../lib/audit.js';
import { decryptBuffer, encryptBuffer, fieldEncryptionAvailable, sha256Hex } from '../lib/crypto.js';
import { objectStore } from './providers/index.js';
import { logger } from '../lib/logger.js';

/**
 * Uploaded files.
 *
 * The only files this product accepts are driver licence photographs and the
 * exports it generates itself, and both are sensitive. So the rules are strict
 * and few:
 *
 *  1. Only a small allow-list of image and document types is accepted, and the
 *     type is checked against the file's own magic bytes rather than the
 *     client's `Content-Type` header, which is attacker-controlled.
 *  2. Keys are generated UUIDs. A filename never reaches the filesystem.
 *  3. Restricted files are encrypted with AES-256-GCM before they are stored,
 *     so the bytes on disk (or in a bucket, or in a backup) are useless without
 *     FIELD_ENCRYPTION_KEY.
 *  4. Reading one is an audited event. A licence photograph being looked at is
 *     a thing the organisation should be able to account for.
 */

const MAX_BYTES = 8 * 1024 * 1024;

const SIGNATURES: Array<{ type: string; ext: string; test: (b: Buffer) => boolean }> = [
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    ext: 'png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/webp',
    ext: 'webp',
    test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  },
  { type: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString() === '%PDF-' },
];

export interface StoredFileRef {
  id: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
}

/** Identifies a file by its own bytes. Returns null for anything unrecognised. */
export function sniffContentType(buffer: Buffer): { type: string; ext: string } | null {
  for (const sig of SIGNATURES) {
    if (buffer.length >= 12 && sig.test(buffer)) return { type: sig.type, ext: sig.ext };
  }
  return null;
}

export async function storeFile(
  actor: AuditActor,
  buffer: Buffer,
  opts: {
    originalName?: string | null;
    sensitivity?: 'public' | 'internal' | 'restricted';
    purgeAfterDays?: number | null;
    /** Skip content sniffing for files the server generated itself. */
    trustedContentType?: string;
  } = {},
  exec: Executor = db,
): Promise<StoredFileRef> {
  if (buffer.length === 0) throw Errors.validation('That file is empty.');
  if (buffer.length > MAX_BYTES) {
    throw Errors.validation(
      `That file is ${(buffer.length / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_BYTES / 1024 / 1024}MB — a photo of a licence taken on a phone is well under it.`,
    );
  }

  let contentType = opts.trustedContentType;
  let ext = 'bin';
  if (!contentType) {
    const sniffed = sniffContentType(buffer);
    if (!sniffed) {
      throw Errors.validation(
        'That file type is not accepted. Upload a JPEG, PNG, WebP or PDF.',
      );
    }
    contentType = sniffed.type;
    ext = sniffed.ext;
  }

  const sensitivity = opts.sensitivity ?? 'restricted';
  const encrypt = sensitivity === 'restricted';

  if (encrypt && !fieldEncryptionAvailable()) {
    throw Errors.upstream(
      'Encrypted storage is not configured (FIELD_ENCRYPTION_KEY). Refusing to store a sensitive file in clear.',
    );
  }

  const storageKey = `${sensitivity}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${ext}`;
  const payload = encrypt ? encryptBuffer(buffer) : buffer;

  await objectStore.put(storageKey, payload, contentType);

  const [row] = await exec
    .insert(storedFiles)
    .values({
      storageKey,
      contentType,
      byteSize: buffer.length,
      sha256: sha256Hex(buffer),
      sensitivity,
      encrypted: encrypt,
      originalName: opts.originalName?.slice(0, 200) ?? null,
      uploadedById: actor.userId,
      purgeAfter: opts.purgeAfterDays
        ? new Date(Date.now() + opts.purgeAfterDays * 86_400_000)
        : null,
    })
    .returning();

  await recordAudit(
    {
      actor,
      action: 'file.stored',
      entityType: 'stored_file',
      entityId: row!.id,
      next: { contentType, byteSize: buffer.length, sensitivity },
    },
    exec,
  );

  return {
    id: row!.id,
    storageKey,
    contentType,
    byteSize: buffer.length,
  };
}

export async function readFile(
  actor: AuditActor,
  fileId: string,
  reason: string,
): Promise<{ buffer: Buffer; contentType: string; originalName: string | null }> {
  const [row] = await db
    .select()
    .from(storedFiles)
    .where(and(eq(storedFiles.id, fileId), isNull(storedFiles.deletedAt)))
    .limit(1);
  if (!row) throw Errors.notFound('That file is no longer available.');

  const raw_ = await objectStore.get(row.storageKey);
  const buffer = row.encrypted ? decryptBuffer(raw_) : raw_;

  // Integrity check. A file whose bytes no longer match what was stored is a
  // corrupted backup restore or tampering, and either way must not be served
  // as if it were the original.
  if (sha256Hex(buffer) !== row.sha256) {
    logger.error({ fileId }, 'stored file failed its integrity check');
    throw Errors.upstream('That file failed its integrity check and cannot be served.');
  }

  await recordAudit({
    actor,
    action: 'file.read',
    entityType: 'stored_file',
    entityId: fileId,
    metadata: { reason, sensitivity: row.sensitivity },
  });

  return { buffer, contentType: row.contentType, originalName: row.originalName };
}

export async function deleteFile(actor: AuditActor, fileId: string, reason: string): Promise<void> {
  const [row] = await db.select().from(storedFiles).where(eq(storedFiles.id, fileId)).limit(1);
  if (!row) return;
  await objectStore.delete(row.storageKey).catch((err: unknown) => {
    logger.warn({ err, fileId }, 'object store delete failed; marking the row deleted anyway');
  });
  await db.update(storedFiles).set({ deletedAt: new Date() }).where(eq(storedFiles.id, fileId));
  await recordAudit({
    actor,
    action: 'file.deleted',
    entityType: 'stored_file',
    entityId: fileId,
    metadata: { reason },
  });
}

/** Removes files past their purge date. Run from the retention sweep. */
export async function purgeExpiredFiles(): Promise<number> {
  const due = await db
    .select({ id: storedFiles.id, storageKey: storedFiles.storageKey })
    .from(storedFiles)
    .where(and(isNull(storedFiles.deletedAt), raw`${storedFiles.purgeAfter} < now()`));
  for (const f of due) {
    await objectStore.delete(f.storageKey).catch(() => {});
    await db.update(storedFiles).set({ deletedAt: new Date() }).where(eq(storedFiles.id, f.id));
  }
  if (due.length) logger.info({ purged: due.length }, 'expired files purged');
  return due.length;
}

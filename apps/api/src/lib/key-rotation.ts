/**
 * Re-encrypt everything onto the current field key.
 *
 * Safe to run any number of times, and never destructive:
 *   * a value already on the current key is left alone;
 *   * a value is only rewritten after its new ciphertext has been decrypted
 *     back and compared to the original plaintext;
 *   * a value no configured key can open is counted and left exactly as it is
 *     (it is reported, never overwritten or deleted);
 *   * files are rewritten in place under the same storage key only after the
 *     re-encrypted bytes decrypt to content matching the stored sha256.
 *
 * Retired keys stay in FIELD_ENCRYPTION_OLD_KEYS until a run reports
 * `remaining: 0`; only then is it safe to drop them.
 */
import { eq, isNotNull, and, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { driverLicences, storedFiles, users } from '../db/schema.js';
import { objectStore } from '../services/providers/index.js';
import {
  bufferKeyId, currentKeyId, decryptBuffer, decryptField, encryptBuffer, encryptField, fieldKeyId, sha256Hex,
} from './crypto.js';
import { logger } from './logger.js';

export interface RotationReport {
  keyId: string;
  dryRun: boolean;
  fields: { checked: number; rewritten: number; unreadable: number };
  files: { checked: number; rewritten: number; unreadable: number };
  /** Values still not on the current key after this run (would be rewritten, or unreadable). */
  remaining: number;
}

function reseal(value: string): string | null {
  const plain = decryptField(value);
  if (plain === null) return null;
  const next = encryptField(plain);
  if (decryptField(next) !== plain) throw new Error('re-encryption round trip failed');
  return next;
}

export async function rotateFieldKeys(opts: { dryRun?: boolean } = {}): Promise<RotationReport> {
  const dryRun = opts.dryRun ?? false;
  const keyId = currentKeyId();
  const report: RotationReport = {
    keyId, dryRun,
    fields: { checked: 0, rewritten: 0, unreadable: 0 },
    files: { checked: 0, rewritten: 0, unreadable: 0 },
    remaining: 0,
  };

  // Driver licence numbers.
  const licences = await db
    .select({ id: driverLicences.id, v: driverLicences.numberCiphertext })
    .from(driverLicences)
    .where(isNotNull(driverLicences.numberCiphertext));
  for (const row of licences) {
    report.fields.checked++;
    if (fieldKeyId(row.v) === keyId) continue;
    const next = reseal(row.v!);
    if (next === null) { report.fields.unreadable++; report.remaining++; continue; }
    if (dryRun) { report.remaining++; continue; }
    await db.update(driverLicences).set({ numberCiphertext: next })
      .where(and(eq(driverLicences.id, row.id), eq(driverLicences.numberCiphertext, row.v!)));
    report.fields.rewritten++;
  }

  // Authenticator secrets ("enc:" prefix; "raw:" values are left as they are).
  const secretCols = [
    ['totpSecret', users.totpSecret],
    ['totpPendingSecret', users.totpPendingSecret],
  ] as const;
  for (const [name, col] of secretCols) {
    const rows = await db.select({ id: users.id, v: col }).from(users).where(isNotNull(col));
    for (const row of rows) {
      if (!row.v || !row.v.startsWith('enc:')) continue;
      report.fields.checked++;
      const inner = row.v.slice(4);
      if (fieldKeyId(inner) === keyId) continue;
      const next = reseal(inner);
      if (next === null) { report.fields.unreadable++; report.remaining++; continue; }
      if (dryRun) { report.remaining++; continue; }
      await db.update(users).set({ [name]: `enc:${next}` })
        .where(and(eq(users.id, row.id), eq(col, row.v)));
      report.fields.rewritten++;
    }
  }

  // Encrypted files.
  const files = await db
    .select({ id: storedFiles.id, storageKey: storedFiles.storageKey, sha256: storedFiles.sha256,
      contentType: storedFiles.contentType })
    .from(storedFiles)
    .where(and(eq(storedFiles.encrypted, true), isNull(storedFiles.deletedAt)));
  for (const f of files) {
    report.files.checked++;
    let blob: Buffer;
    try {
      blob = await objectStore.get(f.storageKey);
    } catch {
      report.files.unreadable++; report.remaining++; continue;
    }
    if (bufferKeyId(blob) === keyId) {
      try { decryptBuffer(blob); continue; } catch { /* header collision; treat as legacy below */ }
    }
    let plain: Buffer;
    try {
      plain = decryptBuffer(blob);
    } catch {
      report.files.unreadable++; report.remaining++; continue;
    }
    if (sha256Hex(plain) !== f.sha256) { report.files.unreadable++; report.remaining++; continue; }
    if (dryRun) { report.remaining++; continue; }
    const next = encryptBuffer(plain);
    if (sha256Hex(decryptBuffer(next)) !== f.sha256) throw new Error('file re-encryption round trip failed');
    await objectStore.put(f.storageKey, next, f.contentType);
    report.files.rewritten++;
  }

  logger.info({ rotation: report }, 'field key rotation pass finished');
  return report;
}

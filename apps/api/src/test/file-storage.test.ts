import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getApp, resetDb, shutdown } from './harness.js';
import { dbObjectStore } from '../services/providers/objectstore.js';
import { objectStore } from '../services/providers/index.js';
import { checkFileConsistency, readFile, storeFile } from '../services/files.service.js';
import { decryptBuffer, encryptBuffer } from '../lib/crypto.js';

const SYSTEM = { userId: null, name: 'test', role: 'system' as const };

beforeAll(async () => { await getApp(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await shutdown(); });

describe('db object store (FILE_STORAGE_DRIVER=db)', () => {
  it('round-trips encrypted bytes exactly, overwrites in place, deletes', async () => {
    const blob = encryptBuffer(Buffer.from('licence image bytes'));
    await dbObjectStore.put('restricted/2026-09/a.jpg', blob, 'image/jpeg');
    expect(await dbObjectStore.exists('restricted/2026-09/a.jpg')).toBe(true);
    const back = await dbObjectStore.get('restricted/2026-09/a.jpg');
    expect(back.equals(blob)).toBe(true);
    expect(decryptBuffer(back).toString()).toBe('licence image bytes');

    const blob2 = encryptBuffer(Buffer.from('v2'));
    await dbObjectStore.put('restricted/2026-09/a.jpg', blob2, 'image/jpeg');
    expect((await dbObjectStore.get('restricted/2026-09/a.jpg')).equals(blob2)).toBe(true);

    await dbObjectStore.delete('restricted/2026-09/a.jpg');
    expect(await dbObjectStore.exists('restricted/2026-09/a.jpg')).toBe(false);
    await expect(dbObjectStore.get('restricted/2026-09/a.jpg')).rejects.toThrow(/not found/);
  });
});

describe('database/object consistency', () => {
  it('a row whose bytes are gone reads as a clear 404 and is listed by the check', async () => {
    const f = await storeFile(SYSTEM, Buffer.from('%PDF-1.4 x'), { trustedContentType: 'application/pdf' });
    expect((await checkFileConsistency()).missingObjects).toHaveLength(0);

    await objectStore.delete(f.storageKey);
    await expect(readFile(SYSTEM, f.id, 'test')).rejects.toMatchObject({ statusCode: 404 });
    const r = await checkFileConsistency();
    expect(r.missingObjects.map((m) => m.id)).toEqual([f.id]);
  });

  it('bytes that no longer match their checksum are listed as corrupt and never served', async () => {
    const f = await storeFile(SYSTEM, Buffer.from('%PDF-1.4 original'), { trustedContentType: 'application/pdf' });
    await objectStore.put(f.storageKey, encryptBuffer(Buffer.from('%PDF-1.4 swapped')), 'application/pdf');
    await expect(readFile(SYSTEM, f.id, 'test')).rejects.toThrow(/integrity/);
    expect((await checkFileConsistency()).corrupt).toEqual([
      expect.objectContaining({ id: f.id, reason: 'checksum mismatch' }),
    ]);
  });
});

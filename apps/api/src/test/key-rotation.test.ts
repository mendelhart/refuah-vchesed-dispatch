import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestUser, getApp, resetDb, shutdown } from './harness.js';
import { db } from '../db/client.js';
import { driverLicences, users } from '../db/schema.js';
import {
  bufferKeyId, decryptBuffer, decryptField, encryptBuffer, encryptField, fieldKeyId,
} from '../lib/crypto.js';
import { rotateFieldKeys } from '../lib/key-rotation.js';
import { readFile, storeFile } from '../services/files.service.js';

const KEY_A = Buffer.alloc(32, 7).toString('base64'); // the suite's default key
const KEY_B = Buffer.alloc(32, 9).toString('base64');
const SYSTEM = { userId: null, name: 'test', role: 'system' as const };

/** What the code wrote before key ids existed. */
function legacyField(plain: string, keyB64: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), nonce);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', nonce.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}
function legacyBlob(plain: Buffer, keyB64: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), nonce);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]);
}

function useKeys(current: string, id: string, old?: string): void {
  process.env.FIELD_ENCRYPTION_KEY = current;
  process.env.FIELD_ENCRYPTION_KEY_ID = id;
  if (old) process.env.FIELD_ENCRYPTION_OLD_KEYS = old;
  else delete process.env.FIELD_ENCRYPTION_OLD_KEYS;
}

afterEach(() => useKeys(KEY_A, 'k1'));

describe('field key versioning', () => {
  it('writes the key id into new values and reads them back', () => {
    const v = encryptField('D1234-5678');
    expect(v.startsWith('v2.k1.')).toBe(true);
    expect(fieldKeyId(v)).toBe('k1');
    expect(decryptField(v)).toBe('D1234-5678');
    const b = encryptBuffer(Buffer.from('image'));
    expect(bufferKeyId(b)).toBe('k1');
    expect(decryptBuffer(b).toString()).toBe('image');
  });

  it('still reads values written before key ids existed', () => {
    expect(decryptField(legacyField('old-number', KEY_A))).toBe('old-number');
    expect(decryptBuffer(legacyBlob(Buffer.from('old-img'), KEY_A)).toString()).toBe('old-img');
  });

  it('after a rotation, old values stay readable through the retired key', () => {
    const before = encryptField('secret');
    const legacy = legacyField('legacy', KEY_A);
    const blob = encryptBuffer(Buffer.from('file'));
    useKeys(KEY_B, 'k2', `k1:${KEY_A}`);
    expect(decryptField(before)).toBe('secret');
    expect(decryptField(legacy)).toBe('legacy');
    expect(decryptBuffer(blob).toString()).toBe('file');
    expect(fieldKeyId(encryptField('new'))).toBe('k2');
  });

  it('a value from an unknown key or a tampered value reads as absent, not a crash', () => {
    const v = encryptField('x');
    useKeys(KEY_B, 'k2'); // k1 dropped entirely
    expect(decryptField(v)).toBeNull();
    useKeys(KEY_A, 'k1');
    const parts = v.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(decryptField(parts.join('.'))).toBeNull();
  });

  it('rejects a malformed retired-key list', () => {
    useKeys(KEY_B, 'k2', 'not-a-key');
    expect(() => decryptField(legacyField('x', KEY_A))).not.toThrow(); // decrypt swallows and returns null
    expect(decryptField(legacyField('x', KEY_A))).toBeNull();
  });
});

describe('rotateFieldKeys', () => {
  beforeAll(async () => { await getApp(); });
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await shutdown(); });

  it('moves licences, authenticator secrets and files onto the new key without losing anything', async () => {
    const u = await createTestUser({ role: 'volunteer' });
    const [lic] = await db.insert(driverLicences)
      .values({ userId: u.id, numberCiphertext: legacyField('Q1234-567890-12', KEY_A), numberLast4: '9012' })
      .returning();
    await db.update(users).set({ totpSecret: `enc:${encryptField('JBSWY3DPEHPK3PXP')}`, totpPendingSecret: 'raw:PLAIN' })
      .where(eq(users.id, u.id));
    const file = await storeFile(SYSTEM, Buffer.from('%PDF-1.4 licence image'), { trustedContentType: 'application/pdf' });

    useKeys(KEY_B, 'k2', `k1:${KEY_A}`);

    const dry = await rotateFieldKeys({ dryRun: true });
    expect(dry.remaining).toBe(3);
    expect(dry.fields.rewritten + dry.files.rewritten).toBe(0);

    const r = await rotateFieldKeys();
    expect(r.fields).toMatchObject({ rewritten: 2, unreadable: 0 });
    expect(r.files).toMatchObject({ rewritten: 1, unreadable: 0 });
    expect(r.remaining).toBe(0);

    // Now drop the old key: everything must still read.
    useKeys(KEY_B, 'k2');
    const [l2] = await db.select().from(driverLicences).where(eq(driverLicences.id, lic!.id));
    expect(fieldKeyId(l2!.numberCiphertext)).toBe('k2');
    expect(decryptField(l2!.numberCiphertext)).toBe('Q1234-567890-12');
    const [u2] = await db.select().from(users).where(eq(users.id, u.id));
    expect(decryptField(u2!.totpSecret!.slice(4))).toBe('JBSWY3DPEHPK3PXP');
    expect(u2!.totpPendingSecret).toBe('raw:PLAIN');
    const back = await readFile(SYSTEM, file.id, 'test');
    expect(back.buffer.toString()).toBe('%PDF-1.4 licence image');

    // A second pass is a no-op.
    const again = await rotateFieldKeys();
    expect(again.fields.rewritten + again.files.rewritten).toBe(0);
    expect(again.remaining).toBe(0);
  });

  it('leaves a value no key can open untouched and reports it', async () => {
    const u = await createTestUser({ role: 'volunteer' });
    const orphan = legacyField('lost', Buffer.alloc(32, 1).toString('base64'));
    const [lic] = await db.insert(driverLicences).values({ userId: u.id, numberCiphertext: orphan }).returning();
    const r = await rotateFieldKeys();
    expect(r.fields.unreadable).toBe(1);
    expect(r.remaining).toBe(1);
    const [l2] = await db.select().from(driverLicences).where(eq(driverLicences.id, lic!.id));
    expect(l2!.numberCiphertext).toBe(orphan);
  });
});

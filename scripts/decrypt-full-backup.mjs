/* global process, Buffer */
// Usage: BACKUP_PASSPHRASE supplied securely in the environment,
// node scripts/decrypt-full-backup.mjs backup.rvc output.dump
// Then pg_restore --no-owner --no-privileges -d TARGET_DATABASE output.dump
import { readFile, writeFile } from 'node:fs/promises';
import { createDecipheriv, scryptSync } from 'node:crypto';
const [input, output] = process.argv.slice(2);
if (!input || !output || !process.env.BACKUP_PASSPHRASE) throw new Error('Input, output and BACKUP_PASSPHRASE are required');
const data = await readFile(input);
if (data.subarray(0, 8).toString() !== 'RVCBKP01') throw new Error('Unsupported backup format');
const key = scryptSync(process.env.BACKUP_PASSPHRASE, data.subarray(8, 24), 32);
try {
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(24, 36));
  decipher.setAuthTag(data.subarray(36, 52));
  const plaintext = Buffer.concat([decipher.update(data.subarray(52)), decipher.final()]);
  await writeFile(output, plaintext, { mode: 0o600, flag: 'wx' });
  plaintext.fill(0);
} finally { key.fill(0); }

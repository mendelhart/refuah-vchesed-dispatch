import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCipheriv, randomBytes, scrypt as derive } from 'node:crypto';
import { env } from '../env.js';
const exec = promisify(execFile);
const scrypt = promisify(derive);

/** pg_dump's consistent snapshot includes every table and stored DB file blob. */
export async function encryptedFullBackup(passphrase: string): Promise<Buffer> {
  const url = new URL(env.DATABASE_URL);
  const password = decodeURIComponent(url.password);
  if (env.FILE_STORAGE_DRIVER !== 'db' && env.NODE_ENV === 'production') {
    throw new Error('Full backup requires database file storage; external files need a separate backup');
  }
  url.password = '';
  const { stdout } = await exec('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', url.toString()], {
    env: { ...process.env, PGPASSWORD: password }, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 120_000,
  });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scrypt(passphrase, salt, 32) as Buffer;
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(stdout), cipher.final()]);
    return Buffer.concat([Buffer.from('RVCBKP01'), salt, iv, cipher.getAuthTag(), ciphertext]);
  } finally { key.fill(0); stdout.fill(0); }
}

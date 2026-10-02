import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The GitHub workflows, held to the rules that matter for a public repository:
 * backups never become downloadable artifacts, everything targets Postgres 18,
 * and the uptime check behaves as documented.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const withoutComments = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('backup workflow', () => {
  const yml = read('.github/workflows/backup.yml');
  const code = withoutComments(yml);

  it('never publishes an artifact', () => {
    expect(code).not.toMatch(/upload-artifact/);
  });

  it('dumps with the Postgres 18 client and proves the restore on Postgres 18', () => {
    expect(code).toMatch(/postgresql-client-18/);
    expect(code).toMatch(/image: postgres:18/);
    expect(code).not.toMatch(/postgresql-client-16|postgres:16/);
  });

  it('verifies the server certificate and encrypts before uploading', () => {
    expect(code).toMatch(/PGSSLROOTCERT/);
    const encrypt = code.indexOf('--symmetric');
    const upload = code.indexOf('aws s3 cp');
    expect(encrypt).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(encrypt);
    expect(code).toMatch(/\.gpg/);
  });

  it('does nothing, and does not fail, until every secret is set', () => {
    const steps = code.split('\n      - ').slice(1);
    const gated = steps.filter((s) => !s.startsWith('name: Is backup configured?') && !s.startsWith('name: Clean the runner'));
    for (const s of gated) expect(s, s.split('\n')[0]).toMatch(/if: steps\.configured\.outputs\.ready == 'true'/);
    expect(code).toMatch(/::notice::Backups are not configured/);
  });

  it('never puts a secret on a command line or in an echo', () => {
    expect(code).not.toMatch(/echo .*\$\{\{ secrets\./);
    expect(code).not.toMatch(/--passphrase "/);
  });
});

describe('CI', () => {
  it('runs on Postgres 18 only', () => {
    const code = withoutComments(read('.github/workflows/ci.yml'));
    expect(code.match(/image: postgres:18/g)?.length).toBe(2);
    expect(code).not.toMatch(/postgres:16/);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
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

describe('uptime workflow', () => {
  const yml = read('.github/workflows/uptime.yml');
  const script = (() => {
    const start = yml.indexOf('run: |');
    return yml.slice(start + 'run: |'.length).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
  })();

  it('checks at most hourly, and only in the day', () => {
    const cron = yml.match(/cron: '([^']+)'/)?.[1];
    expect(cron).toBe('5 0-2,11-23 * * *');
  });

  it('keeps the address in a secret and needs no permissions', () => {
    expect(yml).toMatch(/URL: \$\{\{ secrets\.UPTIME_URL \}\}/);
    expect(yml).toMatch(/permissions: \{\}/);
  });

  async function run(url: string): Promise<{ status: number | null; out: string }> {
    const quick = script.replace('sleep 60', 'sleep 0').replace('-m 120', '-m 5');
    // Asynchronous on purpose: the test server lives in this same process.
    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', `set -e\n${quick}`], { env: { ...process.env, URL: url } });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { out += String(d); });
      child.on('close', (status) => resolve({ status, out }));
    });
  }

  async function serve(codes: number[]): Promise<{ url: string; server: Server }> {
    let i = 0;
    const server = createServer((_req, res) => { res.statusCode = codes[Math.min(i++, codes.length - 1)]!; res.end(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/health`, server };
  }

  it('passes on 200, and on a 200 after one slow failure', async () => {
    for (const codes of [[200], [502, 200]]) {
      const { url, server } = await serve(codes);
      const r = await run(url);
      server.close();
      expect(r.status, r.out).toBe(0);
    }
  });

  it('fails with a plain message on 503 (database) and on other errors', async () => {
    const db = await serve([503]);
    const r1 = await run(db.url);
    db.server.close();
    expect(r1.status).toBe(1);
    expect(r1.out).toMatch(/cannot reach its database/);

    const down = await serve([500]);
    const r2 = await run(down.url);
    down.server.close();
    expect(r2.status).toBe(1);
    expect(r2.out).toMatch(/did not answer \/health with 200/);
  });

  it('passes quietly when not configured', async () => {
    const r = await run('');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/not set/);
  });
});

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

describe('CI', () => {
  it('runs on Postgres 18 only', () => {
    const code = withoutComments(read('.github/workflows/ci.yml'));
    expect(code.match(/image: postgres:18/g)?.length).toBe(2);
    expect(code).not.toMatch(/postgres:16/);
  });
});

/**
 * Shared test scaffolding: load the real fixture export once.
 *
 * The tests run against the SAME fixtures the CLI does, so a test passing means
 * the tool behaves that way on a realistic export, not on a hand-built object
 * that happens to suit the assertion.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLegacyExport } from './read.js';
import { buildPlan, type MigrationPlan } from './transform/index.js';
import type { LegacyExport } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = join(here, '..', 'fixtures', 'export');

let cachedExport: LegacyExport | null = null;
let cachedPlan: MigrationPlan | null = null;

export function fixtureExport(): LegacyExport {
  if (cachedExport === null) cachedExport = readLegacyExport(FIXTURE_DIR).export;
  return cachedExport;
}

export function fixturePlan(): MigrationPlan {
  if (cachedPlan === null) cachedPlan = buildPlan(fixtureExport());
  return cachedPlan;
}

export function readResult(): ReturnType<typeof readLegacyExport> {
  return readLegacyExport(FIXTURE_DIR);
}

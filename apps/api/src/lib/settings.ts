import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS } from '@rvc/shared';
import { db, type Executor } from '../db/client.js';
import { settings } from '../db/schema.js';

/**
 * Operational timings live in the database, not in constants scattered through
 * the code, so dispatch policy can be tuned without a deploy.
 * Cached briefly because they are read on every offer.
 */
const TTL_MS = 15_000;
let cache: { at: number; values: Record<string, unknown> } | null = null;

export async function loadSettings(exec: Executor = db): Promise<Record<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const rows = await exec.select().from(settings);
  const values: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of rows) values[row.key] = row.value;
  cache = { at: Date.now(), values };
  return values;
}

export async function getNumberSetting(key: string, exec: Executor = db): Promise<number> {
  const values = await loadSettings(exec);
  const raw = values[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : (DEFAULT_SETTINGS[key] ?? 0);
}

export async function setSetting(
  key: string,
  value: unknown,
  updatedById: string | null,
  exec: Executor = db,
): Promise<void> {
  await exec
    .insert(settings)
    .values({ key, value: value as never, updatedById })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: value as never, updatedById, updatedAt: new Date() },
    });
  cache = null;
}

export async function seedDefaultSettings(exec: Executor = db): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await exec
      .insert(settings)
      .values({ key, value: value as never })
      .onConflictDoNothing({ target: settings.key });
  }
  cache = null;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

export { eq };

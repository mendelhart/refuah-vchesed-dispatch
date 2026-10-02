import type { Page } from '@playwright/test';

/** Asks the running API whether a feature is switched on (GET /api/features). */
export async function featureOn(page: Page, flag: string): Promise<boolean> {
  const features = await page.evaluate(async () => {
    const res = await fetch('/api/features', { credentials: 'include' });
    return res.ok ? ((await res.json()) as { flags?: Record<string, unknown> }) : null;
  });
  return Boolean(features?.flags?.[flag]);
}

/** A local datetime-local value some hours from now. */
export function localIn(hours: number): string {
  const when = new Date(Date.now() + hours * 3_600_000);
  return new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

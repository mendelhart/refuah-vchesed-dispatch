import type { Page } from '@playwright/test';

export const ADMIN = { email: 'admin@refuahvchesed.test', password: 'ChangeMeInDev123!' };
export const DISPATCHER = { email: 'dispatch@refuahvchesed.test', password: 'ChangeMeInDev123!' };
export const VOLUNTEER = { email: 'volunteer1@refuahvchesed.test', password: 'ChangeMeInDev123!' };

/** Where auth.setup.ts leaves each role's cookies. */
export const STATE_FILES = {
  admin: 'e2e/.auth/admin.json',
  dispatcher: 'e2e/.auth/dispatcher.json',
  volunteer: 'e2e/.auth/volunteer.json',
} as const;

export async function signIn(page: Page, who: { email: string; password: string }): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}

/**
 * Collects the failures a page can have without looking broken.
 *
 * Three sources, and one deliberate exclusion:
 *  - uncaught exceptions (`pageerror`) — always a bug
 *  - the app's own console.error calls — always worth knowing about
 *  - any 5xx response — the request succeeded in the browser's eyes but the
 *    server failed, which a screenshot will not show
 *
 * NOT included: the browser's own "Failed to load resource" line. Chromium logs
 * that for every non-2xx response including the 401 from `/api/auth/me` before
 * sign-in, which is correct behaviour and not something the app can suppress.
 * Counting it made every test fail for a reason that was not a defect.
 */
export function failOnConsoleErrors(page: Page, ignore: RegExp[] = []): string[] {
  const errors: string[] = [];
  const skip = [/Failed to load resource/i, ...ignore];

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (skip.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 500) {
      errors.push(`${response.status()} from ${new URL(response.url()).pathname}`);
    }
  });
  return errors;
}

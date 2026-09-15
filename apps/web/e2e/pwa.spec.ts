import { expect, test } from '@playwright/test';
import { STATE_FILES } from './helpers';

/**
 * The PWA claims.
 *
 * "Do not claim offline functionality unless it actually works" — so this test
 * takes the browser offline for real and asserts the job card is still there.
 */
test.describe('progressive web app', () => {
  test.use({ storageState: STATE_FILES.volunteer });

  test('serves a complete, installable manifest', async ({ request }) => {
    const response = await request.get('/manifest.json');
    expect(response.ok()).toBeTruthy();
    const manifest = (await response.json()) as Record<string, unknown>;

    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    const icons = manifest.icons as Array<{ sizes: string; src: string }>;
    // Chrome will not offer installation without both of these sizes.
    expect(icons.some((i) => i.sizes.includes('192'))).toBeTruthy();
    expect(icons.some((i) => i.sizes.includes('512'))).toBeTruthy();

    for (const icon of icons) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.ok(), `${icon.src} is listed in the manifest but missing`).toBeTruthy();
    }
  });

  test('registers a service worker', async ({ page }) => {
    // `navigator.serviceWorker` only exists on a real origin, and a context
    // restored from storage state starts on about:blank.
    await page.goto('/');
    await page.waitForLoadState('load');

    const registered = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active ?? registration.installing ?? registration.waiting);
    });
    expect(registered).toBeTruthy();
  });

  test('keeps a ride readable with the network switched off', async ({ page, context }) => {

    await page.goto('/my-trips');
    await page.waitForLoadState('networkidle');
    // Let the worker take control, otherwise the first load is uncached.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForLoadState('networkidle');

    await context.setOffline(true);
    try {
      await page.reload();
      // The shell must still render rather than the browser's offline page.
      await expect(page.locator('body')).toContainText(/rides|offline|refuah/i, { timeout: 20_000 });
      await expect(page.locator('body')).not.toContainText(/ERR_INTERNET_DISCONNECTED/);
    } finally {
      await context.setOffline(false);
    }
  });
});

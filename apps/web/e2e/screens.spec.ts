import { test } from '@playwright/test';
import { STATE_FILES } from './helpers';

/**
 * Phone-width screenshots of the main screens, uploaded by CI as the
 * "phone-screenshots" artifact so layout changes can be looked at without a
 * device. Takes pictures only; asserts nothing beyond the page loading.
 */
const SHOTS: Array<{ role: keyof typeof STATE_FILES; path: string; name: string }> = [
  { role: 'dispatcher', path: '/', name: 'dispatcher-home' },
  { role: 'dispatcher', path: '/more', name: 'dispatcher-more' },
  { role: 'dispatcher', path: '/contacts', name: 'dispatcher-contacts-all' },
  { role: 'dispatcher', path: '/volunteers', name: 'dispatcher-volunteers' },
  { role: 'admin', path: '/admin', name: 'admin-hub' },
  { role: 'admin', path: '/impact', name: 'admin-org-impact' },
  { role: 'admin', path: '/admin/settings', name: 'admin-dispatch-settings' },
  { role: 'admin', path: '/admin/people', name: 'admin-people' },
  { role: 'volunteer', path: '/', name: 'volunteer-home' },
  { role: 'volunteer', path: '/me', name: 'volunteer-my-profile' },
  { role: 'volunteer', path: '/settings', name: 'volunteer-settings' },
];

test.describe('phone screenshots', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone project only');

  for (const shot of SHOTS) {
    test(shot.name, async ({ browser }) => {
      const context = await browser.newContext({
        storageState: STATE_FILES[shot.role],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      await page.goto(shot.path);
      await page.locator('main, [role="main"]').first().waitFor({ timeout: 15_000 });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `screenshots/${shot.name}.png`, fullPage: true });
      await context.close();
    });
  }
});

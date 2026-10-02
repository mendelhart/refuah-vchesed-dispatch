import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from '../helpers';

/**
 * Item 7 in the browser at phone width: French and Hebrew (right to left),
 * chosen on the sign-in page and in Settings. Runs when LANGUAGES_ENABLED
 * includes fr and he (the features pass of scripts/e2e.sh).
 */
async function languages(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(async () => ((await (await fetch('/api/public/languages')).json()) as { available: string[] }).available);
}

test.describe('languages', () => {
  test('the sign-in page in French and in Hebrew', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    await page.goto('/login');
    test.skip(!(await languages(page)).includes('he'), 'French and Hebrew are off');

    await page.getByRole('radio', { name: 'Français' }).check();
    await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible();
    await expect(page.getByLabel('Courriel ou numéro de cellulaire')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr-CA');
    await page.screenshot({ path: 'screenshots/features/login-fr-phone.png', fullPage: true });

    await page.getByRole('radio', { name: 'עברית' }).check();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('button', { name: 'כניסה', exact: true })).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    await page.screenshot({ path: 'screenshots/features/login-he-phone.png', fullPage: true });

    await page.getByRole('radio', { name: 'English' }).check();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('a volunteer switches to Hebrew in Settings: menu in Hebrew, right to left, no sideways scroll', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const ctx = await browser.newContext({ storageState: STATE_FILES.volunteer, ...testInfo.project.use, viewport: { width: 360, height: 760 } });
    const page = await ctx.newPage();
    await page.goto('/settings');
    test.skip(!(await languages(page)).includes('he'), 'French and Hebrew are off');
    try {
      await page.getByRole('radio', { name: 'עברית' }).check();
      await expect(page.getByText('השפה נשמרה.')).toBeVisible();
      await page.goto('/more');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { name: 'עוד' })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await page.screenshot({ path: 'screenshots/features/more-he-phone.png', fullPage: true });
      // The choice is kept on the account, not just this browser.
      const saved = await page.evaluate(async () => ((await (await fetch('/api/me/locale', { credentials: 'include' })).json()) as { locale: string }).locale);
      expect(saved).toBe('he');
    } finally {
      await page.evaluate(async () => {
        await fetch('/api/me/locale', { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: 'en' }) });
        localStorage.setItem('rvc.locale', 'en');
      });
      await ctx.close();
    }
  });
});

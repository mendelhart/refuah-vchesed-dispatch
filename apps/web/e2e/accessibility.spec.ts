import { expect, test } from '@playwright/test';
import { STATE_FILES } from './helpers';

/**
 * The accessibility properties this product cannot do without.
 *
 * Not a full audit — a hand-written check of the four things that actually stop
 * somebody using this: targets too small to hit on a phone, a page with no
 * heading, an image with no alternative text, and a form field with no label.
 */
const TOUCH_TARGET_MIN = 40;

test.describe('accessibility', () => {
  test.use({ storageState: STATE_FILES.volunteer });

  test('every page has exactly one first-level heading', async ({ browser }) => {
    const context = await browser.newContext({ storageState: STATE_FILES.dispatcher });
    const page = await context.newPage();
    for (const path of ['/board', '/messages', '/callers', '/recurring', '/volunteers']) {
      await page.goto(path);
      await expect(page.locator('h1')).toHaveCount(1);
    }
    await context.close();
  });

  test('interactive targets are large enough to hit on a phone', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'Only meaningful at phone size');
    await page.goto('/my-availability');
    await page.waitForLoadState('networkidle');

    const tooSmall = await page.evaluate((min) => {
      const offenders: string[] = [];
      for (const el of document.querySelectorAll('button, a[href], input[type="checkbox"], select')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // hidden
        if (rect.height < min) {
          offenders.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(rect.height)}px`);
        }
      }
      return offenders;
    }, TOUCH_TARGET_MIN);

    expect(tooSmall, `targets under ${TOUCH_TARGET_MIN}px: ${tooSmall.join(', ')}`).toHaveLength(0);
  });

  test('no image is missing alternative text', async ({ page }) => {
    await page.goto('/my-id-card');
    const missing = await page.locator('img:not([alt])').count();
    expect(missing).toBe(0);
  });

  test('every visible form field has a label', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    const unlabelled = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const field of document.querySelectorAll('input, select, textarea')) {
        const el = field as HTMLInputElement;
        if (el.type === 'hidden' || el.offsetParent === null) continue;
        const labelled =
          el.labels?.length ||
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          el.getAttribute('title');
        if (!labelled) offenders.push(`${el.tagName.toLowerCase()}[name=${el.name || '?'}]`);
      }
      return offenders;
    });

    expect(unlabelled, `unlabelled fields: ${unlabelled.join(', ')}`).toHaveLength(0);
  });

  test('the page is usable in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/my-trips');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).not.toBe('rgba(0, 0, 0, 0)');
  });
});

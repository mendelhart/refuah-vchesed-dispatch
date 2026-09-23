import { expect, test } from '@playwright/test';
import { STATE_FILES, failOnConsoleErrors } from './helpers';

/**
 * Every screen opens, for the role that is meant to reach it, without an error
 * in the console.
 *
 * This is the cheapest test in the suite and it catches the most embarrassing
 * class of bug: a route added to the router but never opened, a page importing
 * something that does not exist, a query key typo that throws on mount. In the
 * legacy application several screens were in the navigation and crashed on
 * click; nobody noticed because nobody clicked them.
 */

const DISPATCHER_SCREENS = [
  ['/board', /dispatch|board/i],
  ['/messages', /messages|conversation/i],
  ['/callers', /caller/i],
  ['/recurring', /standing/i],
  ['/volunteers', /volunteer/i],
  ['/duty', /duty|phone/i],
  ['/admin/applications', /application/i],
  ['/admin/announcements', /broadcast|announcement/i],
  ['/equipment', /equipment/i],
  ['/calls', /call/i],
  ['/contacts', /contact/i],
  ['/admin/audit', /audit/i],
  ['/admin/notifications', /notification|delivery/i],
  ['/impact', /impact/i],
] as const;

const VOLUNTEER_SCREENS = [
  ['/', /refuah|home|today/i],
  ['/my-trips', /rides|trips/i],
  ['/my-availability', /availability/i],
  ['/my-profile', /help with|services|licence/i],
  ['/my-id-card', /card/i],
  ['/directory', /directory/i],
  ['/settings', /settings/i],
] as const;

test.describe('every screen opens', () => {
  test('dispatcher screens', async ({ browser }) => {
    const context = await browser.newContext({ storageState: STATE_FILES.dispatcher });
    const page = await context.newPage();
    const errors = failOnConsoleErrors(page, [/favicon/i, /service-worker/i]);
    // Reported on failure: the first time this test went red, the cause was a
    // 429 on /api/auth/me that the app was reading as a sign-out, and the
    // screenshot showed only a login page with no hint why.
    const statuses: string[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() >= 400) {
        statuses.push(`${r.status()} ${new URL(r.url()).pathname}`);
      }
    });

    for (const [path, expected] of DISPATCHER_SCREENS) {
      await page.goto(path);
      // A generous timeout on purpose: these routes are lazily loaded, so on a
      // cold run the first assertion after navigating waits for a chunk to
      // download. Without it this is flaky on the first CI run of a new build
      // and green on every rerun, which is the worst kind of test.
      await expect(
        page.locator('main, [role="main"]').first(),
        `no main element at ${path}; non-2xx: ${statuses.join(', ')}`,
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('body')).toContainText(expected, { timeout: 15_000 });
      // A crashed page renders the error boundary; assert we are not looking at it.
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }

    expect(errors, `console errors: ${errors.join(' | ')} | non-200: ${statuses.join(', ')}`).toHaveLength(0);
    await context.close();
  });

  test('volunteer screens', async ({ browser }) => {
    const context = await browser.newContext({ storageState: STATE_FILES.volunteer });
    const page = await context.newPage();
    const errors = failOnConsoleErrors(page, [/favicon/i, /service-worker/i]);

    for (const [path, expected] of VOLUNTEER_SCREENS) {
      await page.goto(path);
      await expect(page.locator('body')).toContainText(expected, { timeout: 15_000 });
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }

    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
    await context.close();
  });

  test('admin-only screens', async ({ browser }) => {
    const context = await browser.newContext({ storageState: STATE_FILES.admin });
    const page = await context.newPage();
    const errors = failOnConsoleErrors(page, [/favicon/i, /service-worker/i]);

    for (const path of ['/admin/people', '/admin/templates', '/admin/settings']) {
      await page.goto(path);
      await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
    }
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
    await context.close();
  });

  test('a volunteer is refused a dispatcher screen', async ({ browser }) => {
    const context = await browser.newContext({ storageState: STATE_FILES.volunteer });
    const page = await context.newPage();
    await page.goto('/board');
    // The route guard is a courtesy, not a control — the API refuses regardless.
    await expect(page.locator('body')).not.toContainText(/dispatch board/i, { timeout: 5_000 });
    await context.close();
  });

  test('the public signup form opens without a session', async ({ page }) => {
    const errors = failOnConsoleErrors(page, [/favicon/i, /service-worker/i]);
    await page.goto('/volunteer/apply');
    await expect(page.locator('body')).toContainText(/volunteer/i);
    // No app shell: there is nothing to navigate to from here.
    await expect(page.getByRole('navigation', { name: /primary/i })).toHaveCount(0);
    expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
  });

  test('the public card check answers without a session', async ({ page }) => {
    await page.goto('/verify/0123456789abcdef0123');
    await expect(page.locator('body')).toContainText(/not current/i);
  });
});

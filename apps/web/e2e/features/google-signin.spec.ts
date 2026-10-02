import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from '../helpers';

/**
 * Item 9: Google sign-in in the browser. Google is never contacted: the
 * hand-over to Google is caught and checked, and a made-up answer coming
 * back is refused. The real round trip is checked in the API tests with
 * tokens signed by a test key.
 */
const noViolations = async (page: Page) => {
  const axe = await new AxeBuilder({ page }).exclude('[data-sonner-toaster]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
};
const googleOn = async (page: Page) => page.evaluate(async () => ((await (await fetch('/api/public/google-signin')).json()) as { enabled: boolean }).enabled);

test.describe('google sign-in', () => {
  test('the button hands over to Google asking only for an ID token; a forged return is refused', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const ctx = await browser.newContext({ ...testInfo.project.use });
    const page = await ctx.newPage();
    await page.goto('/login');
    if (!(await googleOn(page))) {
      await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);
      test.skip(true, 'Google sign-in is off (and the button is hidden)');
    }
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await noViolations(page);
    await page.screenshot({ path: 'screenshots/features/google-signin-login-phone.png', fullPage: true });

    let handedOver: URL | null = null;
    await page.route('https://accounts.google.com/**', async (route) => { handedOver = new URL(route.request().url()); await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Google (stand-in)</title>' }); });
    await page.getByRole('button', { name: 'Sign in with Google' }).click();
    await expect.poll(() => handedOver?.toString() ?? '').toContain('accounts.google.com/o/oauth2/v2/auth');
    const params = Object.fromEntries(handedOver!.searchParams);
    expect(params).toMatchObject({ response_type: 'id_token', scope: 'openid email', client_id: 'e2e-test.apps.googleusercontent.com' });
    expect(params.redirect_uri).toMatch(/\/auth\/google$/);
    expect(params.nonce?.length).toBeGreaterThan(20);

    await page.waitForURL(/accounts\.google\.com/);
    await page.goto('/auth/google#state=wrong&id_token=a.b.c');
    await expect(page.getByRole('alert')).toContainText('Google sign-in did not work');
    await expect(page).toHaveURL(/\/auth\/google$/); // the token is gone from the address bar
    await page.getByRole('link', { name: 'Back to sign-in' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await ctx.close();
  });

  test('an administrator approves a coordinator by name, then removes them', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const ctx = await browser.newContext({ storageState: STATE_FILES.admin, ...testInfo.project.use });
    const page = await ctx.newPage();
    await page.goto('/admin/google-sign-in');
    test.skip(!(await googleOn(page)), 'Google sign-in is off');
    await expect(page.getByRole('heading', { name: 'Google sign-in', level: 1 })).toBeVisible();
    const select = page.getByLabel('Approve a person');
    const option = select.locator('option', { hasText: 'Coordinator' }).first();
    const label = (await option.textContent())!;
    const name = label.split(' · ')[0]!;
    await select.selectOption({ label });
    await page.getByRole('button', { name: 'Approve for Google sign-in' }).click();
    const approved = page.getByRole('list', { name: 'Approved people' }).getByRole('listitem').filter({ hasText: name });
    await expect(approved).toBeVisible({ timeout: 20_000 });
    await expect(approved).toContainText('not used yet');
    await noViolations(page);
    await page.screenshot({ path: 'screenshots/features/google-signin-admin-phone.png', fullPage: true });
    await page.getByRole('button', { name: `Remove Google sign-in for ${name}` }).click();
    await page.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(approved).toHaveCount(0, { timeout: 20_000 });
    await ctx.close();
  });
});

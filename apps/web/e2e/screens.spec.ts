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

  // Give the seeded volunteer an upcoming ride so their Home shows the
  // "Your next ride" card in the picture.
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ storageState: STATE_FILES.dispatcher });
    const page = await context.newPage();
    await page.goto('/');
    await page.evaluate(async () => {
      const get = async (url: string) => (await fetch(url, { headers: { Accept: 'application/json' } })).json();
      const people = await get('/api/users?search=Yaakov&limit=5');
      const volunteer = people.users?.[0];
      const board = await get('/api/trips?scope=board&limit=50');
      const trip = (board.items ?? []).find((t: { status: string }) => t.status === 'pending');
      if (!volunteer || !trip) return;
      await fetch(`/api/trips/${trip.id}/assign`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ volunteerId: volunteer.id }),
      });
    });
    await context.close();
  });

  test('volunteer-notifications-open', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: STATE_FILES.volunteer, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await page.getByText('Notifications', { exact: true }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'screenshots/volunteer-notifications-open.png' });
    await context.close();
  });

  test('dispatcher-volunteer-card-actions', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: STATE_FILES.dispatcher, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto('/');
    const id = await page.evaluate(async () => {
      const r = await fetch('/api/users?search=Yaakov&limit=5', { headers: { Accept: 'application/json' } });
      return ((await r.json()).users?.[0]?.id as string | undefined) ?? '';
    });
    await page.goto(`/volunteers?open=${id}`);
    await page.getByRole('button', { name: 'Edit details' }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: 'screenshots/dispatcher-volunteer-card.png' });
    await page.getByRole('button', { name: 'Edit details' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'screenshots/dispatcher-volunteer-edit.png' });
    await page.getByRole('button', { name: 'WhatsApp' }).click();
    await page.getByRole('textbox').last().fill('Can you drive Thursday at 10?');
    await page.screenshot({ path: 'screenshots/dispatcher-volunteer-whatsapp.png' });
    await context.close();
  });

  test('dispatcher-add-volunteer-link', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: STATE_FILES.dispatcher, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto('/volunteers');
    await page.getByRole('button', { name: 'Add volunteer' }).click();
    await page.locator('#person-name').fill('Screenshot Driver');
    await page.locator('#person-phone').fill('514 555 7321');
    await page.locator('#person-email').fill('shot.driver@example.test');
    await page.getByRole('checkbox', { name: /^Email/ }).check();
    await page.screenshot({ path: 'screenshots/dispatcher-add-volunteer-form.png' });
    await page.getByRole('button', { name: 'Add and invite' }).click();
    await page.getByText('Set-up link (valid 7 days)').waitFor({ timeout: 15_000 });
    await page.screenshot({ path: 'screenshots/dispatcher-add-volunteer-link.png' });
    await context.close();
  });

  test('admin-view-as-volunteer', async ({ browser }) => {
    const context = await browser.newContext({
      storageState: STATE_FILES.admin, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto('/admin/people');
    await page.getByRole('button', { name: 'View as' }).last().click();
    await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
    await page.getByText(/viewing as/i).waitFor({ timeout: 15_000 });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.screenshot({ path: 'screenshots/admin-view-as-volunteer.png', fullPage: true });
    await context.close();
  });

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

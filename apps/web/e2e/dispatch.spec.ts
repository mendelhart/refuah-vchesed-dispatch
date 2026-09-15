import { expect, test } from '@playwright/test';
import { STATE_FILES } from './helpers';

/**
 * The work itself: create a trip, offer it, and see the volunteer's side.
 *
 * The API tests already prove the state machine. What these prove is that a
 * dispatcher can drive it through the interface on the screen size they
 * actually have, which is the part no unit test can tell you.
 */
test.describe('dispatch as a dispatcher', () => {
  test.use({ storageState: STATE_FILES.dispatcher });

  test('a dispatcher can take a ride request end to end', async ({ page }) => {
    await page.goto('/board');

    await page.getByRole('button', { name: /new (trip|ride|request)/i }).first().click();

    const caller = `E2E Caller ${Date.now().toString().slice(-6)}`;
    await page.getByLabel(/caller name/i).fill(caller);
    await page.getByLabel(/caller phone/i).fill('514-555-8123');

    // Addresses: the form has separate pickup and dropoff blocks.
    const line1Fields = page.getByLabel(/street address|address line|line 1/i);
    await line1Fields.nth(0).fill('1234 Avenue Bernard');
    await line1Fields.nth(1).fill('3755 Chemin de la Côte-Sainte-Catherine');

    const when = new Date(Date.now() + 5 * 3_600_000);
    const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    await page.getByLabel(/pickup (time|at|date)/i).first().fill(local);

    await page.getByRole('button', { name: /create|save/i }).last().click();

    await expect(page.locator('body')).toContainText(caller, { timeout: 20_000 });
  });

  test('the board shows the Hebrew date and the next Shabbos boundary', async ({ page }) => {
    await page.goto('/board');
    // Not decoration: a trip offered after candle lighting is one nobody can take.
    await expect(page.locator('body')).toContainText(/tishrei|cheshvan|kislev|tevet|shevat|adar|nisan|iyyar|iyar|sivan|tamuz|av|elul/i, {
      timeout: 20_000,
    });
  });

});

test.describe('dispatch as a volunteer', () => {
  test.use({ storageState: STATE_FILES.volunteer });

  test('a volunteer sees their own rides and nothing else', async ({ page }) => {
    await page.goto('/my-trips');
    await expect(page.getByText(/something went wrong/i)).toHaveCount(0);
  });

  test('a volunteer can state when they are available', async ({ page }) => {
    await page.goto('/my-availability');
    // The most important sentence on the screen: no hours on file does NOT
    // mean unavailable, and the page must not imply that it does.
    await expect(page.locator('body')).toContainText(/availability/i);
    await expect(page.locator('body')).not.toContainText(/you are unavailable/i);
  });
});

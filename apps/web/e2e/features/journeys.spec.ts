import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from '../helpers';
import { featureOn, localIn } from './flags';

/**
 * Item 3 in the browser, at phone width: a coordinator books a round trip
 * whose ride home waits for the passenger's call, sees it waiting on the
 * board, and creates the ride home with one tap. Runs only when
 * MULTI_LEG_TRIPS_ENABLED is on (the features pass of scripts/e2e.sh).
 */
test.describe('journeys', () => {
  test.use({ storageState: STATE_FILES.dispatcher });

  test('round trip with "ride home when they call", end to end', async ({ page }, testInfo) => {
    await page.goto('/board');
    test.skip(!(await featureOn(page, 'multiLegTrips')), 'journeys feature is off');

    await page.getByRole('button', { name: /new (trip|ride|request)/i }).first().click();
    const caller = `Journey ${Date.now().toString().slice(-6)}`;
    await page.getByLabel(/caller name/i).fill(caller);
    await page.getByLabel(/caller phone/i).fill('514-555-8124');
    const line1 = page.getByLabel(/street address|address line|line 1/i);
    await line1.nth(0).fill('1234 Avenue Bernard');
    await line1.nth(1).fill('3755 Chemin de la Côte-Sainte-Catherine');
    const [day, clock] = localIn(5).split('T');
    await page.getByLabel(/pickup time date/i).fill(day!);
    await page.getByLabel(/pickup time time/i).fill(clock!);

    await page.getByLabel('Ride home when they call').check();
    await page.getByRole('button', { name: 'Add a person' }).click();
    await page.getByLabel('Person 1: name').fill(caller);
    await page.getByRole('button', { name: 'Add a person' }).click();
    await page.getByLabel('Person 2: name').fill('Her daughter');
    await expect(page.getByText(/needing 2 seats/)).toBeVisible();

    if (testInfo.project.name === 'phone') {
      await page.getByRole('dialog').screenshot({ path: 'screenshots/features/journey-form-phone.png' });
      const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(axe.violations.map((v) => v.id)).toEqual([]);
    }

    await page.getByRole('button', { name: /create trip/i }).click();
    await expect(page.getByText(/waiting for a call for the ride home/i)).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `screenshots/features/journey-board-${testInfo.project.name}.png`, fullPage: true });
    const row = page.getByRole('listitem').filter({ hasText: caller }).filter({ has: page.getByRole('button', { name: 'They called' }) });
    await row.getByRole('button', { name: 'They called' }).click();
    await expect(page.getByText('Ride home created.')).toBeVisible();
    await expect(row).toHaveCount(0);
  });
});

import { expect, test } from '@playwright/test';

test('resume ownership fragment is removed from address bar and submitted only with form', async ({ page }) => {
  const token = 's'.repeat(43);
  await page.route('**/api/public/signup-options', (route) => route.fulfill({ json: {
    services: [{ slug: 'ride', name: 'Driving', description: null }], groups: [],
    consent: { version: 'test', text: 'Synthetic consent' },
  } }));
  await page.goto(`/volunteer/apply#ref=RVC-A-TEST-001&token=${token}`);
  await expect(page.getByRole('heading', { name: 'Volunteer with us' })).toBeVisible();
  await expect(page).toHaveURL(/\/volunteer\/apply$/);
  expect(await page.evaluate(() => location.hash)).toBe('');
  await expect(page.getByText('Step 1 of 4')).toBeVisible();
});

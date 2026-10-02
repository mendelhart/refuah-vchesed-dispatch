import { expect, test } from '@playwright/test';
import { STATE_FILES } from './helpers';

const id = '11111111-1111-4111-8111-111111111111';
const application = {
  id, reference: 'RVC-A-TEST-001', status: 'submitted', fullName: 'Link Test Applicant',
  email: 'link-test@example.invalid', phone: '+15145550123', city: 'Montreal',
  requestedServices: [], requestedGroups: [], capabilities: [], languages: ['en'],
  hasVehicle: false, consentBackgroundCheck: true, createdAt: '2026-10-02T12:00:00Z',
};

test.describe('application links', () => {
  test.use({ storageState: STATE_FILES.admin });
  test.beforeEach(async ({ page }) => {
    // Synthetic read fixtures only. No application is submitted or approved.
    await page.route('**/api/applications?*', (route) => route.fulfill({ json: {
      applications: [application], counts: { submitted: 1 },
    } }));
    await page.route(`**/api/applications/${id}`, (route) => route.fulfill({ json: {
      application, licence: null, possibleMatches: [],
    } }));
  });

  test('form link and submitted application deep link work', async ({ page }, testInfo) => {
    await page.goto('/admin/applications');
    const form = page.getByRole('link', { name: /Open volunteer application form/ });
    await expect(form).toHaveAttribute('href', '/volunteer/apply');
    await expect(form).toHaveAttribute('target', '_blank');
    await expect(form).toHaveAttribute('rel', 'noopener noreferrer');
    const row = page.getByRole('link', { name: /Link Test Applicant/ });
    await expect(row).toHaveAttribute('href', `/admin/applications/${id}`);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/admin/applications/${id}$`));
    await expect(page.getByRole('heading', { name: 'Link Test Applicant' })).toBeVisible();
    const submitted = page.getByRole('link', { name: /Open submitted application/ });
    await expect(submitted).toHaveAttribute('href', `/admin/applications/${id}`);
    await expect(submitted).toHaveAttribute('target', '_blank');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Link Test Applicant' })).toBeVisible();
    await page.screenshot({ path: 'screenshots/application-link-phone.png', fullPage: true });
    if (testInfo.project.name === 'phone') {
      await page.getByRole('button', { name: 'Back to the list' }).click();
    } else {
      await page.getByRole('tab', { name: /New/ }).click();
    }
    await expect(page).toHaveURL(/\/admin\/applications$/);
    await expect(row).toBeVisible();
    const bounds = await row.boundingBox();
    expect(bounds?.width).toBeGreaterThan(300);
    expect(bounds?.height).toBeGreaterThan(80);
    await page.screenshot({ path: 'screenshots/application-list-links-phone.png', fullPage: true });
  });

  test('direct URL opens an application outside the currently selected list', async ({ page }) => {
    await page.route('**/api/applications?*', (route) => route.fulfill({ json: {
      applications: [], counts: { submitted: 0 },
    } }));
    await page.goto(`/admin/applications/${id}`);
    await expect(page.getByRole('heading', { name: 'Link Test Applicant' })).toBeVisible();
    await expect(page.getByText('RVC-A-TEST-001', { exact: true })).toBeVisible();
  });
});

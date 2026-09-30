import { expect, test } from '@playwright/test';
import { STATE_FILES } from './helpers';

test.describe('approved admin fixes', () => {
  test.use({ storageState: STATE_FILES.admin });
  test('admin sees backup controls and private health status at phone width', async ({ page }) => {
    await page.goto('/board');
    await expect(page.getByLabel('System status')).toBeAttached();
    await expect(page.getByLabel(/Encryption passphrase/)).toHaveCount(0);
    await page.goto('/admin/backup');
    await page.getByText(/Backup needed: no full download/).click();
    await expect(page.getByLabel(/Encryption passphrase/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download encrypted full backup' })).toBeDisabled();
    await page.screenshot({ path: 'screenshots/approved-admin-backup-menu.png', fullPage: true });
  });
  test('admin can create a password reset link without sending it', async ({ page }) => {
    await page.goto('/admin/people');
    await page.getByRole('button', { name: 'Reset password', exact: true }).first().click();
    await expect(page.getByText('Send this password-reset link to them - it expires in one hour.')).toBeVisible();
    await expect(page.getByText('Text', { exact: true })).toBeVisible();
  });
});

test.describe('role restrictions', () => {
  test.use({ storageState: STATE_FILES.volunteer });
  test('volunteer cannot use admin backup or roster mutation endpoints', async ({ page }) => {
    await page.goto('/');
    const statuses = await page.evaluate(async () => {
      const me = await (await fetch('/api/auth/me')).json();
      const id = me.user.id;
      const routes = [
        ['/api/admin/backup/status', 'GET'],
        [`/api/users/${id}/password-reset`, 'POST'],
        [`/api/users/${id}/suspend`, 'POST'],
        [`/api/users/${id}/deactivate`, 'POST'],
        [`/api/users/${id}/message`, 'POST'],
        [`/api/users/${id}`, 'PATCH'],
      ];
      return Promise.all(routes.map(async ([url, method]) => (await fetch(url!, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) })).status));
    });
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403]);
    await page.screenshot({ path: 'screenshots/approved-volunteer-home.png', fullPage: true });
  });
});


test.describe('photo approval on a phone', () => {
  test.use({ storageState: STATE_FILES.admin });
  test('volunteer requests a photo and admin approves it from the roster', async ({ page, browser }) => {
    const volunteer = await browser.newContext({ storageState: STATE_FILES.volunteer });
    const volunteerPage = await volunteer.newPage();
    await volunteerPage.goto('/');
    const requested = await volunteerPage.evaluate(async () => {
      const response = await fetch('/api/me/photo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=' }) });
      return response.status;
    });
    expect(requested).toBe(200);
    await page.goto('/volunteers');
    const requests = page.getByRole('region', { name: /Photo changes to approve/ });
    await expect(requests).toBeVisible();
    await page.screenshot({ path: 'screenshots/approved-photo-review.png', fullPage: true });
    await requests.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(requests).toHaveCount(0);
    const status = await volunteerPage.evaluate(async () => (await fetch('/api/me/photo')).json());
    expect(status.pending).toBeNull();
    expect(status.photo).toContain('data:image/png');
    await volunteer.close();
  });
});

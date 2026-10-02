import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from '../helpers';
import { featureOn } from './flags';

/**
 * Item 4 in the browser: an admin puts the coordinator in the Food
 * department; the coordinator's menu then hides Equipment and the server
 * refuses the equipment API. The membership is removed again at the end so
 * the other feature tests see an unrestricted coordinator.
 */
test.describe('departments', () => {
  test('admin limits a coordinator to food; their menu and the server follow', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const adminCtx = await browser.newContext({ storageState: STATE_FILES.admin, ...testInfo.project.use });
    const admin = await adminCtx.newPage();
    await admin.goto('/admin');
    test.skip(!(await featureOn(admin, 'departmentScoping')), 'departments feature is off');

    await admin.goto('/admin/departments');
    const food = admin.getByRole('region', { name: 'Food' });
    const coordCtx = await browser.newContext({ storageState: STATE_FILES.dispatcher, ...testInfo.project.use });
    const coord = await coordCtx.newPage();
    try {
      await food.getByLabel('Dina Dispatcher').check();
      await food.getByRole('button', { name: 'Save Food' }).click();
      await expect(admin.getByText('Food saved.')).toBeVisible();
      await admin.screenshot({ path: 'screenshots/features/departments-admin-phone.png', fullPage: true });
      // Includes the "saved" message, so toasts are checked too.
      const axe = await new AxeBuilder({ page: admin }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.failureSummary ?? ''}`)).toEqual([]);

      await coord.goto('/more');
      await expect(coord.getByRole('heading', { name: 'More' })).toBeVisible();
      await expect(coord.getByRole('link', { name: /Equipment/ })).toHaveCount(0);
      await expect(coord.getByRole('link', { name: /Phone duty/ })).toHaveCount(1);
      const status = await coord.evaluate(async () => (await fetch('/api/equipment/loans', { credentials: 'include' })).status);
      expect(status).toBe(403);
    } finally {
      // Always undo, so the other feature tests see an unrestricted coordinator.
      const res = await admin.evaluate(async () => (await fetch('/api/departments/food/members', {
        method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userIds: [] }),
      })).status);
      expect(res).toBe(200);
      await adminCtx.close();
      await coordCtx.close();
    }
  });
});

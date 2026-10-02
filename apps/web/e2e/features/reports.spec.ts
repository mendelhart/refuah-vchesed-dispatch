import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from '../helpers';
import { featureOn } from './flags';

/** Item 8 in the browser at phone width: a coordinator reads the reports. */
test.describe('reports', () => {
  test('tiles, one chart per department with a table view, CSV links; no sideways scroll', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const ctx = await browser.newContext({ storageState: STATE_FILES.dispatcher, ...testInfo.project.use });
    const page = await ctx.newPage();
    await page.goto('/board');
    test.skip(!(await featureOn(page, 'reports')), 'reports are off');

    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Totals' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Rides completed')).toBeVisible();
    await expect(page.locator('figure').filter({ hasText: 'Rides' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Staffing' })).toBeVisible();

    await page.getByLabel('Group by').selectOption('month');
    await page.getByRole('button', { name: 'Show as a table' }).first().click();
    await expect(page.getByRole('columnheader', { name: 'Completed' })).toBeVisible();

    const csv = page.getByRole('link', { name: /Summary \(CSV\)/ });
    await expect(csv).toHaveAttribute('href', /\/api\/reports\/export\.csv\?report=summary/);
    const res = await page.evaluate(async (href) => { const r = await fetch(href!, { credentials: 'include' }); return { status: r.status, type: r.headers.get('content-type') }; }, await csv.getAttribute('href'));
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/text\/csv/);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const axe = await new AxeBuilder({ page }).exclude('[data-sonner-toaster]').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    await page.screenshot({ path: 'screenshots/features/reports-phone.png', fullPage: true });
    await ctx.close();
  });

  test('volunteers do not get the reports page', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const ctx = await browser.newContext({ storageState: STATE_FILES.volunteer, ...testInfo.project.use });
    const page = await ctx.newPage();
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Totals' })).toHaveCount(0);
    const status = await page.evaluate(async () => (await fetch('/api/reports/summary', { credentials: 'include' })).status);
    expect([403, 404]).toContain(status);
    await ctx.close();
  });
});

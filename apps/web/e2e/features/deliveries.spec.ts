import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from '../helpers';
import { featureOn, localIn } from './flags';

/** Item 6 in the browser at phone width: a package delivery and a lift assist. */
const noViolations = async (page: Page) => {
  // Toasts fade in and out; their settled colours are checked in departments.spec.ts.
  const axe = await new AxeBuilder({ page }).exclude('[data-sonner-toaster]').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.failureSummary ?? ''}`)).toEqual([]);
};

test.describe('deliveries', () => {
  test('a coordinator books a package delivery and sees the package on the trip', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const ctx = await browser.newContext({ storageState: STATE_FILES.dispatcher, ...testInfo.project.use });
    const page = await ctx.newPage();
    await page.goto('/board');
    test.skip(!(await featureOn(page, 'packageDelivery')), 'package delivery is off');

    await page.getByRole('button', { name: /new (trip|ride|request)/i }).first().click();
    const caller = `Pkg ${Date.now().toString().slice(-6)}`;
    await page.getByLabel(/caller name/i).fill(caller);
    await page.getByLabel(/caller phone/i).fill('514-555-8125');
    const line1 = page.getByLabel(/street address|address line|line 1/i);
    await line1.nth(0).fill('1234 Avenue Bernard');
    await line1.nth(1).fill('5600 Avenue Durocher');
    const [day, clock] = localIn(5).split('T');
    await page.getByLabel(/pickup time date/i).fill(day!);
    await page.getByLabel(/pickup time time/i).fill(clock!);
    await page.getByLabel('Trip type').selectOption('equipment_delivery');
    await page.getByRole('checkbox', { name: 'This is a package to deliver' }).check();
    await page.getByLabel('What is it').fill('Box of medication');
    await page.getByLabel('Who receives it').fill('Leah Klein');
    await page.getByRole('dialog').screenshot({ path: 'screenshots/features/package-form-phone.png' });
    await page.getByRole('button', { name: /create trip/i }).click();
    await expect(page.locator('body')).toContainText(caller, { timeout: 20_000 });
    await page.getByText(caller).first().click();
    await expect(page.getByRole('heading', { name: 'Package' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Box of medication')).toBeVisible();
    await noViolations(page);
    await ctx.close();
  });

  test('lift assist: a volunteer offers, is asked by name, and says yes', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const volCtx = await browser.newContext({ storageState: STATE_FILES.volunteer, ...testInfo.project.use });
    const vol = await volCtx.newPage();
    await vol.goto('/lift-assist');
    test.skip(!(await featureOn(vol, 'liftAssist')), 'lift assist is off');
    const toggle = vol.getByLabel(/I can help lift and carry/);
    if (!(await toggle.isChecked())) await toggle.check();
    await expect(toggle).toBeChecked();
    await noViolations(vol);

    const coordCtx = await browser.newContext({ storageState: STATE_FILES.dispatcher, ...testInfo.project.use });
    const coord = await coordCtx.newPage();
    await coord.goto('/lift-assist');
    const title = `Move a bed ${Date.now().toString().slice(-5)}`;
    await coord.getByLabel('What needs lifting').fill(title);
    await coord.getByLabel('Where').fill('1234 Avenue Bernard');
    await coord.getByLabel('When').fill(localIn(30));
    await coord.getByLabel('People needed').fill('2');
    await coord.getByRole('button', { name: 'Create request' }).click();
    const card = coord.getByRole('listitem').filter({ hasText: title });
    await card.getByRole('button', { name: 'Find helpers' }).click();
    const dialog = coord.getByRole('dialog');
    await expect(dialog.getByLabel(/Yaakov Driver/)).toBeChecked();
    await expect(dialog).toContainText('fewer people than needed');
    await noViolations(coord);
    await coord.screenshot({ path: 'screenshots/features/lift-assist-helpers-phone.png', fullPage: true });
    await dialog.getByRole('button', { name: /Ask these 1 person/ }).click();
    await expect(coord.getByText('Asked 1 person.')).toBeVisible();

    await vol.reload();
    const invite = vol.getByRole('listitem').filter({ hasText: title });
    await invite.getByRole('button', { name: 'Yes, I can help' }).click();
    await expect(invite).toContainText('You said yes');
    await coord.reload();
    await expect(coord.getByRole('listitem').filter({ hasText: title })).toContainText('1 of 2 said yes · Yaakov Driver leads');
    await volCtx.close();
    await coordCtx.close();
  });
});

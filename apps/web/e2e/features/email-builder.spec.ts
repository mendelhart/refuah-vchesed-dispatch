import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from '../helpers';
import { featureOn } from './flags';

/** Item 9 in the browser at phone width: build an email, preview, save, version, test. */
test.describe('email builder', () => {
  test('a coordinator builds an email, previews it, saves two versions and sends themself a test', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const ctx = await browser.newContext({ storageState: STATE_FILES.dispatcher, ...testInfo.project.use });
    const page = await ctx.newPage();
    await page.goto('/board');
    test.skip(!(await featureOn(page, 'emailBuilder')), 'email builder is off');

    await page.goto('/email-builder/new');
    const name = `Thank you ${Date.now().toString().slice(-5)}`;
    await page.getByLabel('Design name (only staff see this)').fill(name);
    await page.getByLabel('Subject').fill('Thank you, ');
    await page.getByRole('button', { name: 'First name' }).click();
    await expect(page.getByLabel('Subject')).toHaveValue('Thank you, {{firstName}}');
    await page.getByLabel('Heading text').fill('A big thank you');
    await page.getByLabel('Paragraph text').fill('Your rides this month made a difference.');
    await page.getByRole('button', { name: /^Button$/ }).click();
    await page.getByLabel('Button words').fill('Open the app');
    await page.getByLabel(/^Link/).fill('javascript:alert(1)');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: /https/ })).toBeVisible();
    await page.getByLabel(/^Link/).fill('https://example.org/app');
    await page.getByRole('button', { name: 'Move Button 3 up' }).click();
    await expect(page.getByRole('listitem', { name: 'Button 2' })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: /^Version 1$/ })).toBeVisible({ timeout: 20_000 });

    await page.getByRole('tab', { name: 'Preview' }).click();
    const frame = page.frameLocator('iframe[title="Email preview"]');
    await expect(frame.getByRole('heading', { name: 'A big thank you' })).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', 'https://example.org/app');
    await expect(page.getByText(/^Subject:/).locator('..')).toContainText('Thank you, ');
    await page.screenshot({ path: 'screenshots/features/email-builder-preview-phone.png', fullPage: true });

    await page.getByRole('tab', { name: 'Edit' }).click();
    await page.getByLabel('Heading text').fill('Thank you, all of you');
    await page.getByRole('button', { name: 'Save a new version' }).click();
    await expect(page.getByRole('paragraph').filter({ hasText: /^Version 2$/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Bring back version 1' }).click();
    await page.getByRole('button', { name: 'Yes, bring it back' }).click();
    await expect(page.getByLabel('Heading text')).toHaveValue('A big thank you', { timeout: 20_000 });

    await page.getByRole('button', { name: 'Send me a test' }).click();
    await expect(page.getByText(/Test recorded for .*Test mode/)).toBeVisible({ timeout: 20_000 });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const axe = await new AxeBuilder({ page }).exclude('[data-sonner-toaster]').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
    await page.screenshot({ path: 'screenshots/features/email-builder-edit-phone.png', fullPage: true });
    await ctx.close();
  });
});

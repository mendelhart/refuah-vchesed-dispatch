import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from '../helpers';
import { featureOn } from './flags';

/**
 * Item 5 in the browser at phone width: a coordinator sets up a kitchen slot,
 * a volunteer signs up for it, and the coordinator sends a shopping list to
 * two people after checking their names. Runs when FOOD_OPS_ENABLED is on.
 */
async function post(page: Page, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(async ([p, b]) => {
    const res = await fetch(p as string, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }, [path, body] as const);
}

const noViolations = async (page: Page) => {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.failureSummary ?? ''}`)).toEqual([]);
};

test.describe('food operations', () => {
  test('kitchen slot sign-up and a shopping list sent once', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'phone width only');
    const coordCtx = await browser.newContext({ storageState: STATE_FILES.dispatcher, ...testInfo.project.use });
    const coord = await coordCtx.newPage();
    await coord.goto('/food');
    test.skip(!(await featureOn(coord, 'foodOps')), 'food feature is off');

    // A slot running tomorrow, needing two people.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      .indexOf(new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Toronto' }).format(tomorrow));
    const title = `Cooking ${Date.now().toString().slice(-5)}`;
    const slot = await post(coord, '/api/food/prep-slots', { title, weekday, startMinute: 600, endMinute: 720, staffNeeded: 2 });
    expect(slot.status).toBe(201);

    const volCtx = await browser.newContext({ storageState: STATE_FILES.volunteer, ...testInfo.project.use });
    const vol = await volCtx.newPage();
    await vol.goto('/kitchen');
    // The slot repeats weekly; the first card is tomorrow's.
    const card = vol.getByRole('listitem').filter({ hasText: title }).first();
    await expect(card).toContainText('2 more people needed');
    await noViolations(vol);
    await card.getByRole('button', { name: 'I can help' }).click();
    await expect(card).toContainText('You are signed up');
    await expect(card).toContainText('1 more person needed');
    await vol.screenshot({ path: 'screenshots/features/kitchen-volunteer-phone.png', fullPage: true });

    await coord.getByRole('tab', { name: 'Shopping' }).click();
    await coord.getByLabel('Name', { exact: true }).fill('Thursday shopping');
    await coord.getByLabel('One item per line').fill('6 dozen eggs\n10 kg flour');
    await expect(coord.getByText('2 items')).toBeVisible();
    await coord.getByRole('button', { name: 'Save list' }).click();
    await expect(coord.getByText('List saved.')).toBeVisible();
    await coord.getByRole('listitem').filter({ hasText: 'Thursday shopping' }).first().getByRole('button', { name: 'Send to…' }).click();
    const dialog = coord.getByRole('dialog');
    await dialog.getByLabel('Yaakov Driver').check();
    await dialog.getByLabel('Rivka Helper').check();
    await dialog.getByRole('button', { name: /Check who gets it \(2\)/ }).click();
    await expect(dialog).toContainText('This will go to 2 people');
    await noViolations(coord);
    await coord.screenshot({ path: 'screenshots/features/shopping-preview-phone.png', fullPage: true });
    await dialog.getByRole('button', { name: 'Yes, send to 2' }).click();
    await expect(coord.getByText('Sent to 2 people.')).toBeVisible();

    // The same people again: the preview says it was already sent and offers no send button.
    await coord.getByRole('listitem').filter({ hasText: 'Thursday shopping' }).first().getByRole('button', { name: 'Send to…' }).click();
    await dialog.getByLabel('Yaakov Driver').check();
    await dialog.getByLabel('Rivka Helper').check();
    await dialog.getByRole('button', { name: /Check who gets it/ }).click();
    await expect(dialog).toContainText('already got this list');
    await expect(dialog.getByRole('button', { name: /Yes, send/ })).toHaveCount(0);
    await coordCtx.close();
    await volCtx.close();
  });
});

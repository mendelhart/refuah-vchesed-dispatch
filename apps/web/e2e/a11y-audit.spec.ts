import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from './helpers';

/**
 * Automated accessibility audit (axe-core, WCAG 2.1 A and AA) of every main
 * page, signed in as the role that uses it, at phone width.
 *
 * Two checks axe cannot do are done here directly:
 *   - no horizontal scrolling at 360 px wide (the narrowest phones in use)
 *   - text at 200% still fits: nothing overflows the screen sideways
 *
 * Any violation fails with the rule, the element and the page, so a fix can
 * go straight to it. Rules are never switched off here; a page that cannot
 * pass is fixed, not excused.
 */

const PAGES: Record<keyof typeof STATE_FILES | 'public', string[]> = {
  public: ['/login', '/volunteer/apply', '/privacy'],
  volunteer: ['/', '/my-trips', '/my-availability', '/my-profile', '/my-id-card', '/directory', '/me', '/more', '/settings'],
  dispatcher: ['/board', '/callers', '/calls', '/contacts', '/volunteers', '/recurring', '/duty', '/equipment', '/vehicles', '/messages', '/impact'],
  admin: ['/admin', '/admin/people', '/admin/applications', '/admin/announcements', '/admin/templates', '/admin/audit', '/admin/notifications', '/admin/settings', '/admin/exports', '/admin/backup', '/admin/data-fixes'],
};

async function settle(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  // Let skeletons resolve into content.
  await page.waitForTimeout(300);
}

function describeViolations(path: string, violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string[] {
  return violations.flatMap((v) =>
    v.nodes.slice(0, 5).map((n) => `${path} [${v.id}/${v.impact}] ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? v.help}`),
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const [role, paths] of Object.entries(PAGES) as Array<[keyof typeof PAGES, string[]]>) {
  test.describe(`a11y audit: ${role}`, () => {
    if (role !== 'public') test.use({ storageState: STATE_FILES[role] });

    test(`axe WCAG A/AA, ${role} pages`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'phone', 'audited at phone width');
      const found: string[] = [];
      for (const path of paths) {
        await settle(page, path);
        const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
        found.push(...describeViolations(path, result.violations));
      }
      expect(found, found.join('\n')).toEqual([]);
    });

    test(`axe colour contrast in dark mode, ${role} pages`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'phone', 'audited at phone width');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.addInitScript(() => { try { localStorage.setItem('rvc.theme', 'dark'); } catch { /* ignore */ } });
      const found: string[] = [];
      for (const path of paths) {
        await settle(page, path);
        const result = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
        found.push(...describeViolations(path, result.violations));
      }
      expect(found, found.join('\n')).toEqual([]);
    });

    test(`no sideways scrolling at 360 px or with 200% text, ${role} pages`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'phone', 'phone layout only');
      await page.setViewportSize({ width: 360, height: 760 });
      const found: string[] = [];
      for (const path of paths) {
        await settle(page, path);
        const at100 = await horizontalOverflow(page);
        if (at100 > 1) found.push(`${path}: ${at100}px sideways scroll at 360px`);
        await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
        await page.waitForTimeout(150);
        const at200 = await horizontalOverflow(page);
        if (at200 > 1) found.push(`${path}: ${at200}px sideways scroll with 200% text`);
      }
      expect(found, found.join('\n')).toEqual([]);
    });
  });
}

test.describe('keyboard', () => {
  test('every control on the sign-in page is reachable by Tab and shows a focus ring', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'phone', 'checked once');
    await page.goto('/login');
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return { tag: el.tagName.toLowerCase(), name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? '', outline: parseFloat(style.outlineWidth) || 0 };
      });
      if (!info) continue;
      expect(info.outline, `${info.tag} "${info.name}" has no visible focus ring`).toBeGreaterThanOrEqual(2);
      seen.push(info.tag);
    }
    expect(seen).toEqual(expect.arrayContaining(['input', 'button']));
  });
});

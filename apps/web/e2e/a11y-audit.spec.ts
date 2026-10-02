import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { STATE_FILES } from './helpers';

/**
 * Automated accessibility audit (axe-core, WCAG 2.1 A and AA) of every main
 * page, signed in as the role that uses it, at phone width.
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
  });
}


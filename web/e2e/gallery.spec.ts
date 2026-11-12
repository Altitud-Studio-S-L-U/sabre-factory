import { test, expect } from '@playwright/test';
import { mockFactoryApi, syntheticRun } from './fixtures';

// Visual evidence for design work: SABRE_GALLERY=<label> pnpm test:browser gallery
// writes one full-page capture per section and viewport to work/gallery/<label>/.
const label = process.env.SABRE_GALLERY;

const sections = [
  { name: 'runs', path: '/runs', ready: 'Runs' },
  { name: 'run-detail', path: '/runs/synthetic-run', ready: 'Full objective' },
  { name: 'agents', path: '/agents', ready: 'Agents' },
  { name: 'tools', path: '/tools', ready: 'Tools' },
  { name: 'memory', path: '/memory', ready: 'Memory' },
  { name: 'config', path: '/config', ready: 'Config' },
  { name: 'config-access', path: '/config?section=access', ready: 'Paired browsers' },
];

test.describe('gallery', () => {
  test.skip(!label, 'Set SABRE_GALLERY=<label> to capture the gallery');

  test.beforeEach(async ({ page }) => {
    await mockFactoryApi(page);
    const order = { ...syntheticRun(), status: 'waiting_input', phase: 'review' };
    await page.route('**/api/v1/work', (route) =>
      route.fulfill({
        json: [
          order,
          {
            ...syntheticRun(),
            id: 'synthetic-done',
            objective: 'Completed synthetic run',
            status: 'completed',
            phase: 'delivery',
          },
        ],
      }),
    );
    await page.route('**/api/v1/work/synthetic-run', (route) => route.fulfill({ json: order }));
    await page.route('**/api/v1/panel/browsers', (route) =>
      route.fulfill({
        json: {
          lifetime_days: 30,
          browsers: [
            {
              id: '0b0e3f0a-1111-4222-8333-444455556666',
              client: 'Chrome on Windows',
              current: true,
              created_at: '2026-11-01T09:00:00Z',
              last_used_at: '2026-11-11T09:00:00Z',
              expires_at: '2026-12-11T09:00:00Z',
            },
            {
              id: '1c1f4a1b-2222-4333-8444-555566667777',
              client: 'Safari on macOS',
              current: false,
              created_at: '2026-11-02T09:00:00Z',
              last_used_at: '2026-11-09T09:00:00Z',
              expires_at: '2026-12-09T09:00:00Z',
            },
          ],
        },
      }),
    );
  });

  for (const section of sections) {
    test(section.name, async ({ page }) => {
      await page.goto(section.path);
      await expect(page.getByText(section.ready, { exact: false }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: `../work/gallery/${label}/${section.name}-${test.info().project.name}.png`,
        fullPage: true,
        scale: 'css',
      });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      test.info().annotations.push({ type: 'horizontal-overflow', description: String(overflow) });
    });
  }

  test('supervisor-open', async ({ page }) => {
    await page.goto('/runs/synthetic-run');
    await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Supervisor conversation' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: `../work/gallery/${label}/supervisor-open-${test.info().project.name}.png`,
      scale: 'css',
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

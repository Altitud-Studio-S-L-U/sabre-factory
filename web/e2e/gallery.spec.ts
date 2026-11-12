import { test, expect } from '@playwright/test';
import { mockFactoryApi, syntheticRun } from './fixtures';
import {
  memoryDetail,
  memoryGraph,
  memoryItem,
  memoryRecalls,
  memoryReview,
} from '../src/test/memoryFixture';

// Visual evidence for design work: SABRE_GALLERY=<label> pnpm test:browser gallery
// writes one full-page capture per section and viewport to work/gallery/<label>/.
const label = process.env.SABRE_GALLERY;

const sections = [
  { name: 'runs', path: '/runs', ready: 'Runs' },
  { name: 'run-detail', path: '/runs/synthetic-run', ready: 'Full objective' },
  { name: 'agents', path: '/agents', ready: 'Agents' },
  { name: 'tools', path: '/tools', ready: 'Tools' },
  { name: 'memory', path: '/memory', ready: 'Memory' },
  { name: 'memory-review', path: '/memory', ready: 'Memory', tab: 'Review queue' },
  { name: 'memory-recalls', path: '/memory', ready: 'Memory', tab: 'Recall log' },
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
    // Realistic project memory so the knowledge map, review queue and recall log can be reviewed.
    await page.route('**/api/v1/projects/*/memory/graph*', (route) => route.fulfill({ json: memoryGraph() }));
    await page.route('**/api/v1/projects/*/memory/review', (route) =>
      route.fulfill({ json: memoryReview() }),
    );
    await page.route('**/api/v1/projects/*/memory/recalls*', (route) =>
      route.fulfill({ json: memoryRecalls() }),
    );
    await page.route('**/api/v1/memory/m27', (route) => route.fulfill({ json: memoryDetail() }));
    await page.route('**/api/v1/memory?*', (route) =>
      route.fulfill({
        json: [
          memoryItem(),
          memoryItem({ id: 'l05', kind: 'lesson', content: 'Seed the pricing suite before running it' }),
        ],
      }),
    );
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
      if ('tab' in section && section.tab)
        await page.getByRole('tab', { name: section.tab, exact: true }).click();
      if (section.name === 'memory')
        await page.getByRole('button', { name: "Memory: Discount uses banker's rounding" }).click();
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

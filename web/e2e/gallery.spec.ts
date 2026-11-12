import { test, expect } from '@playwright/test';
import { mockFactoryApi, syntheticRun } from './fixtures';
import {
  memoryDetail,
  memoryGraph,
  memoryItem,
  memoryRecalls,
  memoryReview,
} from '../src/test/memoryFixture';
import { configurationHistory, runtimeSettings } from '../src/test/runtimeFixture';

// Visual evidence for design work: SABRE_GALLERY=<label> pnpm test:browser gallery
// writes one full-page capture per section and viewport to work/gallery/<label>/.
const label = process.env.SABRE_GALLERY;

const sections = [
  { name: 'runs', path: '/runs', ready: 'Runs' },
  { name: 'run-detail', path: '/runs/synthetic-run', ready: 'Full objective' },
  { name: 'agents', path: '/agents', ready: 'Agents' },
  { name: 'tools', path: '/tools', ready: 'Tools' },
  { name: 'memory', path: '/memory', ready: 'Memory' },
  { name: 'memory-records', path: '/memory', ready: 'Memory', tab: 'Records' },
  { name: 'memory-review', path: '/memory', ready: 'Memory', tab: 'Review queue' },
  { name: 'memory-recalls', path: '/memory', ready: 'Memory', tab: 'Recall log' },
  { name: 'config', path: '/config', ready: 'Config' },
  { name: 'config-access', path: '/config?section=access', ready: 'Paired browsers' },
  { name: 'config-environment', path: '/config?section=environment', ready: 'Set by the environment' },
  { name: 'config-history', path: '/config?section=history', ready: 'Revision history' },
  { name: 'projects', path: '/projects', ready: 'Example project' },
  { name: 'security', path: '/security', ready: 'Independent review' },
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
    await page.route('**/api/v1/configuration/history*', (route) =>
      route.fulfill({ json: configurationHistory() }),
    );
    await page.route('**/api/v1/system', (route) =>
      route.fulfill({ json: { runtime_settings: runtimeSettings() } }),
    );
    await page.route('**/api/v1/agents/activity*', (route) =>
      route.fulfill({
        json: {
          days: 7,
          since: '2026-11-05T00:00:00Z',
          repair_cycles: 2,
          waiting_for_input: 1,
          active_runs: [],
          active_runs_truncated: false,
          roles: [
            {
              role: 'developer',
              invocations: 18,
              completed: 15,
              failed: 1,
              interrupted: 2,
              duration_ms: 812000,
              model_calls: 18,
              tokens: 412000,
            },
            {
              role: 'analyst',
              invocations: 9,
              completed: 9,
              failed: 0,
              interrupted: 0,
              duration_ms: 214000,
              model_calls: 9,
              tokens: 98000,
            },
            {
              role: 'qa',
              invocations: 7,
              completed: 6,
              failed: 1,
              interrupted: 0,
              duration_ms: 160000,
              model_calls: 7,
              tokens: null,
            },
          ],
        },
      }),
    );
    // Realistic project memory so the knowledge map, review queue and recall log can be reviewed.
    await page.route('**/api/v1/projects/*/memory/graph*', (route) => route.fulfill({ json: memoryGraph() }));
    await page.route('**/api/v1/projects/*/memory/review', (route) =>
      route.fulfill({ json: memoryReview() }),
    );
    await page.route('**/api/v1/projects/*/memory/recalls*', (route) =>
      route.fulfill({ json: memoryRecalls() }),
    );
    await page.route('**/api/v1/projects/*/memory/items*', (route) =>
      route.fulfill({
        json: {
          commit: '5be10d7'.padEnd(40, '0'),
          next_cursor: 'synthetic-next',
          items: [
            memoryItem(),
            memoryItem({
              id: 'l90',
              kind: 'lesson',
              state: 'pending',
              active: false,
              approved_at: null,
              content:
                'Repair lesson: Apply the loyalty discount before tax\nVerification passed after 1 repair cycle; delivered at commit a41c9e200000.\n- Cycle 1: failed `pytest -q tests/pricing`.',
              proposed_by: { channel: 'factory', role: 'repair', work_id: 'synthetic-run' },
              recall_count: 0,
              last_recalled_at: null,
              citations: [],
            }),
            memoryItem({
              id: 'p41',
              content: 'Discount rounds half up',
              state: 'active',
              validity: {
                commit: '5be10d7'.padEnd(40, '0'),
                state: 'stale',
                reason: 'citations_changed',
                changed_paths: [{ path: 'src/pricing/discount.py', change: 'changed' }],
                checked_at: '2026-11-12T09:00:00Z',
              },
              recall_count: 3,
            }),
            memoryItem({
              id: 'o12',
              kind: 'lesson',
              content: 'Run the pricing suite with the seeded fixtures only',
              state: 'invalidated',
              active: false,
              invalidated_at: '2026-11-11T09:00:00Z',
              recall_count: 2,
              scope: 'commit',
            }),
          ],
        },
      }),
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
      if (section.name === 'memory-records')
        await page.getByRole('button', { name: 'Inspect memory m27' }).click();
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

// Loading states: hold the named requests open so each screen's skeleton can be reviewed.
const loadingStates = [
  { name: 'loading-runs', path: '/runs', hold: ['**/api/v1/work'] },
  {
    name: 'loading-run-detail',
    path: '/runs/synthetic-run',
    hold: ['**/api/v1/work', '**/api/v1/work/synthetic-run'],
  },
  { name: 'loading-agents', path: '/agents', hold: ['**/api/v1/flows/*/topology', '**/api/v1/agents'] },
  { name: 'loading-memory', path: '/memory', hold: ['**/api/v1/projects/*/knowledge'] },
  { name: 'loading-config', path: '/config', hold: ['**/api/v1/configuration'] },
];

test.describe('gallery · loading', () => {
  test.skip(!label, 'Set SABRE_GALLERY=<label> to capture the gallery');

  for (const state of loadingStates) {
    test(state.name, async ({ page }) => {
      await mockFactoryApi(page);
      for (const pattern of state.hold) await page.route(pattern, () => new Promise<void>(() => undefined));
      await page.goto(state.path);
      await expect(page.locator('[data-skeleton]').first()).toBeVisible();
      await page.mouse.move(0, 0);
      await page.screenshot({
        path: `../work/gallery/${label}/${state.name}-${test.info().project.name}.png`,
        fullPage: true,
        scale: 'css',
        animations: 'disabled',
      });
    });
  }
});

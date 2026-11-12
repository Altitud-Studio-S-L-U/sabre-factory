import { createRequire } from 'node:module';
import { test, expect, type Page } from '@playwright/test';
import { mockFactoryApi, syntheticRun } from './fixtures';
import { configurationHistory, runtimeSettings } from '../src/test/runtimeFixture';

// Automated WCAG 2.1 A/AA checks with axe-core on every section, in both themes and both
// viewports. Automated rules find a part of the problems; they do not replace a manual review.
const axe = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const sections = [
  { name: 'runs', path: '/runs', ready: 'Runs' },
  { name: 'run detail', path: '/runs/synthetic-run', ready: 'Full objective' },
  { name: 'agents', path: '/agents', ready: 'Agents' },
  { name: 'tools', path: '/tools', ready: 'Tools' },
  { name: 'memory', path: '/memory', ready: 'Memory' },
  { name: 'memory records', path: '/memory', ready: 'Memory', tab: 'Records' },
  { name: 'memory review queue', path: '/memory', ready: 'Memory', tab: 'Review queue' },
  { name: 'memory recall log', path: '/memory', ready: 'Memory', tab: 'Recall log' },
  { name: 'config', path: '/config', ready: 'Config' },
  { name: 'config access', path: '/config?section=access', ready: 'Paired browsers' },
  { name: 'config environment', path: '/config?section=environment', ready: 'Set by the environment' },
  { name: 'config history', path: '/config?section=history', ready: 'Revision history' },
  { name: 'config about', path: '/config?section=about', ready: 'Graph synthetic' },
  { name: 'projects', path: '/projects', ready: 'Example project' },
  { name: 'security', path: '/security', ready: 'Independent review' },
];

type Violation = { id: string; impact: string; help: string; nodes: { target: string; summary: string }[] };

async function violations(page: Page): Promise<Violation[]> {
  await page.addScriptTag({ path: axe });
  return page.evaluate(async () => {
    type Result = {
      violations: {
        id: string;
        impact: string;
        help: string;
        nodes: { target: string[]; failureSummary: string }[];
      }[];
    };
    const runner = (
      window as unknown as { axe: { run: (context: Document, options: object) => Promise<Result> } }
    ).axe;
    const result = await runner.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return result.violations
      .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes
          .slice(0, 6)
          .map((node) => ({ target: node.target.join(' '), summary: node.failureSummary })),
      }));
  });
}

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
    route.fulfill({
      json: {
        checked_at: '2026-11-12T09:00:00Z',
        application: { name: 'SABRE', version: '0.0.0-synthetic', graph_version: 'synthetic' },
        runtime: { python: '3.14.0', implementation: 'CPython', system: 'Linux', architecture: 'x86_64' },
        packages: [],
        components: [],
        limits: {
          concurrent_work: 2,
          writers_per_repository: 1,
          repair_cycles: 2,
          codex_invocations: 1,
          claude_invocations: null,
        },
        models: [],
        runtime_settings: runtimeSettings(),
      },
    }),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

for (const theme of ['dark', 'light'] as const)
  for (const section of sections)
    test(`${section.name} has no serious accessibility violation in the ${theme} theme`, async ({ page }) => {
      if (theme === 'light') await page.addInitScript(() => localStorage.setItem('sabre.theme', 'light'));
      await page.goto(section.path);
      await expect(page.getByText(section.ready).first()).toBeVisible();
      if (section.tab) await page.getByRole('tab', { name: section.tab }).click();
      await page.waitForLoadState('networkidle');
      await expect(page.locator('[data-skeleton]')).toHaveCount(0);
      expect(await violations(page)).toEqual([]);
    });

const states: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'the new run dialog',
    open: async (page) => {
      await page.goto('/runs');
      await page
        .getByRole('button', { name: /New run/ })
        .first()
        .click();
      await expect(page.getByRole('dialog', { name: 'New run', exact: true })).toBeVisible();
    },
  },
  {
    name: 'the command palette',
    open: async (page) => {
      await page.goto('/runs');
      await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible();
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'the Supervisor conversation',
    open: async (page) => {
      await page.goto('/runs/synthetic-run');
      await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Supervisor conversation' })).toBeVisible();
    },
  },
  {
    name: 'a pending owner confirmation',
    open: async (page) => {
      await page.route('**/api/v1/confirmations', (route) =>
        route.fulfill({
          json: {
            version: 1,
            pending: 1,
            items: [
              {
                version: 1,
                id: 'confirmation-1',
                kind: 'budget.tokens',
                work_id: 'synthetic-run',
                source: 'mcp',
                state: 'pending',
                summary: 'Raise the token limit from 100,000 to 250,000',
                request: { expected_revision: 1, expected_max_tokens: 100000, max_tokens: 250000 },
                request_digest: 'a'.repeat(64),
                created_at: '2026-11-12T09:00:00Z',
                expires_at: '2026-11-13T09:00:00Z',
                decided_at: null,
                error_code: null,
                error_message: null,
              },
            ],
          },
        }),
      );
      await page.goto('/runs');
      await page.getByText('Exact request').click();
      await expect(page.getByText('250,000', { exact: true })).toBeVisible();
    },
  },
];

for (const theme of ['dark', 'light'] as const)
  for (const state of states)
    test(`${state.name} has no serious accessibility violation in the ${theme} theme`, async ({ page }) => {
      if (theme === 'light') await page.addInitScript(() => localStorage.setItem('sabre.theme', 'light'));
      await state.open(page);
      await page.waitForLoadState('networkidle');
      expect(await violations(page)).toEqual([]);
    });

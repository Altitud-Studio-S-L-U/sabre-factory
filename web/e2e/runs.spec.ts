import { test, expect } from '@playwright/test';
import { captureSource, syntheticRun } from './fixtures';
import { runUsageSnapshot } from '../src/test/runUsageFixture';
import type { WorkOrder, SequencedEvent } from '../src/api';

test('cancelled runs remain inspectable in Closed with a readable final-state badge', async ({ page }) => {
  const order = { ...syntheticRun(), status: 'cancelled', error_code: null };
  const writes: string[] = [];
  await page.route('**/api/v1/work**', async (route) => {
    if (route.request().method() === 'POST') writes.push(route.request().url());
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/work')) return route.fulfill({ json: [order] });
    if (path.endsWith('/work/synthetic-run')) return route.fulfill({ json: order });
    await route.fallback();
  });
  await page.goto('/work');
  await page.getByRole('button', { name: 'Closed', exact: true }).click();
  await expect(page.locator('.run-rail-item')).toHaveCount(1);
  await page.locator('.run-rail-item').click();
  await expect(page).toHaveURL(/\/work\/synthetic-run/);
  const badge = page.locator('.detail-header .badge-cancelled');
  await expect(badge).toHaveText('Cancelled');
  await expect(badge.locator('svg.lucide')).toBeVisible();
  const contrast = await badge.evaluate((el) => {
    const probe = document.createElement('canvas').getContext('2d')!;
    const srgb = (color: string) => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = color;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const l = (color: string) => {
      const c = srgb(color)
        .map(Number)
        .map((n) => {
          n /= 255;
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        });
      return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    };
    const css = getComputedStyle(el),
      a = l(css.color),
      b = l(css.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
  await captureSource(page, 'cancelled-history');
});

test('cancelled run with a retained budget error shows history instead of a pending decision', async ({
  page,
}) => {
  const base = syntheticRun();
  const order: WorkOrder = {
    ...base,
    status: 'cancelled',
    control: 'cancel',
    phase: 'verification',
    summary: 'Work order cancelled',
    error_code: 'BUDGET_EXHAUSTED',
    limiting_metric: 'tokens',
    budget_denial: {
      version: 1,
      metric: 'tokens',
      basis: 'next_reservation',
      used: 237197,
      reserved: 0,
      requested: 80000,
      required: 317197,
      limit: 300000,
    },
    questions: [
      {
        id: 'synthetic-open-question',
        work_id: base.id,
        plan_revision: base.plan_revision,
        prompt: 'Synthetic question left open before cancellation',
        kind: 'clarification',
        options: [],
        subject_digest: null,
        answer: null,
        answered_at: null,
      },
    ],
  };
  const failedStage: SequencedEvent = {
    sequence: 1,
    event: {
      version: 1,
      id: 'synthetic-failed-checks',
      work_id: order.id,
      plan_revision: 1,
      phase: 'checks',
      correlation_id: 'synthetic-checks',
      parent_id: null,
      agent_id: null,
      kind: 'stage',
      state: 'failed',
      name: 'checks',
      timestamp: '2026-11-10T11:00:05Z',
      duration_ms: 4000,
      error_code: 'BUDGET_EXHAUSTED',
      provider: null,
      model: null,
      trace_id: null,
      span_id: null,
    },
  };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/v1/work')) writes.push(request.url());
  });
  await page.route('**/api/v1/work**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/work')) return route.fulfill({ json: [order] });
    if (path.endsWith('/work/synthetic-run')) return route.fulfill({ json: order });
    if (path.endsWith('/execution-events'))
      return route.fulfill({ json: { items: [failedStage], next_cursor: 1, has_more: false } });
    await route.fallback();
  });
  await page.goto('/work');
  await page.getByRole('button', { name: 'Closed', exact: true }).click();
  await page
    .getByRole('button', { name: /Correct the synthetic example/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/work\/synthetic-run/);
  const history = page.getByRole('note', { name: 'Retained run history' });
  await expect(history).toContainText('History · BUDGET_EXHAUSTED');
  await expect(history).toContainText('No decision is pending');
  await expect(page.getByText(/waiting for your budget decision/)).toHaveCount(0);
  for (const name of ['Review budget options', 'Resume', 'Resolve budget', 'Pause', 'Cancel run'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByText('Your decision unlocks the next step')).toHaveCount(0);
  const inspector = page.getByRole('region', { name: 'Execution inspector' });
  await expect(inspector.getByText(/Historical record · BUDGET_EXHAUSTED · event #1/)).toBeVisible();
  await expect(inspector.getByText('Work order cancelled')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Review & security' }).click();
  await expect(page.getByText(/Progress is blocked/)).toHaveCount(0);
  await expect(page.getByText(/This run was cancelled after/)).toBeVisible();
  expect(writes).toEqual([]);
  await captureSource(page, 'cancelled-retained-error');
});

test('expanded run preserves inspection and exposes review and security without page overflow', async ({
  page,
}) => {
  const order = syntheticRun();
  await page.route('**/api/v1/work**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/work')) return route.fulfill({ json: [order] });
    if (path.endsWith('/work/synthetic-run')) return route.fulfill({ json: order });
    await route.fallback();
  });
  await page.goto('/work/synthetic-run');
  const timeline = page.getByRole('region', { name: 'Execution timeline' });
  const expand = timeline.getByRole('button', { name: 'Expand workspace' });
  await timeline.getByRole('tab', { name: 'JSON', exact: true }).click();
  await expand.click();
  const workspace = page.getByRole('dialog', { name: 'Expanded run workspace' });
  await expect(workspace).toBeVisible();
  const box = await workspace.boundingBox();
  expect(Math.round(box!.width)).toBe(page.viewportSize()!.width);
  await workspace.getByRole('button', { name: 'Zoom in timeline' }).click();
  await expect(workspace.getByText('200%', { exact: true })).toBeVisible();
  await expect(workspace.getByRole('tab', { name: 'JSON', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const scroll = workspace.locator('.observed-scroll');
  expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await scroll.evaluate((el) => {
    el.scrollLeft = 120;
  });
  expect(await scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await captureSource(page, 'expanded-run');
  await page.keyboard.press('Escape');
  await expect(workspace).not.toBeVisible();
  await expect(expand).toBeFocused();
  await page.getByRole('tab', { name: 'Review & security', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Security results' })).toContainText(
    'Zero findings does not establish',
  );
  await expect(page.getByRole('region', { name: 'Independent review' })).toContainText(
    'No independent review result',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureSource(page, 'review-security');
});

test('legacy blocked runs expose explicit budget decisions without resuming', async ({ page }) => {
  const order = { ...syntheticRun(), status: 'blocked', error_code: 'BUDGET_EXHAUSTED' };
  let writes = 0;
  await page.route('**/api/v1/work**', async (route) => {
    if (route.request().method() === 'POST') writes++;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/work')) return route.fulfill({ json: [order] });
    if (path.endsWith('/work/synthetic-run')) return route.fulfill({ json: order });
    if (path.endsWith('/audit'))
      return route.fulfill({
        json: {
          work_id: order.id,
          plan_revision: 1,
          status: 'blocked',
          phase: order.phase,
          usage: runUsageSnapshot(order.id).usage,
          models: [],
          agents: [],
          tools: [],
          context: null,
          checkpoint_count: 0,
          checkpoint_threads: 0,
          truncated: false,
        },
      });
    if (path.endsWith('/budget'))
      return route.fulfill({
        json: {
          version: 1,
          revision: 0,
          metrics: Object.fromEntries(
            ['tokens', 'invocations', 'active_seconds', 'repairs'].map((metric) => [
              metric,
              {
                policy: { primary: 1000, reserve: 0, absolute: 1000 },
                used: 100,
                reserved: 0,
                remaining: 900,
                unknown: false,
              },
            ]),
          ),
          authorizations: [],
          limiting_metric: 'tokens',
          pending_step: 'implementation',
          token_prevention: 'reservation_bound',
          unsettled_usage_ids: [],
          unreconciled_calls: 0,
        },
      });
    await route.fallback();
  });
  await page.goto('/work/synthetic-run');
  await page.getByRole('button', { name: 'Review budget options' }).click();
  await expect(page.getByRole('region', { name: 'Budget decision' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove a ceiling', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Resume this run after saving the limits' }),
  ).not.toBeChecked();
  expect(writes).toBe(0);
});

test('live usage updates within a phase and retains a stale ledger until explicit retry', async ({
  page,
}) => {
  await page.clock.install();
  let order = syntheticRun();
  let snapshot = runUsageSnapshot(order.id, 1, 100);
  let outage = false;
  let usageRequests = 0;
  let auditRequests = 0;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/work**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/work') {
      await route.fulfill({ json: [order] });
      return;
    }
    if (path === `/api/v1/work/${order.id}`) {
      await route.fulfill({ json: order });
      return;
    }
    if (path.endsWith('/usage')) {
      usageRequests++;
      await route.fulfill(
        outage ? { status: 503, json: { message: 'Synthetic usage unavailable' } } : { json: snapshot },
      );
      return;
    }
    if (path.endsWith('/audit')) {
      auditRequests++;
      await route.fulfill({
        json: {
          work_id: order.id,
          plan_revision: order.plan_revision,
          status: order.status,
          phase: order.phase,
          context: null,
          usage: runUsageSnapshot(order.id, 1, 100).usage,
          agents: [],
          tools: [],
          checkpoint_count: 0,
          checkpoint_threads: 0,
          truncated: false,
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto(`/work/${order.id}`);
  const readout = page.getByLabel('Recorded run state');
  await expect(readout.getByText('100', { exact: true })).toBeVisible();
  const auditAtStart = auditRequests;
  expect(auditAtStart).toBeGreaterThan(0);
  snapshot = {
    ...runUsageSnapshot(order.id, 3, 2600),
    usage: {
      calls: 3,
      settled_calls: 2,
      unsettled_calls: 1,
      tokens: 3600,
      measured_tokens: 2600,
      unknown_reserved_tokens: 1000,
      cost_usd: 2.5,
    },
    measured_api_cost_usd: 0.25,
    reserved_api_cost_usd: 2.25,
  };
  await page.clock.runFor(2000);
  await expect(readout.getByText('2,600', { exact: true })).toBeVisible();
  await expect(readout.getByText('Model calls').locator('..')).toContainText('3 / 40');
  await expect(readout.getByText('$0.2500', { exact: true })).toBeVisible();
  await expect(readout.getByText(/1 calls pending.*1,000 tokens reserved/)).toBeVisible();
  expect(auditRequests).toBe(auditAtStart);
  expect(order.calls_used).toBe(1);
  expect(order.phase).toBe('implementation');
  outage = true;
  await page.clock.runFor(2000);
  const stale = page.getByRole('alert').filter({ hasText: 'Live usage could not be refreshed' });
  await expect(stale).toContainText('may be stale');
  await expect(readout.getByText('2,600', { exact: true })).toBeVisible();
  const failedCount = usageRequests;
  await page.clock.runFor(6000);
  expect(usageRequests).toBe(failedCount);
  snapshot = runUsageSnapshot(order.id, 4, 3100);
  outage = false;
  await page.getByRole('button', { name: 'Retry usage', exact: true }).click();
  await expect(readout.getByText('3,100', { exact: true })).toBeVisible();
  await expect(stale).toHaveCount(0);
  order = { ...order, status: 'cancelled' };
  snapshot = runUsageSnapshot(order.id, 4, 3200);
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(readout.getByText('3,200', { exact: true })).toBeVisible();
  const finalCount = usageRequests;
  await page.clock.runFor(6000);
  expect(usageRequests).toBe(finalCount);
  expect(errors).toEqual([]);
});

test('new run protects dirty input and pending submission from Escape or backdrop dismissal', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  await page.route('**/api/v1/work', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    posts++;
    await pending;
    await route.fulfill({
      status: 503,
      json: { message: 'Synthetic launch could not be accepted; retained draft' },
    });
  });
  await page.goto('/work');
  await page
    .getByRole('button', { name: /New run/ })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'New run', exact: true });
  await dialog.getByLabel('What do you need?').fill('Synthetic guarded run');
  await dialog.getByLabel('Acceptance criteria').fill('Synthetic registered checks pass');
  await page.keyboard.press('Escape');
  await expect(dialog.getByText('Discard your unsaved changes?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog.getByLabel('What do you need?')).toHaveValue('Synthetic guarded run');
  await dialog.getByRole('button', { name: 'Launch flow' }).click();
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close New run' })).toBeDisabled();
  release();
  await expect(dialog.getByRole('alert')).toContainText('retained draft');
  await expect(dialog).toHaveAttribute('aria-busy', 'false');
  expect(posts).toBe(1);
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: /New run/ }).first()).toBeFocused();
});

test('usage meters retain quota semantics with padded dark tracks and responsive cards', async ({ page }) => {
  // Synthetic values exercise appearance only; this fixture does not run a model.
  const order = syntheticRun();
  order.calls_used = 7;
  order.tokens_used = 18420;
  order.cost_usd = 1.2;
  order.active_seconds_used = 252;
  order.budget.max_cost_usd = 5;
  await page.route('**/api/v1/work**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/work')) return route.fulfill({ json: [order] });
    if (path.endsWith('/work/synthetic-run')) return route.fulfill({ json: order });
    if (path.endsWith('/audit'))
      return route.fulfill({
        json: {
          work_id: order.id,
          plan_revision: order.plan_revision,
          status: order.status,
          phase: order.phase,
          usage: runUsageSnapshot(order.id, 7, 18420).usage,
          context: null,
          models: [],
          agents: [],
          tools: [],
          checkpoint_count: 0,
          checkpoint_threads: 0,
          truncated: false,
        },
      });
    await route.fallback();
  });
  await page.goto('/work/synthetic-run');
  await page.getByRole('tab', { name: 'Limits & scope', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Usage and limits' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('meter')).toHaveCount(4);
  const tokens = panel.getByRole('meter', { name: 'Tokens', exact: true });
  await expect(tokens).toHaveAttribute('max', '100000');
  await expect(tokens).toHaveAttribute('value', '18420');
  expect(await tokens.evaluate((element) => element.getBoundingClientRect().height)).toBe(12);
  expect(await tokens.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(48, 55, 67)',
  );
  expect(
    await panel.evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft)),
  ).toBeGreaterThanOrEqual(16);
  const columns = await panel
    .getByTestId('usage-meter-grid')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(test.info().project.name === 'mobile' ? 1 : 2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: `../work/usage-cards-${test.info().project.name}.png` });
});

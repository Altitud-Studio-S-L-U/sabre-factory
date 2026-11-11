import { test, expect } from '@playwright/test';
import { configuration } from '../src/test/modelConfigurationFixture';
import type { WorkOrder, SequencedEvent } from '../src/api';

// These browser journeys use explicitly synthetic API responses. PostgreSQL and
// execution recovery are verified separately by backend integration tests.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (path.includes('/panel/session'))
      json = {
        authenticated: true,
        csrf_token: 'synthetic-browser-csrf',
        expires_at: '2099-01-01T00:00:00Z',
      };
    if (path.endsWith('/projects'))
      json = [
        {
          id: 'synthetic-project',
          name: 'Example project',
          repository: 'https://github.com/example/demo',
          profile: 'node',
          default_branch: 'main',
          gate_commands: [['npm', 'test']],
          allowed_mcp_servers: [],
          approved_baseline: [],
          created_at: '2026-01-01T00:00:00Z',
        },
      ];
    if (path.endsWith('/status'))
      json = {
        database: 'connected',
        model: { provider: 'codex_cli', configured: true },
        roles: {},
        limits: { concurrent_work: 2 },
        telemetry: { configured: false },
      };
    if (path.endsWith('/model-configuration')) {
      const models = configuration();
      models.default.name = 'synthetic-model';
      json = models;
    }
    if (path.endsWith('/flows/parse')) {
      await route.fulfill({
        status: 422,
        json: { code: 'INVALID_FLOW_CONFIG', message: 'Configuration must match the versioned flow schema' },
      });
      return;
    }
    if (path.endsWith('/repository-proposals')) json = { items: [], truncated: false };
    if (path.endsWith('/notifications'))
      json = [
        {
          id: 'synthetic-delivery',
          event_id: 'synthetic-event',
          destination: 'example:0123456789',
          attempts: 6,
          state: 'failed',
          last_error: 'HTTP_503',
        },
      ];
    if (path.endsWith('/notifications/synthetic-delivery/retry'))
      json = [
        {
          id: 'synthetic-delivery',
          event_id: 'synthetic-event',
          destination: 'example:0123456789',
          attempts: 0,
          state: 'pending',
          last_error: null,
        },
      ];
    await route.fulfill({ json });
  });
});

test('phase configuration rejects malformed YAML without launching work', async ({ page }) => {
  const effects: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/work'))
      effects.push(request.url());
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /New run/ })
    .first()
    .click();
  await expect(page.getByRole('group', { name: 'Flow configuration' })).toBeVisible();
  await page.getByText('Import YAML configuration', { exact: true }).click();
  await page.getByLabel('Flow YAML').fill('version: 1\nexecute: arbitrary-command');
  await page.getByRole('button', { name: 'Apply configuration' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid YAML configuration');
  expect(effects).toEqual([]);
  await page.screenshot({ path: `../work/flow-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('failed notifications require explicit recovery and show pending after retry', async ({ page }) => {
  await page.goto('/integrations');
  await page.getByRole('button', { name: 'Refresh deliveries' }).click();
  const deliveries = page.getByRole('region', { name: 'Delivery notifications' });
  await expect(deliveries.getByRole('cell', { name: 'HTTP_503' })).toBeVisible();
  await deliveries.getByRole('button', { name: 'Retry delivery' }).click();
  await expect(deliveries.getByRole('cell', { name: 'pending', exact: true })).toBeVisible();
  await expect(deliveries.getByRole('button', { name: 'Retry delivery' })).toHaveCount(0);
});

test('incremental timeline reconciles tool completion and pause reflects persisted state', async ({
  page,
}) => {
  let order: WorkOrder = {
    id: 'synthetic-run',
    project_id: 'synthetic-project',
    mode: 'patch',
    objective: 'Correct the synthetic example',
    acceptance: ['The registered tests pass'],
    constraints: [],
    budget: { max_calls: 40, max_tokens: 100000, max_cost_usd: 0, active_seconds: 3600 },
    idempotency_key: 'synthetic-request-000',
    channel: 'web',
    channel_thread: null,
    flow_config: {
      version: 1,
      phases: {},
      phase_models: {},
      permissions: { architecture: true, dependency_changes: false, draft_pull_request: true },
      repair_cycles: 2,
    },
    resolved_flow: null,
    status: 'running',
    phase: 'implementation',
    graph_version: 'sabre-v1',
    plan_revision: 1,
    created_at: '2026-11-10T10:00:00Z',
    updated_at: '2026-11-10T10:00:00Z',
    tasks: [],
    questions: [],
    findings: [],
    security_snapshot_digest: null,
    security_rules_version: null,
    evidence: null,
    summary: 'Synthetic browser fixture',
    error_code: null,
    calls_used: 1,
    tokens_used: 100,
    cost_usd: 0,
    active_seconds_used: 1,
    control: null,
  };
  const event = (sequence: number, changes: Partial<SequencedEvent['event']>): SequencedEvent => ({
    sequence,
    event: {
      version: 1,
      id: `event-${sequence}`,
      work_id: order.id,
      phase: 'implementation',
      plan_revision: 1,
      correlation_id: 'synthetic-tool',
      parent_id: null,
      trace_id: null,
      span_id: null,
      kind: 'tool',
      state: 'started',
      name: 'read_file',
      timestamp: '2026-11-10T10:00:00Z',
      duration_ms: null,
      error_code: null,
      provider: null,
      model: null,
      ...changes,
    },
  });
  const cursors: number[] = [];
  await page.route('**/api/v1/work**', async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = [];
    if (url.pathname === '/api/v1/work') json = [order];
    if (url.pathname.endsWith('/synthetic-run')) json = order;
    if (url.pathname.endsWith('/pause')) {
      order = { ...order, status: 'paused', phase: 'implementation' };
      json = order;
    }
    if (url.pathname.endsWith('/audit'))
      json = {
        agents: [],
        tools: [],
        models: [],
        truncated: false,
        context: null,
        usage: {
          calls: 1,
          tokens: 100,
          cost_usd: 0,
          settled_calls: 1,
          unsettled_calls: 0,
          unknown_reserved_tokens: 0,
        },
      };
    if (url.pathname.endsWith('/execution-events')) {
      const after = Number(url.searchParams.get('after'));
      cursors.push(after);
      json =
        after === 0
          ? { items: [event(1, {})], next_cursor: 1, has_more: true }
          : {
              items: [
                event(2, { state: 'completed', duration_ms: 1200 }),
                event(3, {
                  kind: 'stage',
                  correlation_id: 'synthetic-stage',
                  name: 'implement',
                  state: 'completed',
                  duration_ms: 1500,
                }),
              ],
              next_cursor: 3,
              has_more: false,
            };
    }
    await route.fulfill({ json });
  });
  await page.goto('/work/synthetic-run');
  const timeline = page.getByRole('region', { name: 'Execution timeline' });
  await expect(timeline.locator('.execution-phase-heading').getByText('1.5 s')).toBeVisible();
  const map = timeline.getByRole('button', { name: 'implement · completed', exact: true });
  await expect(map).toBeVisible();
  await map.click();
  const inspector = timeline.getByRole('region', { name: 'Execution inspector' });
  await inspector.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(inspector.locator('pre').first()).toContainText('synthetic-stage');
  await expect(timeline.getByLabel('Recorded run state')).toContainText('100');
  await timeline.getByText('1 tool calls · 0 agent steps').click();
  await expect(timeline.getByText('read_file', { exact: true })).toHaveCount(1);
  await expect(timeline.locator('.execution-calls').getByText('1.2 s', { exact: true })).toBeVisible();
  // Development StrictMode replays the initial read; cursor advancement must still use the server receipt.
  expect([...new Set(cursors)].slice(0, 2)).toEqual([0, 1]);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.screenshot({ path: `../work/timeline-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('new repository flow requires explicit authorization and submits selected limits', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/v1/create-flows', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 202,
      json: {
        id: 'synthetic-proposal',
        request: submitted.repository,
        status: 'approved',
        request_digest: 'a'.repeat(64),
        revision: 1,
        created_at: '2026-11-10T10:00:00Z',
        updated_at: '2026-11-10T10:00:00Z',
        approved_at: '2026-11-10T10:00:00Z',
        started_at: null,
        receipt: null,
        candidate: null,
        error_code: null,
      },
    });
  });
  await page.goto('/integrations');
  await page.getByText('Create a repository and launch its flow', { exact: true }).click();
  await page.getByLabel('Repository owner', { exact: true }).fill('example');
  await page.getByLabel('New repository name').fill('synthetic-project');
  await page.getByLabel('New project objective').fill('Build the synthetic project');
  await page.getByLabel('New project acceptance criteria').fill('Registered checks pass');
  await page.getByLabel('Model call limit').fill('12');
  await page.getByRole('button', { name: 'Authorize and launch create flow' }).click();
  expect(submitted).toBeUndefined();
  await page.getByLabel('I authorize creation with these details and execution within these limits.').check();
  await page.getByRole('button', { name: 'Authorize and launch create flow' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Launch accepted' })).toBeVisible();
  expect(submitted).toMatchObject({
    version: 1,
    authorize_repository_creation: true,
    repository: { owner: 'example', name: 'synthetic-project', initialize: true, visibility: 'private' },
    budget: { max_calls: 12, max_cost_usd: 0 },
    flow_config: { repair_cycles: 2 },
  });
});

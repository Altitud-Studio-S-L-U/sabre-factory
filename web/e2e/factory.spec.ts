import { test, expect, type Page } from '@playwright/test';
import { configuration } from '../src/test/modelConfigurationFixture';
import { factoryConfiguration } from '../src/test/factoryConfigurationFixture';
import { agentCatalog } from '../src/test/agentCatalogFixture';
import { runUsageSnapshot } from '../src/test/runUsageFixture';
import type { WorkOrder, SequencedEvent, DelegationCreate, DelegationGrant } from '../src/api';

async function captureSource(page: Page, section: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `../work/source-${section}-${test.info().project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
}
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
function syntheticRun(): WorkOrder {
  return {
    id: 'synthetic-run',
    project_id: 'synthetic-project',
    mode: 'patch',
    objective: 'Correct the synthetic example',
    acceptance: ['The registered tests pass'],
    constraints: [],
    budget: { max_calls: 40, max_tokens: 100000, max_cost_usd: 0, active_seconds: 3600, policy: null },
    idempotency_key: 'synthetic-request-000',
    channel: 'web',
    channel_thread: null,
    flow_config: {
      version: 1,
      phases: {},
      phase_models: {},
      permissions: { architecture: true, dependency_changes: false, draft_pull_request: true },
      repair_cycles: 2,
      budget_policy: null,
    },
    resolved_flow: null,
    configuration_snapshot: null,
    admission_request_digest: null,
    effective_budget_policy: null,
    budget_revision: 0,
    limiting_metric: null,
    repair_cycles_used: 0,
    last_failure_fingerprint: null,
    identical_failure_count: 0,
    last_failure_cycle: -1,
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
}

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

test('supervisor expands, retains per-run context and reveals recorded tools', async ({ page }) => {
  const orders = [
    { ...syntheticRun(), status: 'blocked', error_code: 'BUDGET_EXHAUSTED' },
    { ...syntheticRun(), id: 'synthetic-second', objective: 'Synthetic second run', status: 'failed' },
  ];
  await page.route('**/api/v1/work', (route) => route.fulfill({ json: orders }));
  await page.route('**/api/v1/operator/messages**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith('/tools')
        ? {
            version: 1,
            message_id: 'synthetic-budget-message',
            available: true,
            checkpoint_id: 'synthetic-checkpoint',
            truncated: false,
            tools: [
              {
                call_id: 'synthetic-call',
                name: 'get_work_budget',
                input: '{"work_id":"synthetic-run"}',
                output: '{"measured_tokens":1200}',
                status: 'completed',
                redacted: false,
                truncated: false,
              },
            ],
          }
        : {
            items: [
              {
                version: 1,
                id: 'synthetic-budget-message',
                work_id: null,
                text: 'Read the run budget',
                allowed_actions: [],
                state: 'completed',
                reply: 'Synthetic response: usage is recorded per run.',
                error_code: null,
                created_at: '2026-11-11T10:00:00Z',
              },
            ],
            truncated: false,
          },
    }),
  );
  await page.goto('/work');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const drawer = page.getByRole('region', { name: 'Supervisor conversation' });
  await drawer.getByRole('button', { name: 'Expand chat' }).click();
  const chat = page.getByRole('dialog', { name: 'Supervisor conversation' });
  await expect(chat).toBeVisible();
  await chat.locator('summary').filter({ hasText: 'Recorded tool invocations' }).click();
  await expect(chat.getByText('get_work_budget', { exact: false }).first()).toBeVisible();
  await chat.locator('summary').filter({ hasText: 'get_work_budget' }).click();
  await expect(chat.getByText('{"measured_tokens":1200}', { exact: true })).toBeVisible();
  await captureSource(page, 'supervisor-expanded');
  await chat.locator('summary').filter({ hasText: 'Attention inbox' }).click();
  await expect(chat.getByText('Synthetic second run', { exact: true })).toBeVisible();
  await chat.getByRole('button', { name: 'Discuss run · c-second' }).click();
  await expect(chat.getByRole('combobox', { name: /Conversation context/ })).toHaveValue('synthetic-second');
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('Synthetic draft stays in this run');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Supervisor conversation' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'Synthetic draft stays in this run',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

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
          browser_preview: null,
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
    if (path.endsWith('/configuration')) json = factoryConfiguration();
    if (path.endsWith('/releases')) json = { version: 1, items: [], truncated: false };
    if (path.endsWith('/a2a-tasks')) json = [];
    if (path.endsWith('/execution-events')) json = { items: [], next_cursor: 0, has_more: false };
    if (path.endsWith('/usage')) json = runUsageSnapshot(path.split('/').at(-2)!);
    if (path.endsWith('/agents')) json = path.includes('/a2a/') ? [] : agentCatalog();
    if (path.endsWith('/tools/catalog'))
      json = {
        version: 1,
        items: [
          {
            name: 'read_source',
            description: 'Synthetic bounded source read',
            effect: 'read',
            roles: ['developer', 'analyst', 'qa', 'reviewer', 'security'],
            scope: 'workspace',
            source: 'builtin',
          },
        ],
      };
    if (path.endsWith('/integrations'))
      json = [
        {
          id: 'github.read',
          kind: 'github',
          title: 'GitHub · repositories',
          description: 'Synthetic repository adapter',
          enabled: true,
          revision: 0,
          toggleable: true,
          credential_ids: ['github.read'],
          credential_configured: false,
          access: 'Public repository access; private access requires a scoped credential.',
          tools: [{ name: 'list_repositories', effect: 'read', roles: [] }],
        },
      ];
    if (path.endsWith('/ingestion'))
      json = { version: 1, project_id: 'synthetic-project', jobs: [], latest: null };
    if (path.endsWith('/knowledge'))
      json = {
        project_id: 'synthetic-project',
        profile: 'node',
        gate_count: 1,
        context: null,
        semantic_search: false,
        truncated: false,
        memories: { total: 0, active: 0, pending: 0, invalidated: 0 },
        checkpoints: { count: 0, threads: 0 },
      };
    if (path.endsWith('/operator/messages')) json = { items: [], truncated: false };
    if (path.endsWith('/topology'))
      json = {
        version: 1,
        graph_version: 'sabre-v1',
        mode: 'patch',
        lanes: [
          { id: 'preflight', label: 'Preflight', specialist: 'System', stages: ['intake'], next: ['spec'] },
          { id: 'spec', label: 'Spec', specialist: 'PM', stages: ['analysis', 'analyze'], next: ['build'] },
          {
            id: 'build',
            label: 'Build',
            specialist: 'Developer',
            stages: ['implementation', 'implement'],
            next: ['verify'],
          },
          {
            id: 'verify',
            label: 'Verify',
            specialist: 'QA',
            stages: ['checks', 'verification'],
            next: ['deliver'],
          },
          { id: 'deliver', label: 'Deliver', specialist: 'DevOps', stages: ['delivery'], next: [] },
        ],
        alternatives: [],
      };
    if (path.endsWith('/inspection'))
      json = {
        version: 1,
        work_id: 'synthetic-run',
        plan_revision: 1,
        agent_id: null,
        role: null,
        agents: [],
        records: [],
        evaluations: [],
        logs: [],
        context: null,
        next_cursor: 0,
        has_more: false,
        truncated: false,
        checkpoint_id: null,
        current: true,
      };
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

test('inbound agent access requires explicit scope and revocation and never restores the one-time credential', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const requests: DelegationCreate[] = [];
  let grant: DelegationGrant | null = null;
  let revoked = false;
  let writes = 0;
  const token = 'sabre_d_synthetic-browser-secret';
  await page.route('**/api/v1/delegations**', async (route) => {
    if (route.request().method() === 'POST') {
      writes++;
      const body = route.request().postDataJSON() as DelegationCreate;
      requests.push(body);
      const { version, idempotency_key: requestKey, ...limits } = body;
      expect(version).toBe(1);
      expect(requestKey.length).toBeGreaterThanOrEqual(8);
      grant = {
        version: 1,
        id: 'synthetic-browser-grant',
        principal: body.principal,
        data: limits,
        created_at: '2026-11-11T12:00:00Z',
        expires_at: '2099-11-11T13:00:00Z',
        revoked_at: null,
      };
      await route.fulfill({
        json: {
          version: 1,
          id: grant.id,
          principal: grant.principal,
          expires_at: grant.expires_at,
          token,
          recovered: false,
        },
      });
    } else if (route.request().method() === 'DELETE') {
      writes++;
      revoked = true;
      await route.fulfill({
        json: { version: 1, id: grant!.id, revoked: true, revoked_at: '2026-11-11T14:00:00Z' },
      });
    } else
      await route.fulfill({
        json: grant ? [{ ...grant, revoked_at: revoked ? '2026-11-11T14:00:00Z' : null }] : [],
      });
  });
  await page.goto('/agents');
  await page.getByRole('button', { name: 'External · MCP / A2A' }).click();
  const panel = page.getByRole('region', { name: 'Inbound delegated access' });
  await expect(panel.getByText('No delegated access issued.')).toBeVisible();
  await panel.getByRole('button', { name: 'Issue access' }).click();
  const dialog = page.getByRole('dialog', { name: 'Issue delegated access' });
  const issue = dialog.getByRole('button', { name: 'Issue scoped credential' });
  await expect(issue).toBeDisabled();
  await dialog.getByLabel('External principal').fill('synthetic-browser-partner');
  await dialog.getByRole('checkbox', { name: 'Example project' }).check();
  await dialog.getByRole('checkbox', { name: 'Inspect assigned runs' }).check();
  await expect(issue).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /I authorize/ }).check();
  expect(writes).toBe(0);
  await issue.click();
  const receipt = page.getByRole('dialog', { name: 'Save the delegated credential' });
  const credential = receipt.getByLabel('New delegated credential');
  await expect(credential).toHaveAttribute('type', 'password');
  await expect(credential).toHaveValue(token);
  await receipt.getByRole('button', { name: 'Reveal credential' }).click();
  await expect(credential).toHaveAttribute('type', 'text');
  await page.keyboard.press('Escape');
  await expect(receipt).not.toBeVisible();
  await expect(page.locator(`input[value="${token}"]`)).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    projects: ['synthetic-project'],
    operations: ['work.query'],
    max_runs: 1,
    max_calls: 10,
    max_tokens: 20000,
    max_cost_usd: 0,
    active_seconds: 600,
    expires_in: 3600,
  });
  await page.getByRole('link', { name: 'Runs', exact: true }).click();
  await page.getByRole('link', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'External · MCP / A2A' }).click();
  await panel.getByRole('button', { name: 'Revoke synthetic-browser-partner' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke delegated access?' });
  expect(writes).toBe(1);
  await expect(page.getByLabel('New delegated credential')).toHaveCount(0);
  await revoke.getByRole('button', { name: 'Confirm revocation' }).click();
  await expect(panel.getByText('Revoked', { exact: true })).toBeVisible();
  expect(writes).toBe(2);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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

test('supervisor persists an owner conversation across navigation and defaults to read-only', async ({
  page,
}) => {
  const requests: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  await page.route('**/api/v1/operator/messages**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(body);
      const message = {
        version: 1,
        id: 'synthetic-owner-message',
        work_id: body.work_id,
        text: body.text,
        allowed_actions: body.allowed_actions,
        state: 'queued',
        reply: null,
        error_code: null,
        created_at: '2026-11-11T10:00:00Z',
      };
      messages.push(message);
      await route.fulfill({ status: 202, json: message });
      return;
    }
    await route.fulfill({ json: { items: messages, truncated: false } });
  });
  await page.goto('/work');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const conversation = page.getByRole('region', { name: 'Supervisor conversation' });
  await conversation
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Watch out: preserve the public API');
  await conversation.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(conversation.getByText('Message queued. No action has been confirmed.')).toBeVisible();
  expect(requests[0]).toMatchObject({ version: 1, work_id: null, allowed_actions: [] });
  expect(requests[0]).not.toHaveProperty('principal');
  await conversation.getByRole('button', { name: 'Close supervisor' }).click();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Agents', exact: true })
    .click();
  await expect(
    page
      .getByRole('complementary', { name: 'Local specialists' })
      .getByRole('button', { name: /Supervisor/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  await expect(conversation.getByText('Watch out: preserve the public API', { exact: true })).toBeVisible();
  messages[0] = {
    ...messages[0],
    state: 'completed',
    reply: 'Synthetic reply: the concern is recorded. No run or policy was changed.',
  };
  await expect(
    conversation.getByText('Synthetic reply: the concern is recorded. No run or policy was changed.'),
  ).toBeVisible();
  await page.screenshot({ path: `../work/supervisor-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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

test('blocked supervisor message resumes by identity without expanding its original grants', async ({
  page,
}) => {
  let resumed: Record<string, unknown> | undefined;
  let message = {
    version: 1,
    id: 'synthetic-blocked-message',
    work_id: null,
    text: 'Inspect readiness',
    allowed_actions: [],
    state: 'blocked',
    reply: null,
    error_code: 'MODEL_NOT_READY' as string | null,
    created_at: '2026-11-11T10:00:00Z',
  };
  await page.route('**/api/v1/operator/messages**', async (route) => {
    if (route.request().method() === 'POST') {
      expect(new URL(route.request().url()).pathname).toBe(
        '/api/v1/operator/messages/synthetic-blocked-message/resume',
      );
      resumed = route.request().postDataJSON() as Record<string, unknown>;
      message = { ...message, state: 'queued', error_code: null };
      await route.fulfill({ status: 202, json: message });
      return;
    }
    await route.fulfill({ json: { items: [message], truncated: false } });
  });
  await page.goto('/work');
  await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
  const conversation = page.getByRole('region', { name: 'Supervisor conversation' });
  await conversation.getByRole('button', { name: 'Reconcile and resume message' }).click();
  await expect(conversation.getByText('Message queued. No action has been confirmed.')).toBeVisible();
  expect(resumed).toEqual({ version: 1, expected_error_code: 'MODEL_NOT_READY' });
  expect(message.allowed_actions).toEqual([]);
});

test('incremental timeline reconciles tool completion and pause reflects persisted state', async ({
  page,
}) => {
  let order = syntheticRun();
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
    if (url.pathname.endsWith('/usage')) json = runUsageSnapshot(order.id, 1, 100);
    if (url.pathname.endsWith('/pause')) {
      order = { ...order, status: 'paused', phase: 'implementation' };
      json = order;
    }
    if (url.pathname.endsWith('/audit'))
      json = {
        work_id: order.id,
        plan_revision: order.plan_revision,
        status: order.status,
        phase: order.phase,
        agents: [],
        tools: [],
        models: [],
        checkpoint_count: 0,
        checkpoint_threads: 0,
        truncated: false,
        context: null,
        usage: {
          calls: 1,
          tokens: 100,
          measured_tokens: 100,
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
    if (url.pathname.endsWith('/inspection'))
      json = {
        version: 1,
        work_id: order.id,
        plan_revision: order.plan_revision,
        agent_id: null,
        role: null,
        agents: [],
        records: [],
        evaluations: [],
        logs: [],
        context: null,
        next_cursor: 0,
        has_more: false,
        truncated: false,
        checkpoint_id: null,
        current: true,
      };
    await route.fulfill({ json });
  });
  await page.goto('/work/synthetic-run');
  const timeline = page.getByRole('region', { name: 'Execution timeline' });
  await timeline.getByText('Recorded event list', { exact: true }).click();
  await expect(timeline.locator('.execution-phase-heading').getByText('1.5 s')).toBeVisible();
  const map = timeline.getByRole('button', { name: 'implement · completed', exact: true });
  await expect(map).toBeVisible();
  await map.click();
  const inspector = timeline.getByRole('region', { name: 'Execution inspector' });
  await inspector.getByRole('tab', { name: 'JSON', exact: true }).click();
  await expect(inspector.locator('pre').first()).toContainText('synthetic-stage');
  await expect(timeline.getByLabel('Recorded run state')).toContainText('100');
  await timeline.getByText('1 tool calls · 0 agent steps').click();
  await expect(timeline.locator('.execution-calls').getByText('read_file', { exact: true })).toHaveCount(1);
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

test('five console sections keep inspection compact and modal drafts keyboard accessible', async ({
  page,
}) => {
  const mutations: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (['POST', 'PUT', 'DELETE'].includes(request.method())) mutations.push(new URL(request.url()).pathname);
  });
  let saved = factoryConfiguration();
  await page.route('**/api/v1/configuration**', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({ json: saved });
      return;
    }
    const body = route.request().postDataJSON() as { document: string; expected_revision?: number };
    if (body.document.includes('unknown_capability')) {
      await route.fulfill({
        json: {
          version: 1,
          valid: false,
          configuration: null,
          yaml: null,
          safe_diff: [],
          diagnostics: [
            {
              path: 'unknown_capability',
              message: 'Unknown capability rejected by the synthetic validation fixture',
            },
          ],
        },
      });
      return;
    }
    const next = JSON.parse(body.document) as typeof saved.configuration;
    if (method === 'POST') {
      await route.fulfill({
        json: {
          version: 1,
          valid: true,
          configuration: next,
          yaml: JSON.stringify(next, null, 2),
          safe_diff: [
            {
              path: 'models.default.name',
              before: JSON.stringify(saved.configuration.models.default.name),
              after: JSON.stringify(next.models.default.name),
            },
          ],
          diagnostics: [],
        },
      });
      return;
    }
    expect(body.expected_revision).toBe(saved.revision);
    saved = {
      ...saved,
      revision: saved.revision + 1,
      configuration: next,
      yaml: JSON.stringify(next, null, 2),
    };
    await route.fulfill({ json: saved });
  });
  await page.goto('/work');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('link')).toHaveCount(5);
  await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
  await captureSource(page, 'runs');
  await navigation.getByRole('link', { name: 'Agents', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Local specialists' }).getByRole('button'),
  ).toHaveCount(7);
  await page.getByRole('tab', { name: 'Chain', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'architecture', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Chain', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Instructions & skills' })).toBeFocused();
  await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
  const agentDialog = page.getByRole('dialog', { name: 'Edit Developer draft' });
  await expect(agentDialog).toBeVisible();
  await agentDialog
    .getByRole('textbox', { name: 'Instructions', exact: true })
    .fill('Synthetic keyboard review. Preserve all source evidence.');
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('dialog')?.open)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(agentDialog.getByText('Discard your unsaved changes?')).toBeVisible();
  await agentDialog.getByRole('button', { name: 'Keep editing' }).click();
  await agentDialog.getByRole('button', { name: 'Close Edit Developer draft' }).click();
  await agentDialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(agentDialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit draft', exact: true })).toBeFocused();
  await captureSource(page, 'agents');
  await navigation.getByRole('link', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GitHub · repositories', exact: true })).toBeVisible();
  await captureSource(page, 'tools');
  await page.getByRole('button', { name: 'Add MCP connection' }).click();
  const mcpDialog = page.getByRole('dialog', { name: 'Add MCP server' });
  await mcpDialog.getByLabel('Connection name').fill('synthetic-docs');
  await mcpDialog.getByLabel('Endpoint MCP').fill('https://tools.example.com/mcp');
  await page.keyboard.press('Escape');
  await expect(mcpDialog.getByText('Discard your unsaved changes?')).toBeVisible();
  await mcpDialog.getByRole('button', { name: 'Discard changes' }).click();
  await navigation.getByRole('link', { name: 'Memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No approved knowledge' })).toBeVisible();
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(
    page.getByText('No source context is recorded for this project in the available history.'),
  ).toBeVisible();
  await captureSource(page, 'memory');
  await navigation.getByRole('link', { name: 'Config', exact: true }).click();
  await page.getByRole('button', { name: '02 · Choose model' }).click();
  await page.getByLabel('Model identifier').fill('synthetic-console-model');
  await captureSource(page, 'config');
  await page.getByRole('button', { name: 'YAML / JSON' }).click();
  const configDocument = page.getByLabel('Configuration document');
  const valid = await configDocument.inputValue();
  await configDocument.fill(`${valid.slice(0, -1)},"unknown_capability":true}`);
  await page.getByRole('button', { name: 'Validate & preview' }).click();
  await expect(page.getByRole('alert')).toContainText('Unknown capability rejected');
  await expect(page.getByRole('button', { name: 'Download document' })).toBeDisabled();
  await configDocument.fill(valid);
  await page.getByRole('button', { name: 'Validate & preview' }).click();
  await expect(page.getByText('Schema validated')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'models.default.name' })).toBeVisible();
  await page.getByLabel('I approve the listed model data destinations for this configuration.').check();
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Configuration saved for future runs' }),
  ).toBeVisible();
  await captureSource(page, 'config-contract');
  expect(mutations.filter((path) => path === '/api/v1/configuration')).toHaveLength(1);
  expect(
    mutations.some(
      (path) => path.endsWith('/work') || path.includes('/mcp-connections/') || path.includes('/agents/'),
    ),
  ).toBe(false);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('disconnection preserves the catalog and disables changes until explicit recovery', async ({ page }) => {
  let unavailable = false;
  await page.route('**/api/v1/status', async (route) => {
    if (unavailable) await route.fulfill({ status: 503, json: { message: 'Synthetic service outage' } });
    else await route.fallback();
  });
  await page.goto('/tools');
  await expect(page.getByRole('heading', { name: 'GitHub · repositories', exact: true })).toBeVisible();
  unavailable = true;
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Data could not be refreshed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GitHub · repositories', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add MCP connection' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Disable connection' })).toBeDisabled();
  await captureSource(page, 'tools-disconnected');
  unavailable = false;
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add MCP connection' })).toBeEnabled();
  await expect(page.getByRole('alert').filter({ hasText: 'Data could not be refreshed' })).toHaveCount(0);
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

test('recorded process keeps phase attempts, agent tools, memory and failed checks separate from planned work', async ({
  page,
}) => {
  const order: WorkOrder = {
    ...syntheticRun(),
    status: 'blocked',
    phase: 'verification',
    error_code: 'SYNTHETIC_GATE_FAILED',
    summary:
      'Synthetic fixture: the verification check failed. Evidence is retained for an authorized recovery.',
    calls_used: 3,
    tokens_used: 2300,
    active_seconds_used: 22,
  };
  const events: SequencedEvent[] = [];
  const origin = Date.parse('2026-11-11T12:00:00Z');
  const span = (
    id: string,
    kind: SequencedEvent['event']['kind'],
    phase: string,
    name: string,
    start: number,
    end: number,
    options: Partial<SequencedEvent['event']> = {},
  ) => {
    for (const [offset, state] of [
      [start, 'started'],
      [end, options.error_code ? 'failed' : 'completed'],
    ] as const)
      events.push({
        sequence: 0,
        event: {
          version: 1,
          id: 'pending',
          work_id: order.id,
          plan_revision: 1,
          phase,
          correlation_id: id,
          parent_id: null,
          agent_id: null,
          trace_id: '1'.repeat(32),
          span_id: '2'.repeat(16),
          kind,
          state,
          name,
          timestamp: new Date(origin + offset * 1000).toISOString(),
          duration_ms: state === 'started' ? null : (end - start) * 1000,
          error_code: state === 'started' ? null : (options.error_code ?? null),
          provider: kind === 'agent' ? 'claude_cli' : null,
          model: kind === 'agent' ? 'synthetic-sonnet' : null,
          ...options,
        },
      });
  };
  span('preflight', 'stage', 'intake', 'intake', 0, 2);
  span('spec', 'stage', 'analysis', 'analyze', 2, 7);
  span('pm-agent', 'agent', 'analysis', 'analyst', 2.2, 6.8, {
    parent_id: 'spec',
    agent_id: 'synthetic-pm-invocation',
  });
  span('build-one', 'stage', 'implementation', 'implement', 7, 12, { error_code: 'SYNTHETIC_GATE_FAILED' });
  span('developer-one', 'agent', 'implementation', 'developer', 7.1, 11.8, {
    parent_id: 'build-one',
    agent_id: 'synthetic-developer-one',
  });
  span('build-two', 'stage', 'implementation', 'implement', 13, 18);
  span('developer-two', 'agent', 'implementation', 'developer', 13.1, 17.8, {
    parent_id: 'build-two',
    agent_id: 'synthetic-developer-two',
  });
  span('read-memory', 'tool', 'implementation', 'read_memory', 14, 14.4, {
    parent_id: 'developer-two',
    agent_id: 'synthetic-developer-two',
  });
  span('read-source', 'tool', 'implementation', 'read_source', 14.5, 15.2, {
    parent_id: 'developer-two',
    agent_id: 'synthetic-developer-two',
  });
  span('verification', 'stage', 'verification', 'checks', 18, 22, { error_code: 'SYNTHETIC_GATE_FAILED' });
  span('qa-agent', 'agent', 'verification', 'qa', 18.05, 21.8, {
    parent_id: 'verification',
    agent_id: 'synthetic-qa-invocation',
  });
  span('check-command', 'tool', 'verification', 'execute', 18.2, 21.5, {
    parent_id: 'qa-agent',
    agent_id: 'synthetic-qa-invocation',
    error_code: 'SYNTHETIC_GATE_FAILED',
  });
  const recorded = events
    .sort((left, right) => Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp))
    .map((item, index) => ({
      sequence: index + 1,
      event: { ...item.event, id: `synthetic-event-${index + 1}` },
    }));
  await page.route('**/api/v1/flows/patch/topology', async (route) =>
    route.fulfill({
      json: {
        version: 1,
        graph_version: 'sabre-v1',
        mode: 'patch',
        lanes: [
          { id: 'preflight', label: 'Preflight', specialist: 'System', stages: ['intake'], next: ['spec'] },
          { id: 'spec', label: 'Spec', specialist: 'PM', stages: ['analysis', 'analyze'], next: ['build'] },
          {
            id: 'build',
            label: 'Build',
            specialist: 'Developer',
            stages: ['implementation', 'implement'],
            next: ['verify'],
          },
          {
            id: 'verify',
            label: 'Verify',
            specialist: 'QA',
            stages: ['verification', 'checks'],
            next: ['review'],
          },
          {
            id: 'review',
            label: 'Review',
            specialist: 'Independent review',
            stages: ['review'],
            next: ['security'],
          },
          { id: 'security', label: 'Security', specialist: 'CISO', stages: ['security'], next: ['deliver'] },
          { id: 'deliver', label: 'Deliver', specialist: 'DevOps', stages: ['delivery'], next: ['memory'] },
          { id: 'memory', label: 'Memory', specialist: 'Verified evidence', stages: ['remember'], next: [] },
        ],
        alternatives: [
          { source: 'review', target: 'build', condition: 'Repair requires an authorized remaining budget' },
        ],
      },
    }),
  );
  const invocations: string[] = [];
  await page.route('**/api/v1/work**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/work') {
      await route.fulfill({ json: [order] });
      return;
    }
    if (path === `/api/v1/work/${order.id}`) {
      await route.fulfill({ json: order });
      return;
    }
    if (path.endsWith('/execution-events')) {
      await route.fulfill({ json: { items: recorded, next_cursor: recorded.length, has_more: false } });
      return;
    }
    if (path.endsWith('/usage')) {
      await route.fulfill({ json: runUsageSnapshot(order.id, 3, 2300) });
      return;
    }
    if (path.endsWith('/audit')) {
      await route.fulfill({
        json: {
          work_id: order.id,
          plan_revision: 1,
          status: order.status,
          phase: order.phase,
          context: null,
          usage: {
            calls: 3,
            settled_calls: 3,
            unsettled_calls: 0,
            tokens: 2300,
            measured_tokens: 2300,
            unknown_reserved_tokens: 0,
            cost_usd: 0,
          },
          agents: [],
          tools: [],
          models: [],
          checkpoint_count: 3,
          checkpoint_threads: 3,
          truncated: false,
        },
      });
      return;
    }
    if (path.endsWith('/inspection')) {
      const agentId = url.searchParams.get('agent_id') ?? 'synthetic-qa-invocation';
      invocations.push(agentId);
      await route.fulfill({
        json: {
          version: 1,
          work_id: order.id,
          plan_revision: 1,
          agent_id: agentId,
          role: agentId.includes('developer') ? 'developer' : 'qa',
          agents: [
            { id: 'synthetic-developer-two', role: 'developer', plan_revision: 1 },
            { id: 'synthetic-qa-invocation', role: 'qa', plan_revision: 1 },
          ],
          records: [
            {
              sequence: 0,
              id: 'synthetic-context-call',
              kind: 'tool_call',
              sender: 'developer',
              recipient: 'tool',
              content:
                'Synthetic retrieval: project-scoped source and reviewed memory for this implementation attempt.',
              tool: 'read_memory',
              redacted: false,
              truncated: false,
            },
            {
              sequence: 1,
              id: 'synthetic-context-result',
              kind: 'tool_result',
              sender: 'tool',
              recipient: 'developer',
              content:
                'Synthetic evidence: memory-one · commit aaaaaaaa · source run synthetic-prior-run. Context only; no instruction or permission authority.',
              tool: 'read_memory',
              redacted: false,
              truncated: false,
            },
          ],
          evaluations: [],
          logs: [],
          context: {
            source: 'synthetic-context-receipt',
            sent_bytes: 4096,
            input_limit_bytes: 98304,
            references_retained: true,
          },
          next_cursor: 2,
          has_more: false,
          truncated: false,
          checkpoint_id: 'synthetic-checkpoint-two',
          current: true,
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto(`/work/${order.id}`);
  const timeline = page.getByRole('region', { name: 'Execution timeline' });
  await expect(timeline.getByRole('button', { name: 'implement · failed', exact: true })).toBeVisible();
  await timeline.getByRole('button', { name: /Build Developer/ }).click();
  await timeline.getByRole('button', { name: 'developer · completed', exact: true }).last().click();
  const inspector = timeline.getByRole('region', { name: 'Execution inspector' });
  await inspector.getByRole('tab', { name: 'Memory', exact: true }).click();
  await expect(inspector.getByText(/Synthetic evidence: memory-one/)).toBeVisible();
  expect(invocations).toContain('synthetic-developer-two');
  await expect(timeline.getByRole('button', { name: 'implement · completed', exact: true })).toContainText(
    'attempt 2',
  );
  await expect(timeline.getByText('Planned · not started').first()).toBeVisible();
  await expect(timeline.locator('.child').filter({ hasText: 'read_memory' })).toContainText('memory');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (test.info().project.name === 'desktop') {
    await page.evaluate(() => window.scrollTo(0, 0));
    const workspace = await timeline.locator('.console-workspace').boundingBox();
    expect(workspace).not.toBeNull();
    expect(workspace!.y).toBeLessThanOrEqual(400);
    expect(
      await timeline
        .locator('.observed-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  }
  if (test.info().project.name === 'mobile')
    expect(
      await timeline
        .locator('.observed-scroll')
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
  await captureSource(page, 'process');
});

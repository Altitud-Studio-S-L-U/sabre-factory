import { test, type Page } from '@playwright/test';
import { configuration } from '../src/test/modelConfigurationFixture';
import { factoryConfiguration } from '../src/test/factoryConfigurationFixture';
import { agentCatalog } from '../src/test/agentCatalogFixture';
import { runUsageSnapshot } from '../src/test/runUsageFixture';
import { runMetrics } from '../src/test/runMetricsFixture';
import type { ProcessTopology, WorkOrder } from '../src/api';
import topologies from './topology.json' with { type: 'json' };

export async function captureSource(page: Page, section: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: `../work/source-${section}-${test.info().project.name}.png`,
    fullPage: true,
    scale: 'css',
  });
}

/** The GitHub connection in each of its states, with a synthetic app and account. */
export function githubConnection(state: 'not_connected' | 'registered' | 'connected') {
  const app = {
    slug: 'sabre-factory-a1b2c3',
    name: 'SABRE Factory a1b2c3',
    url: 'https://github.com/apps/sabre-factory-a1b2c3',
    owner: 'octo-fixture',
  };
  return {
    version: 1,
    state,
    app: state === 'not_connected' ? null : app,
    account:
      state === 'connected'
        ? { login: 'octo-fixture', type: 'Organization', repository_selection: 'selected' }
        : null,
    install_url: state === 'not_connected' ? null : `${app.url}/installations/new`,
    manage_url:
      state === 'connected'
        ? 'https://github.com/organizations/octo-fixture/settings/installations/7001'
        : null,
  };
}

export function githubReachable() {
  return {
    page: 1,
    next_page: null,
    total: 2,
    items: [
      {
        id: 502,
        full_name: 'octo-fixture/gadgets',
        url: 'https://github.com/octo-fixture/gadgets',
        default_branch: 'trunk',
        visibility: 'public',
      },
      {
        id: 501,
        full_name: 'octo-fixture/widgets',
        url: 'https://github.com/octo-fixture/widgets',
        default_branch: 'main',
        visibility: 'private',
      },
    ],
  };
}

export function syntheticRun(): WorkOrder {
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
    budget_denial: null,
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

// These browser journeys use explicitly synthetic API responses. PostgreSQL and
// execution recovery are verified separately by backend integration tests.
export async function mockFactoryApi(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (path.includes('/panel/session'))
      json = {
        authenticated: true,
        csrf_token: 'synthetic-browser-csrf',
        expires_at: '2099-01-01T00:00:00Z',
      };
    if (path.endsWith('/projects')) {
      const active = {
        id: 'synthetic-project',
        name: 'Example project',
        repository: 'https://github.com/example/demo',
        profile: 'node',
        default_branch: 'main',
        gate_commands: [['npm', 'test']],
        allowed_mcp_servers: [],
        approved_baseline: [],
        browser_preview: null,
        revision: 0,
        archived_at: null,
        created_at: '2026-01-01T00:00:00Z',
      };
      const archived = {
        ...active,
        id: 'synthetic-archived-project',
        name: 'Retired reference',
        repository: 'https://github.com/example/reference',
        revision: 3,
        archived_at: '2026-11-13T09:00:00Z',
      };
      json =
        new URL(route.request().url()).searchParams.get('include') === 'archived'
          ? [active, archived]
          : [active];
    }
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
    if (path.endsWith('/github/connection')) json = githubConnection('not_connected');
    if (path.endsWith('/github/connection/repositories')) json = githubReachable();
    if (path.endsWith('/metrics/runs'))
      json = runMetrics({
        window_days: Number(new URL(route.request().url()).searchParams.get('days') ?? 30),
      });
    if (path.endsWith('/confirmations')) json = { version: 1, pending: 0, items: [] };
    if (path.endsWith('/a2a-tasks')) json = [];
    if (path.endsWith('/agents/activity'))
      json = {
        days: 7,
        since: '2026-11-05T00:00:00Z',
        roles: [],
        repair_cycles: 0,
        waiting_for_input: 0,
        active_runs: [],
        active_runs_truncated: false,
      };
    if (path.endsWith('/memory/graph'))
      json = { focus: null, depth: 2, nodes: [], edges: [], truncated: false };
    if (path.endsWith('/memory/review')) json = { commit: null, pending: [], stale: [], truncated: false };
    if (path.endsWith('/memory/recalls')) json = { items: [], next_cursor: null };
    if (path.endsWith('/memory/items')) json = { commit: null, items: [], next_cursor: null };
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
          title: 'GitHub · read repositories',
          description: 'Synthetic repository adapter',
          enabled: true,
          revision: 0,
          toggleable: true,
          credential_ids: ['github.read'],
          credential_configured: false,
          access: 'Public repository access; private access requires a scoped credential.',
          tools: [{ name: 'list_repositories', effect: 'read', roles: [] }],
        },
        {
          id: 'github.publish',
          kind: 'github',
          title: 'GitHub · draft pull requests',
          description: 'Synthetic delivery adapter',
          enabled: true,
          revision: 0,
          toggleable: true,
          credential_ids: ['github.publish'],
          credential_configured: true,
          access: 'Credential saved; permissions have not been checked.',
          tools: [{ name: 'publish_draft_pr', effect: 'external_write', roles: [] }],
        },
        {
          id: 'mcp.docs',
          kind: 'mcp',
          title: 'MCP · docs',
          description: 'Authorized external tools for projects that select this server.',
          enabled: false,
          revision: 2,
          toggleable: true,
          credential_ids: ['mcp.docs'],
          credential_configured: false,
          access: 'No credential; the server must allow anonymous access.',
          tools: [{ name: 'search_docs', effect: 'read', roles: ['analyst', 'developer'] }],
        },
        {
          id: 'slack',
          kind: 'slack',
          title: 'Slack',
          description: 'Owner channel; bot binding is configured on the instance.',
          enabled: true,
          revision: 0,
          toggleable: false,
          credential_ids: ['slack.bot', 'slack.app'],
          credential_configured: false,
          access: 'Configuration or credentials are pending.',
          tools: [],
        },
      ];
    if (path.endsWith('/mcp-connections'))
      json = [
        {
          name: 'docs',
          endpoint: 'https://tools.example.com/mcp',
          revision: 2,
          credential_id: 'mcp.docs',
          tools: { search_docs: { roles: ['analyst', 'developer'], effect: 'read', timeout_s: 60 } },
          tool_digests: { search_docs: 'a'.repeat(64) },
          source: 'dynamic',
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
        // Stations come from the backend's own process_topology (regenerate topology.json when it changes).
        stations:
          (topologies as Record<string, ProcessTopology>)[path.split('/').at(-2) ?? 'patch']?.stations ?? [],
        loops:
          (topologies as Record<string, ProcessTopology>)[path.split('/').at(-2) ?? 'patch']?.loops ?? [],
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
}

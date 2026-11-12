import { test, type Page } from '@playwright/test';
import { configuration } from '../src/test/modelConfigurationFixture';
import { factoryConfiguration } from '../src/test/factoryConfigurationFixture';
import { agentCatalog } from '../src/test/agentCatalogFixture';
import { runUsageSnapshot } from '../src/test/runUsageFixture';
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

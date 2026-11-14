import { configuration } from './modelConfigurationFixture';
import { factoryConfiguration } from './factoryConfigurationFixture';
import { agentCatalog } from './agentCatalogFixture';
import { runUsageSnapshot } from './runUsageFixture';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { createApi, type Project, type WorkOrder } from '../api';

const project = {
  id: 'project-one',
  name: 'Importkit',
  repository: 'https://github.com/example/importkit',
  profile: 'node',
  default_branch: 'main',
  gate_commands: [['npm', 'test']],
  allowed_mcp_servers: [],
  approved_baseline: [],
  browser_preview: null,
  created_at: '2026-11-05T10:00:00Z',
} satisfies Project;
const order = {
  id: 'work-one',
  project_id: project.id,
  mode: 'patch',
  objective: 'Fix import validation',
  acceptance: ['Rejects invalid input'],
  constraints: ['Keep the API unchanged'],
  budget: { max_calls: 40, max_tokens: 100000, max_cost_usd: 5, active_seconds: 3600, policy: null },
  idempotency_key: 'synthetic-request-000000',
  channel: 'web',
  channel_thread: null,
  status: 'waiting_input',
  phase: 'analysis',
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
  graph_version: 'sabre-v1',
  plan_revision: 2,
  created_at: '2026-11-05T10:00:00Z',
  updated_at: '2026-11-05T10:02:00Z',
  tasks: [
    {
      id: 'task-one',
      title: 'Reproduce the defect',
      role: 'developer',
      specialty: 'general',
      scope: [],
      acceptance: [],
      verification_commands: [],
      depends_on: [],
      status: 'queued',
      attempts: 0,
      result: null,
    },
  ],
  questions: [
    {
      id: 'question-one',
      work_id: 'work-one',
      plan_revision: 2,
      prompt: 'Should the previous format be kept?',
      kind: 'clarification',
      options: ['Yes, keep it', 'No, replace it'],
      subject_digest: null,
      answer: null,
      answered_at: null,
    },
  ],
  findings: [],
  security_snapshot_digest: null,
  security_rules_version: null,
  evidence: null,
  summary: 'Waiting for your decision',
  error_code: null,
  calls_used: 1,
  tokens_used: 250,
  cost_usd: 0.01,
  active_seconds_used: 4,
  control: null,
} satisfies WorkOrder;
const cliStatus = {
  model: { provider: 'codex_cli' },
  roles: Object.fromEntries(
    ['supervisor', 'analyst', 'architect', 'developer', 'qa', 'reviewer', 'security'].map((role) => [
      role,
      { provider: role === 'reviewer' ? 'claude_cli' : 'codex_cli' },
    ]),
  ),
};

type JsonRecord = Record<string, unknown>;
let projects: JsonRecord[];
let orders: JsonRecord[];
let memory: JsonRecord[];
let exceptions: JsonRecord[];
let writes: { path: string; body: JsonRecord | undefined }[];

function mockApi(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const mock = vi.fn(async (input: string, options: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const path = url.pathname.replace('/api/v1', '');
    const method = options.method || 'GET';
    const override = overrides[`${method} ${path}`];
    if (override) return Response.json(override.body, { status: override.status });
    if (path === '/panel/session' || path === '/panel/session/exchange')
      return Response.json({
        authenticated: true,
        csrf_token: 'synthetic-csrf',
        expires_at: '2026-11-07T12:00:00Z',
      });
    const body = options.body ? (JSON.parse(String(options.body)) as JsonRecord) : undefined;
    if (method === 'POST') writes.push({ path, body });
    if (path === '/panel/session/logout') return new Response(null, { status: 204 });
    if (path === '/model-configuration') return Response.json(configuration());
    if (path === '/configuration') return Response.json(factoryConfiguration());
    if (path === '/agents') return Response.json(agentCatalog());
    if (path === '/releases') return Response.json({ version: 1, items: [], truncated: false });
    if (path.endsWith('/a2a-tasks')) return Response.json([]);
    if (path.endsWith('/usage')) {
      const id = path.split('/').at(-2)!;
      const selected = orders.find((item) => item.id === id);
      return Response.json(
        runUsageSnapshot(
          id,
          typeof selected?.calls_used === 'number' ? selected.calls_used : 0,
          typeof selected?.tokens_used === 'number' ? selected.tokens_used : 0,
        ),
      );
    }
    if (path === '/tools/catalog')
      return Response.json({
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
      });
    if (path === '/mcp-connections' || path === '/a2a/agents' || path === '/delegations')
      return Response.json([]);
    if (path.endsWith('/ingestion'))
      return Response.json({ version: 1, project_id: project.id, jobs: [], latest: null });
    if (path.startsWith('/flows/') && path.endsWith('/topology'))
      return Response.json({
        version: 1,
        graph_version: 'sabre-v1',
        mode: 'patch',
        lanes: [
          { id: 'preflight', label: 'Preflight', specialist: 'System', stages: ['intake'], next: ['spec'] },
          { id: 'spec', label: 'Spec', specialist: 'PM', stages: ['analysis', 'analyze'], next: ['plan'] },
          {
            id: 'plan',
            label: 'Plan',
            specialist: 'Supervisor',
            stages: ['planning', 'plan'],
            next: ['build'],
          },
          {
            id: 'build',
            label: 'Build',
            specialist: 'Developer',
            stages: ['implementation', 'implement', 'repair'],
            next: ['verify'],
          },
          {
            id: 'verify',
            label: 'Verify',
            specialist: 'QA',
            stages: ['checks', 'verification'],
            next: ['review'],
          },
          { id: 'review', label: 'Review', specialist: 'Supervisor', stages: ['review'], next: ['security'] },
          {
            id: 'security',
            label: 'Security',
            specialist: 'CISO',
            stages: ['security_check', 'security'],
            next: ['deliver'],
          },
          {
            id: 'deliver',
            label: 'Deliver',
            specialist: 'DevOps',
            stages: ['delivery', 'deliver'],
            next: [],
          },
        ],
        alternatives: [
          { source: 'review', target: 'build', condition: 'Repair authorized within run limits' },
        ],
      });
    if (path.endsWith('/inspection'))
      return Response.json({
        version: 1,
        work_id: 'work-one',
        plan_revision: 2,
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
      });
    if (path.endsWith('/execution-events'))
      return Response.json({ items: [], next_cursor: 0, has_more: false });
    if (path === '/status')
      return Response.json({ database: true, executor: false, graph_version: 'sabre-v1' });
    if (path === '/integrations')
      return Response.json([
        {
          id: 'github.read',
          kind: 'github',
          title: 'GitHub · repositories',
          description: 'Browses repositories.',
          enabled: true,
          revision: 0,
          toggleable: true,
          credential_ids: ['github.read'],
          credential_configured: false,
          access: 'Public access',
          tools: [],
        },
      ]);
    if (path === '/system')
      return Response.json({
        checked_at: '2026-11-07T12:00:00Z',
        application: { name: 'SABRE', version: 'test', graph_version: 'synthetic-graph-version' },
        runtime: { python: 'test', implementation: 'CPython', system: 'Linux', architecture: 'x86_64' },
        packages: [],
        limits: { concurrent_work: 2, writers_per_repository: 1, repair_cycles: 2, codex_invocations: 1 },
        models: [
          { role: 'developer', provider: 'codex_cli', name: 'explicit-cli-model', configured: true },
          { role: 'analyst', provider: 'codex_cli', name: '', configured: false },
        ],
        components: [
          {
            id: 'codex',
            label: 'Codex CLI',
            configured: false,
            state: 'available',
            detail: 'The runner responds; the session is not connected.',
          },
        ],
      });
    if (path.endsWith('/audit'))
      return Response.json({
        work_id: 'work-one',
        plan_revision: 1,
        status: 'waiting_input',
        phase: 'analysis',
        context: null,
        usage: {
          calls: 0,
          settled_calls: 0,
          unsettled_calls: 0,
          tokens: 0,
          measured_tokens: 0,
          unknown_reserved_tokens: 0,
          cost_usd: 0,
        },
        agents: [],
        tools: [],
        checkpoint_count: 0,
        checkpoint_threads: 0,
        truncated: false,
      });
    if (path.endsWith('/knowledge'))
      return Response.json({
        project_id: project.id,
        profile: 'node',
        gate_count: 1,
        context: null,
        semantic_search: false,
        truncated: false,
        memories: { total: 0, active: 0, pending: 0, invalidated: 0 },
        checkpoints: { count: 0, threads: 0 },
      });
    if (path === '/projects') {
      if (method === 'POST') {
        const next = { ...body, id: 'new-project', created_at: '2026-11-05T10:00:00Z' };
        projects.push(next);
        return Response.json(next);
      }
      return Response.json(projects);
    }
    if (path === '/work') {
      if (method === 'POST') {
        const next = { ...order, ...body, id: 'new-work', status: 'queued', questions: [], tasks: [] };
        orders.push(next);
        return Response.json(next);
      }
      return Response.json(orders);
    }
    if (path.endsWith('/events'))
      return Response.json([
        { id: 1, kind: 'order.created', message: 'Run received', created_at: '2026-11-05T10:00:00Z' },
      ]);
    if (path.endsWith('/answer')) {
      orders = orders.map((item) => ({
        ...item,
        questions: [{ ...order.questions[0], answer: body?.answer }],
        status: 'running',
      }));
      return Response.json(orders[0]);
    }
    if (path.endsWith('/cancel')) {
      orders = orders.map((item) => ({ ...item, status: 'cancelled' }));
      return Response.json(orders[0]);
    }
    if (path.endsWith('/scope')) {
      orders = orders.map((item) => ({
        ...item,
        objective: body?.objective,
        acceptance: body?.acceptance,
        plan_revision: 3,
      }));
      return Response.json(orders[0]);
    }
    if (path.endsWith('/cli-progress-limits')) {
      orders = orders.map((item) => ({
        ...item,
        budget: { max_calls: null, max_tokens: null, active_seconds: null, max_cost_usd: 0 },
      }));
      return Response.json(orders[0]);
    }
    if (path.endsWith('/security-exceptions')) {
      if (method === 'POST') {
        const next = {
          ...body,
          id: 'exception-one',
          work_id: 'work-one',
          project_id: project.id,
          approved_by: 'owner',
          approved_at: '2026-11-05T11:00:00Z',
          revoked_at: null,
        };
        exceptions.push(next);
        return Response.json(next, { status: 201 });
      }
      return Response.json(exceptions);
    }
    if (path.endsWith('/security-exceptions/exception-one/revoke')) {
      exceptions = exceptions.map((item) => ({ ...item, revoked_at: '2026-11-05T11:05:00Z' }));
      return Response.json(exceptions[0]);
    }
    if (path === '/memory') return Response.json(memory);
    if (path.endsWith('/approve')) {
      memory = memory.map((item) => ({ ...item, active: true }));
      return Response.json(memory[0]);
    }
    if (path.endsWith('/invalidate')) {
      memory = memory.map((item) => ({ ...item, active: false, invalidated_at: '2026-11-05T11:00:00Z' }));
      return Response.json(memory[0]);
    }
    if (path === '/security') return Response.json([]);
    if (path === '/secrets' || path === '/secret-targets') return Response.json([]);
    return Response.json({ message: 'Route not prepared in this test' }, { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function enter() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: 'Runs' });
  return user;
}

function runList() {
  return screen.getByRole('region', { name: 'All runs' });
}
async function selectRun(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(runList()).getByRole('link', { name: new RegExp(order.objective) }));
}
async function backToRuns(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Runs' }),
  );
  await screen.findByRole('region', { name: 'All runs' });
}
async function legacyRoute(path: string) {
  await act(async () => {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

beforeEach(() => {
  projects = [structuredClone(project)];
  orders = [structuredClone(order)];
  memory = [];
  exceptions = [];
  writes = [];
  window.history.replaceState(null, '', '/');
});

/** Open one step of the New run wizard from its step list. */
async function wizardStep(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(
    screen.getByRole('button', {
      name: (accessible) => /^Step \d+:/.test(accessible) && accessible.replace(/^Step \d+:\s*/, '') === name,
    }),
  );
}

describe('Control room', () => {
  it('keeps the selected snapshot and draft answer while disconnected and blocks every run mutation until recovery', async () => {
    const snapshot = 'a'.repeat(64);
    orders = [
      {
        ...order,
        status: 'paused',
        budget: { ...order.budget, max_cost_usd: 0 },
        security_snapshot_digest: snapshot,
        security_rules_version: 'rules-v3',
        findings: [
          {
            fingerprint: 'reviewed-risk',
            scanner: 'trivy',
            category: 'vulnerability',
            severity: 'high',
            title: 'Synthetic scoped risk',
            path: null,
            reference: null,
            baseline: false,
            line: null,
            remediation: null,
            exception_id: null,
          },
        ],
      },
    ];
    exceptions = [
      {
        id: 'exception-one',
        work_id: order.id,
        project_id: project.id,
        fingerprint: 'reviewed-risk',
        justification: 'Synthetic owner-reviewed mitigation',
        snapshot_digest: snapshot,
        rules_version: 'rules-v3',
        plan_revision: 2,
        approved_by: 'owner',
        approved_at: '2026-11-05T11:00:00Z',
        expires_at: '2026-11-20T12:00:00Z',
        revoked_at: null,
      },
    ];
    const overrides: Record<string, { status: number; body: unknown }> = {
      'GET /status': { status: 200, body: cliStatus },
    };
    mockApi(overrides);
    const user = await enter();
    await selectRun(user);
    await user.type(screen.getByLabelText('Your answer'), 'Retained synthetic answer');
    overrides['GET /status'] = { status: 503, body: { message: 'Synthetic connection interrupted' } };
    await user.click(screen.getByRole('button', { name: 'Refresh data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Data could not be refreshed');
    expect(screen.getByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeDisabled();
    const answer = screen.getByLabelText('Your answer');
    expect(answer).toHaveValue('Retained synthetic answer');
    expect(answer).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Answer and continue' })).toBeDisabled();
    fireEvent.submit(answer.closest('form')!);
    await user.click(screen.getByRole('tab', { name: 'Limits & scope' }));
    await user.click(screen.getByText('Change request'));
    expect(screen.getByRole('button', { name: 'Update scope' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use per-agent controls' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('New objective').closest('form')!);
    await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
    expect(await screen.findByRole('button', { name: 'Revoke exception' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Temporary security exception' })).toBeDisabled();
    expect(writes).toEqual([]);
    overrides['GET /status'] = { status: 200, body: cliStatus };
    await user.click(screen.getByRole('button', { name: 'Refresh data' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled());
    expect(answer).toHaveValue('Retained synthetic answer');
    expect(answer).toBeEnabled();
    expect(writes).toEqual([]);
  });
  it('preserves an unknown address without inventing a run and returns through the real Runs route', async () => {
    window.history.replaceState(null, '', '/unknown-section');
    mockApi();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(window.location.pathname).toBe('/unknown-section');
    expect(screen.queryByRole('region', { name: 'All runs' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Go to runs' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    expect(window.location.pathname).toBe('/runs');
    expect(writes).toEqual([]);
  });
  it('exposes real routes and keeps the view and run across Back, Forward and reload', async () => {
    mockApi();
    const user = userEvent.setup();
    const mounted = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Runs' });
    expect(window.location.pathname).toBe('/runs');
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    for (const [name, path] of [
      ['Agents', '/agents'],
      ['Tools', '/tools'],
      ['Memory', '/memory'],
      ['Config', '/config'],
    ])
      expect(within(navigation).getByRole('link', { name })).toHaveAttribute('href', path);
    await user.click(within(navigation).getByRole('link', { name: 'Config' }));
    await user.click(within(navigation).getByRole('link', { name: 'Tools' }));
    expect(window.location.pathname).toBe('/tools');
    await user.click(within(navigation).getByRole('link', { name: /^Runs/ }));
    await user.click(
      within(runList()).getByRole('link', {
        name: new RegExp(order.objective),
      }),
    );
    expect(window.location.pathname).toBe('/runs/work-one');
    await act(async () => window.history.back());
    await screen.findByRole('heading', { level: 1, name: 'Runs' });
    expect(window.location.pathname).toBe('/runs');
    await act(async () => window.history.back());
    await screen.findByRole('heading', { level: 1, name: 'Tools' });
    await act(async () => window.history.forward());
    await screen.findByRole('heading', { level: 1, name: 'Runs' });
    await act(async () => window.history.forward());
    await screen.findByRole('heading', { level: 1, name: 'Patch Importkit' });
    mounted.unmount();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(window.location.pathname).toBe('/runs/work-one');
    expect(writes).toEqual([]);
  });

  it('opens a deep link to a run outside the list and removes the ticket before any request', async () => {
    orders = [];
    window.history.replaceState(null, '', '/runs/work-one#ticket=synthetic-deep-link');
    const fetchMock = mockApi({ 'GET /work/work-one': { status: 200, body: order } });
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      expect(window.location.hash).toBe('');
      expect(JSON.stringify(window.history.state)).not.toContain('synthetic-deep-link');
      return original(input, options);
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(window.location.pathname).toBe('/runs/work-one');
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/session/exchange'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/work/work-one')).toBe(true);
    expect(document.body).not.toHaveTextContent('synthetic-deep-link');
    expect(writes).toEqual([]);
  });

  it('shows the error for a link to a missing run without replacing it with the list', async () => {
    window.history.replaceState(null, '', '/runs/missing');
    mockApi({ 'GET /work/missing': { status: 404, body: { message: 'Not found' } } });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Run unavailable' })).toBeVisible();
    expect(screen.getByText('This run does not exist or is no longer available.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'All runs' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/runs/missing');
    await user.click(screen.getByRole('link', { name: '← All runs' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    expect(writes).toEqual([]);
  });

  it('opens an earlier /work address at the same run under /runs', async () => {
    window.history.replaceState(null, '', '/work/work-one?tab=process#evidence');
    mockApi();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(window.location.pathname).toBe('/runs/work-one');
    expect(window.location.search).toBe('?tab=process');
    expect(window.location.hash).toBe('#evidence');
    expect(writes).toEqual([]);
  });

  it('disables creating and pausing runs from the runs table while disconnected', async () => {
    orders = [{ ...order, status: 'running', questions: [] }];
    const overrides: Record<string, { status: number; body: unknown }> = {};
    mockApi(overrides);
    const user = await enter();
    expect(screen.getByRole('button', { name: '+ New run' })).toBeEnabled();
    overrides['GET /status'] = { status: 503, body: { message: 'Synthetic connection interrupted' } };
    await user.click(screen.getByRole('button', { name: 'Refresh data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Data could not be refreshed');
    expect(screen.getByRole('button', { name: '+ New run' })).toBeDisabled();
    expect(within(runList()).getByRole('button', { name: /^Pause run/ })).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it('keeps failed runs in Open and lets them be reviewed outside Closed', async () => {
    orders = [
      {
        ...order,
        status: 'failed',
        questions: [],
        error_code: 'TOOL_FAILED',
        summary: 'The check could not be completed.',
      },
      {
        ...order,
        id: 'completed-work',
        objective: 'Completed test run',
        status: 'completed',
        questions: [],
      },
    ];
    mockApi();
    const user = await enter();
    let history = runList();
    await user.click(within(history).getByRole('button', { name: 'Needs you' }));
    await user.click(within(history).getByRole('link', { name: new RegExp(order.objective) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    await backToRuns(user);
    history = runList();
    await user.click(within(history).getByRole('button', { name: 'Closed' }));
    expect(
      within(history).queryByRole('link', { name: new RegExp(order.objective) }),
    ).not.toBeInTheDocument();
    expect(within(history).getByRole('link', { name: /Completed test run/ })).toBeVisible();
    expect(writes).toEqual([]);
  });

  it('moves keyboard focus to the view and run heading without stealing focus on refresh', async () => {
    const fetchMock = mockApi();
    const user = await enter();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toHaveFocus());
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    within(navigation).getByRole('link', { name: 'Config' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('heading', { level: 1, name: 'Config' });
    within(navigation).getByRole('link', { name: 'Tools' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Tools' })).toHaveFocus());
    within(navigation).getByRole('link', { name: /^Runs/ }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toHaveFocus());
    const history = runList();
    within(history)
      .getByRole('link', { name: new RegExp(order.objective) })
      .focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Patch Importkit' })).toHaveFocus(),
    );
    const refresh = screen.getByRole('button', { name: 'Refresh data' });
    const workReads = () => fetchMock.mock.calls.filter(([path]) => path === '/api/v1/work').length;
    const before = workReads();
    refresh.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(workReads()).toBeGreaterThan(before));
    await waitFor(() => expect(refresh).toHaveFocus());
    expect(writes).toEqual([]);
  });

  it('manages integration credentials without starting runs', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('link', { name: 'Tools' }));
    await user.click(await screen.findByRole('button', { name: 'Details of GitHub · repositories' }));
    const details = screen.getByRole('group', { name: 'GitHub · repositories details' });
    expect(within(details).getByRole('region', { name: 'Stored credential' })).toBeVisible();
    expect(await within(details).findByText('No saved credentials yet.')).toBeVisible();
    expect(writes).toEqual([]);
  });
  it('shows About without attributing authentication to runner availability', async () => {
    mockApi();
    await enter();
    await legacyRoute('/projects');
    expect(screen.getByText('1 configured check')).toBeVisible();
    await legacyRoute('/about');
    expect(await screen.findByRole('heading', { name: 'Services and connections' })).toBeVisible();
    const cli = within(screen.getByRole('heading', { name: 'Codex CLI' }).closest('li')!);
    expect(cli.getByText('Responding')).toBeVisible();
    expect(cli.getByText('Not configured')).toBeVisible();
    expect(screen.getByText(/explicit-cli-model/)).toBeVisible();
    expect(screen.getByText(/Automatic \(CLI\)/)).toBeVisible();
    expect(screen.getByText(/synthetic-graph-version/)).toBeVisible();
    expect(writes).toEqual([]);
  });
  it('restores the browser session without a bearer or credentials in storage and revokes it on sign-out', async () => {
    const fetchMock = mockApi();
    const user = await enter();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/panel/session');
    expect(
      fetchMock.mock.calls.every(([, options]) => !new Headers(options?.headers).has('Authorization')),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.every(([, options]) => new Headers(options?.headers).get('X-Sabre-UI') === '1'),
    ).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Pair this browser' });
    const logout = fetchMock.mock.calls.find(([path]) => path.endsWith('/panel/session/logout'));
    expect(logout?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(new Headers(logout?.[1]?.headers).get('X-CSRF-Token')).toBe('synthetic-csrf');
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
  });

  it('explains how to open the panel when there is no session without asking for a manual token', async () => {
    const fetchMock = mockApi({ 'GET /panel/session': { status: 401, body: { message: 'Unauthorized' } } });
    render(<App />);
    await screen.findByRole('heading', { name: 'Pair this browser' });
    expect(screen.getByText('node bin/sabre.mjs open')).toBeVisible();
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it('enters the console when the tab regains focus after the browser was paired elsewhere', async () => {
    let paired = false;
    const fetchMock = mockApi();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      if (!paired && String(input) === '/api/v1/panel/session')
        return new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 });
      return original(input, options);
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Pair this browser' });
    paired = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeVisible();
    const probes = fetchMock.mock.calls.filter(([path]) => path === '/api/v1/panel/session');
    expect(probes).toHaveLength(2);
    expect(writes).toEqual([]);
  });

  it('removes the ticket from history before sending it and exchanges it only once in StrictMode', async () => {
    window.history.replaceState(null, '', '/?view=work#ticket=synthetic-one-use-ticket');
    const fetchMock = mockApi();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, options) => {
      expect(window.location.hash).toBe('');
      expect(JSON.stringify(window.history.state)).not.toContain('synthetic-one-use-ticket');
      return original(input, options);
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByRole('heading', { name: 'Runs' });
    const exchanges = fetchMock.mock.calls.filter(([path]) => path.endsWith('/panel/session/exchange'));
    expect(exchanges).toHaveLength(1);
    expect(JSON.parse(String(exchanges[0][1]?.body))).toEqual({ ticket: 'synthetic-one-use-ticket' });
    expect(exchanges[0][1]).toMatchObject({
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(window.location.search).toBe('?view=work');
    expect(window.location.hash).toBe('');
    expect(document.body).not.toHaveTextContent('synthetic-one-use-ticket');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it.each(['rejected', 'network'])('also clears the ticket when the exchange fails: %s', async (failure) => {
    const ticket = 'synthetic-failed-ticket';
    window.history.replaceState(null, '', `/#ticket=${ticket}`);
    const fetchMock = mockApi({ 'POST /panel/session/exchange': { status: 401, body: { message: ticket } } });
    if (failure === 'network') fetchMock.mockRejectedValue(new Error(ticket));
    render(<App />);
    await screen.findByRole('alert');
    expect(window.location.hash).toBe('');
    expect(document.body).not.toHaveTextContent(ticket);
    expect(screen.queryByRole('heading', { name: 'Runs' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('restores the cookie after reopening the panel without reusing the ticket', async () => {
    window.history.replaceState(null, '', '/#ticket=synthetic-reload-ticket');
    const fetchMock = mockApi();
    const first = render(<App />);
    await screen.findByRole('heading', { name: 'Runs' });
    first.unmount();
    render(<App />);
    await screen.findByRole('heading', { name: 'Runs' });
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/panel/session/exchange'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/panel/session')).toHaveLength(1);
  });

  it('exchanges a new link in the already open tab without reloading and clears the fragment before the fetch', async () => {
    const fetchMock = mockApi({ 'GET /panel/session': { status: 401, body: {} } });
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (path, options) => {
      if (path.endsWith('/panel/session/exchange')) expect(window.location.hash).toBe('');
      return implementation(path, options);
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByRole('heading', { name: 'Pair this browser' });
    window.history.pushState(null, '', '/?view=work#ticket=synthetic-same-tab-ticket');
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('');
    await screen.findByRole('heading', { name: 'Runs' });
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/panel/session/exchange'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/panel/session')).toHaveLength(1);
    expect(document.body).not.toHaveTextContent('synthetic-same-tab-ticket');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(writes).toEqual([]);
  });

  it('clears a rejected new link and accepts another link without repeating the previous one', async () => {
    const overrides: Record<string, { status: number; body: unknown }> = {
      'POST /panel/session/exchange': { status: 401, body: { message: 'synthetic-expired-link' } },
    };
    const fetchMock = mockApi(overrides);
    await enter();
    window.history.pushState(null, '', '/#ticket=synthetic-expired-link');
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('');
    await screen.findByRole('heading', { name: 'Pair this browser' });
    expect(await screen.findByRole('alert')).toHaveTextContent('expired or was already used');
    expect(document.body).not.toHaveTextContent('synthetic-expired-link');
    overrides['POST /panel/session/exchange'] = {
      status: 200,
      body: { authenticated: true, csrf_token: 'synthetic-next-csrf', expires_at: '2026-11-07T12:00:00Z' },
    };
    window.history.pushState(null, '', '/#ticket=synthetic-valid-link');
    fireEvent(window, new HashChangeEvent('hashchange'));
    await screen.findByRole('heading', { name: 'Runs' });
    const exchanges = fetchMock.mock.calls.filter(([path]) => path.endsWith('/panel/session/exchange'));
    expect(exchanges.map(([, options]) => JSON.parse(String(options?.body)).ticket)).toEqual([
      'synthetic-expired-link',
      'synthetic-valid-link',
    ]);
    expect(writes).toEqual([]);
  });

  it('ignores a stale session restore that finishes after the new link is exchanged', async () => {
    const fetchMock = mockApi();
    let finishRestore!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = resolve;
        }),
    );
    render(<App />);
    window.history.pushState(null, '', '/#ticket=synthetic-newer-ticket');
    fireEvent(window, new HashChangeEvent('hashchange'));
    await screen.findByRole('heading', { name: 'Runs' });
    await act(async () => finishRestore(Response.json({}, { status: 401 })));
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeVisible();
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/panel/session/exchange'))).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it('does not let a request from the previous session disconnect the new one', async () => {
    const fetchMock = mockApi();
    const user = await enter();
    const implementation = fetchMock.getMockImplementation()!;
    let finishOldQuery!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldQuery = resolve;
        }),
    );
    await user.click(screen.getByRole('button', { name: 'Refresh data' }));
    fetchMock.mockImplementation(implementation);
    window.history.pushState(null, '', '/#ticket=synthetic-replaced-session');
    fireEvent(window, new HashChangeEvent('hashchange'));
    await screen.findByRole('heading', { name: 'Runs' });
    await act(async () => finishOldQuery(Response.json({}, { status: 401 })));
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeVisible();
    expect(screen.queryByText('The session expired.')).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('withdraws the data when the session expires during a request', async () => {
    const overrides: Record<string, { status: number; body: unknown }> = {};
    mockApi(overrides);
    const user = await enter();
    overrides['GET /status'] = { status: 401, body: { message: 'Unauthorized' } };
    await user.click(screen.getByRole('button', { name: 'Refresh data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The session expired');
    expect(screen.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Runs' })).not.toBeInTheDocument();
  });

  it('does not open the factory when the response does not prove a valid session', async () => {
    mockApi({ 'GET /panel/session': { status: 200, body: { authenticated: false } } });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The SABRE session could not be verified');
    expect(screen.queryByRole('heading', { name: 'Runs' })).not.toBeInTheDocument();
  });

  it('does not announce a signed-out session when the server could not revoke it', async () => {
    mockApi({ 'POST /panel/session/logout': { status: 503, body: { message: 'Revocation unavailable' } } });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out could not be confirmed');
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeVisible();
  });

  it('asks to reload when another tab renews the session without repeating the rejected operation', async () => {
    const overrides: Record<string, { status: number; body: unknown }> = {
      'POST /panel/session/logout': { status: 403, body: { code: 'PANEL_CSRF_DENIED' } },
    };
    const fetchMock = mockApi(overrides);
    const user = userEvent.setup();
    const first = render(<App />);
    await screen.findByRole('heading', { name: 'Runs' });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The browser session changed');
    expect(screen.getByRole('heading', { name: 'Pair this browser' })).toBeVisible();
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/panel/session/logout'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/v1/panel/session')).toHaveLength(1);
    first.unmount();
    delete overrides['POST /panel/session/logout'];
    overrides['GET /panel/session'] = {
      status: 200,
      body: { authenticated: true, csrf_token: 'synthetic-renewed-csrf', expires_at: '2026-11-07T12:00:00Z' },
    };
    render(<App />);
    await screen.findByRole('heading', { name: 'Runs' });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Pair this browser' });
    const logouts = fetchMock.mock.calls.filter(([path]) => path.endsWith('/panel/session/logout'));
    expect(logouts).toHaveLength(2);
    expect(new Headers(logouts[1][1]?.headers).get('X-CSRF-Token')).toBe('synthetic-renewed-csrf');
  });

  it('does not present zero runs as real data when the factory cannot be loaded', async () => {
    mockApi({ 'GET /work': { status: 503, body: { message: 'Database unavailable' } } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'The factory could not be loaded' })).toBeVisible();
    expect(screen.queryByText('Your first run starts here')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Database unavailable');
  });

  it('lets the owner browse an empty factory and asks for a project before a run can be created', async () => {
    projects = [];
    orders = [];
    mockApi();
    const user = await enter();
    expect(screen.getByRole('heading', { name: 'Launch a verified process' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    expect(screen.getByRole('heading', { name: 'Register a project to get started' })).toBeVisible();
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    await user.click(screen.getByRole('button', { name: 'Close Register project' }));
    expect(screen.getByRole('heading', { name: 'Your first project starts here' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Memory' }));
    expect(await screen.findByRole('heading', { name: 'No project knowledge yet' })).toBeVisible();
    await legacyRoute('/security');
    expect(await screen.findByRole('heading', { name: 'No recorded findings' })).toBeVisible();
    expect(writes).toEqual([]);
  });

  it('counts only a completed run with a PR as a delivery, excluding monitoring reports', async () => {
    const evidence: NonNullable<WorkOrder['evidence']> = {
      commit: 'a'.repeat(40),
      snapshot_digest: 'b'.repeat(64),
      profile_digest: 'c'.repeat(64),
      rules_version: 'rules-v3',
      gates: [],
      findings: [],
      review: 'Reviewed delivery fixture',
      security_policy_digest: 'd'.repeat(64),
      security_exception_ids: [],
      source_digest: 'e'.repeat(64),
      branch: 'feat/example-fixture',
      pr_url: 'https://github.com/example/importkit/pull/1',
    };
    orders = [
      { ...order, id: 'watch-completed', status: 'completed', phase: 'security_watch', questions: [] },
      { ...order, id: 'without-receipt', status: 'completed', phase: 'delivery', questions: [] },
      { ...order, id: 'with-pr', status: 'completed', phase: 'delivery', questions: [], evidence },
    ];
    mockApi();
    const user = await enter();
    const openClosed = async (index: number) => {
      await user.click(within(runList()).getByRole('button', { name: 'Closed' }));
      const closed = within(runList()).getAllByRole('link', { name: new RegExp(order.objective) });
      expect(closed).toHaveLength(3);
      await user.click(closed[index]);
    };
    await openClosed(0);
    expect(screen.getByRole('heading', { level: 1, name: 'Monitoring Importkit' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Review PR ↗' })).not.toBeInTheDocument();
    await backToRuns(user);
    await openClosed(1);
    expect(screen.queryByRole('link', { name: 'Review PR ↗' })).not.toBeInTheDocument();
    await backToRuns(user);
    await openClosed(2);
    expect(screen.getByRole('link', { name: 'Review PR ↗' })).toHaveAttribute('href', evidence.pr_url);
    expect(writes).toEqual([]);
  });

  it.each([
    { exitCode: 0, matchingSnapshot: true, verdict: 'Passed' },
    { exitCode: 1, matchingSnapshot: true, verdict: 'Failed' },
    { exitCode: 0, matchingSnapshot: false, verdict: 'Foreign evidence' },
  ])(
    'presents evidence before the plan without passing invalid gates: $verdict',
    async ({ exitCode, matchingSnapshot, verdict }) => {
      const evidence: NonNullable<WorkOrder['evidence']> = {
        commit: 'a'.repeat(40),
        snapshot_digest: 'b'.repeat(64),
        profile_digest: 'c'.repeat(64),
        rules_version: 'synthetic-rules',
        gates: [
          {
            command: ['npm', 'run', 'check'],
            exit_code: exitCode,
            output_digest: 'd'.repeat(64),
            snapshot_digest: (matchingSnapshot ? 'b' : 'e').repeat(64),
          },
        ],
        findings: [],
        review: 'Retained synthetic review',
        security_policy_digest: 'f'.repeat(64),
        security_exception_ids: [],
        source_digest: null,
        branch: 'fix/synthetic-evidence',
        pr_url: null,
      };
      orders = [{ ...order, status: 'blocked', phase: 'review', questions: [], evidence }];
      mockApi();
      const user = await enter();
      const history = runList();
      await user.click(within(history).getByRole('link', { name: new RegExp(order.objective) }));
      await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
      const heading = screen.getByRole('heading', { name: 'Delivery evidence' });
      const section = within(heading.closest('section')!);
      expect(
        heading.compareDocumentPosition(screen.getByRole('heading', { name: 'Work plan' })) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(section.getByText('Retained synthetic review')).toBeVisible();
      const gate = within(section.getByRole('list', { name: 'Delivery checks' })).getByRole('listitem');
      expect(gate).toHaveTextContent('npm run check');
      expect(gate).toHaveTextContent(`Exit ${exitCode}`);
      expect(gate).toHaveTextContent(verdict);
      expect(gate).toHaveAttribute('data-state', exitCode === 0 && matchingSnapshot ? 'passed' : 'failed');
      if (matchingSnapshot) expect(section.queryByRole('alert')).not.toBeInTheDocument();
      else expect(section.getByRole('alert')).toHaveTextContent('snapshots do not match');
      expect(section.getByText(evidence.commit)).not.toBeVisible();
      await user.click(section.getByText('Technical references', { selector: 'summary' }));
      expect(section.getByText(evidence.commit)).toBeVisible();
      expect(section.getByText('fix/synthetic-evidence')).toBeVisible();
      expect(writes).toEqual([]);
    },
  );

  it('prioritizes the block over a long objective and keeps the full objective', async () => {
    const objective = 'Fix ImportKit ETag validation to comply with RFC 9110. '.repeat(12);
    orders = [
      {
        ...order,
        objective,
        status: 'blocked',
        phase: 'intake',
        tasks: [],
        questions: [],
        error_code: 'WORKSPACE_SNAPSHOT_FAILED',
        summary: 'The workspace result could not be saved.',
      },
    ];
    mockApi();
    const user = await enter();
    await user.click(
      within(runList()).getByRole('link', {
        name: /Fix ImportKit ETag validation/,
      }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    expect(screen.getByText('WORKSPACE_SNAPSHOT_FAILED')).toBeVisible();
    const reason = screen.getByText('The workspace result could not be saved.');
    expect(reason).toBeVisible();
    const disclosure = screen.getByText('Full objective').closest('details')!;
    expect(reason.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(disclosure).not.toHaveAttribute('open');
    await user.click(within(disclosure).getByText('Full objective'));
    expect(disclosure).toHaveAttribute('open');
    expect(within(disclosure).getByText(objective.trim())).toBeVisible();
    // The empty plan states the block; it never reads as a run still in progress.
    await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
    expect(screen.getByText('The run is blocked. Review the reason before resuming.')).toBeVisible();
    expect(
      screen.queryByText('The run is in progress. Tasks appear when they are recorded.'),
    ).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('resolves HITL with the question identifier and revision', async () => {
    mockApi();
    const user = await enter();
    await selectRun(user);
    await user.click(screen.getByRole('button', { name: 'Yes, keep it' }));
    await user.click(screen.getByRole('button', { name: 'Answer and continue' }));
    await waitFor(() =>
      expect(writes).toContainEqual({
        path: '/work/work-one/answer',
        body: { question_id: 'question-one', plan_revision: 2, answer: 'Yes, keep it' },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Answer and continue' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
    expect(screen.getByRole('heading', { name: 'Work plan' })).toBeVisible();
  });

  it('offers only pending decisions from the current plan revision', async () => {
    orders = [
      {
        ...order,
        questions: [
          { ...order.questions[0], id: 'question-old', plan_revision: 1, prompt: 'Expired decision' },
          order.questions[0],
        ],
      },
    ];
    mockApi();
    const user = await enter();
    expect(screen.queryByText('Expired decision')).not.toBeInTheDocument();
    await selectRun(user);
    expect(screen.queryByText('Expired decision')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Answer and continue' })).toHaveLength(1);
  });

  it('keeps the error visible when answering a stale revision', async () => {
    mockApi({
      'POST /work/work-one/answer': {
        status: 409,
        body: {
          detail: { code: 'STALE_REVISION', message: 'The question belongs to another revision of the plan' },
        },
      },
    });
    const user = await enter();
    await selectRun(user);
    await user.type(screen.getByLabelText('Your answer'), 'Keep the previous format');
    await user.click(screen.getByRole('button', { name: 'Answer and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The question belongs to another revision');
    expect(screen.getByLabelText('Your answer')).toHaveValue('Keep the previous format');
  });

  it('asks to confirm the cancellation before calling the API', async () => {
    mockApi();
    const user = await enter();
    await selectRun(user);
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(writes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(writes).toContainEqual({ path: '/work/work-one/cancel', body: undefined }));
  });

  it('shows a cancelled run that retains a budget error as history without a decision, resume or answer form', async () => {
    orders = [
      {
        ...order,
        status: 'cancelled',
        control: 'cancel',
        phase: 'verification',
        error_code: 'BUDGET_EXHAUSTED',
        limiting_metric: 'tokens',
        summary: 'Work order cancelled',
      },
    ];
    mockApi();
    const user = await enter();
    await selectRun(user);
    const history = screen.getByRole('note', { name: 'Retained run history' });
    expect(history).toHaveTextContent('History · BUDGET_EXHAUSTED');
    expect(history).toHaveTextContent('No decision is pending');
    expect(screen.getByText('Work order cancelled')).toBeVisible();
    expect(screen.queryByText(/waiting for your budget decision/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review budget options' })).not.toBeInTheDocument();
    for (const name of ['Resume', 'Resolve budget', 'Pause', 'Cancel run', 'Answer and continue'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByText('Your decision unlocks the next step')).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('withdraws the pending decision once cancellation is confirmed', async () => {
    mockApi();
    const user = await enter();
    await selectRun(user);
    expect(screen.getByRole('button', { name: 'Answer and continue' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Answer and continue' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Your decision unlocks the next step')).not.toBeInTheDocument();
  });

  it('sends a new scope with revision control', async () => {
    orders[0].status = 'paused';
    mockApi();
    const user = await enter();
    await selectRun(user);
    await user.click(screen.getByRole('tab', { name: 'Limits & scope' }));
    await user.click(screen.getByText('Change request'));
    await user.clear(screen.getByLabelText('New objective'));
    await user.type(screen.getByLabelText('New objective'), 'Fix only the syntax errors');
    await user.click(screen.getByRole('button', { name: 'Update scope' }));
    await waitFor(() =>
      expect(writes).toContainEqual({
        path: '/work/work-one/scope',
        body: {
          expected_revision: 2,
          objective: 'Fix only the syntax errors',
          acceptance: ['Rejects invalid input'],
        },
      }),
    );
  });

  it('requires pausing the run before applying a scope change', async () => {
    mockApi();
    const user = await enter();
    await selectRun(user);
    await user.click(screen.getByRole('tab', { name: 'Limits & scope' }));
    await user.click(screen.getByText('Change request'));
    expect(screen.getByRole('button', { name: 'Update scope' })).toBeDisabled();
    expect(screen.getByText('Pause the run before applying this change.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['running', true],
    ['queued', true],
    ['paused', false],
  ] as const)('shows the pause request only while it is being processed: %s', async (status, pending) => {
    orders = [{ ...order, status, control: 'pause', questions: [] }];
    mockApi();
    const user = await enter();
    await user.click(
      within(runList()).getByRole('link', {
        name: new RegExp(order.objective),
      }),
    );
    if (pending) {
      expect(screen.getByText('Pause requested.')).toBeVisible();
    } else {
      expect(screen.queryByText('Pause requested.')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    }
    expect(writes).toEqual([]);
  });

  it('creates a run with an explicit budget, criteria and the web channel', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    await user.type(screen.getByLabelText('What do you need?'), 'Add input validation');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Acceptance criteria'), 'Rejects empty input');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Maximum paid API spend · USD'), '2');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Launch flow' }));
    await waitFor(() => expect(writes.some((write) => write.path === '/work')).toBe(true));
    const body = writes.find((write) => write.path === '/work')!.body!;
    expect(body).toMatchObject({
      mode: 'patch',
      project_id: project.id,
      objective: 'Add input validation',
      acceptance: ['Rejects empty input'],
      channel: 'web',
      budget: {
        max_cost_usd: 2,
        max_calls: null,
        max_tokens: null,
        active_seconds: null,
        policy: {
          version: 1,
          tokens: { primary: 100000, reserve: 0, absolute: 100000 },
          invocations: { primary: 40, reserve: 0, absolute: 40 },
          active_seconds: { primary: 3600, reserve: 0, absolute: 3600 },
          repairs: { primary: 2, reserve: 0, absolute: 2 },
          no_progress_threshold: 3,
        },
      },
    });
    expect(body.idempotency_key).toMatch(/[a-f0-9-]{36}/);
  });

  it('creates a CLI run with uncapped metrics and no API spend authorization', async () => {
    mockApi({ 'GET /status': { status: 200, body: cliStatus } });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    await wizardStep(user, 'Flow & limits');
    expect(screen.getByLabelText('Tokens policy')).toHaveValue('bounded');
    expect(screen.getByLabelText('Tokens primary ceiling')).toHaveValue(100000);
    await user.selectOptions(screen.getByLabelText('Tokens policy'), 'uncapped');
    expect(screen.queryByLabelText('Tokens primary ceiling')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Maximum paid API spend · USD')).toHaveValue(0);
    expect(screen.getByText(/CLI aggregate token usage may be known only after an invocation/)).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Tokens policy'), 'bounded');
    expect(screen.getByLabelText('Tokens primary ceiling')).toHaveValue(100000);
    for (const label of [
      'Tokens policy',
      'Model invocations policy',
      'Active time · seconds policy',
      'Repair cycles policy',
    ])
      await user.selectOptions(screen.getByLabelText(label), 'uncapped');
    await wizardStep(user, 'Work');
    await user.type(screen.getByLabelText('What do you need?'), 'Add input validation');
    await wizardStep(user, 'Acceptance');
    await user.type(screen.getByLabelText('Acceptance criteria'), 'Rejects empty input');
    await wizardStep(user, 'Review');
    await user.click(screen.getByRole('button', { name: 'Launch flow' }));
    await waitFor(() => expect(writes.find((write) => write.path === '/work')).toBeDefined());
    expect(writes.find((write) => write.path === '/work')!.body?.budget).toEqual({
      max_calls: null,
      max_tokens: null,
      active_seconds: null,
      max_cost_usd: 0,
      policy: {
        version: 1,
        tokens: { primary: null, reserve: 0, absolute: null },
        invocations: { primary: null, reserve: 0, absolute: null },
        active_seconds: { primary: null, reserve: 0, absolute: null },
        repairs: { primary: null, reserve: 0, absolute: null },
        no_progress_threshold: 3,
      },
    });
  });

  it('keeps the cumulative budget when a role uses the API even though the main model is CLI', async () => {
    mockApi({
      'GET /status': {
        status: 200,
        body: { ...cliStatus, roles: { ...cliStatus.roles, reviewer: { provider: 'openai' } } },
      },
    });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    await wizardStep(user, 'Flow & limits');
    expect(screen.queryByLabelText('Run controls')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tokens primary ceiling')).toHaveValue(100000);
    expect(screen.getByLabelText('Model invocations primary ceiling')).toHaveValue(40);
    expect(screen.getByLabelText('Maximum paid API spend · USD')).toHaveValue(0);
    expect(
      screen.getByText(
        'CLI subscription usage is recorded separately. Zero does not authorize paid API calls.',
      ),
    ).toBeVisible();
  });

  it.each([false, true])(
    'switches the CLI control with the observed revision and budget, conflict=%s',
    async (conflict) => {
      const budget = { max_calls: 44, max_tokens: 900000, active_seconds: 1800, max_cost_usd: 0 };
      orders = [
        {
          ...order,
          budget,
          status: 'blocked',
          questions: [],
          calls_used: 44,
          tokens_used: 858034,
          active_seconds_used: 1551,
          cost_usd: 0,
        },
      ];
      const mock = mockApi({
        'GET /status': { status: 200, body: cliStatus },
        ...(conflict
          ? {
              'POST /work/work-one/cli-progress-limits': {
                status: 409,
                body: { message: 'The budget has changed. Refresh the run.' },
              },
            }
          : {}),
      });
      window.history.replaceState(null, '', '/runs/work-one');
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole('heading', { level: 1, name: 'Patch Importkit' });
      await user.click(screen.getByRole('tab', { name: 'Limits & scope' }));
      await user.click(screen.getByRole('button', { name: 'Use per-agent controls' }));
      await waitFor(() =>
        expect(
          mock.mock.calls.filter(
            ([input, options]) => input.endsWith('/cli-progress-limits') && options?.method === 'POST',
          ),
        ).toHaveLength(1),
      );
      const request = mock.mock.calls.find(([input]) => input.endsWith('/cli-progress-limits'))![1]!;
      expect(JSON.parse(String(request.body))).toEqual({ expected_revision: 2, expected_budget: budget });
      expect(request.credentials).toBe('same-origin');
      expect(request.headers).toMatchObject({ 'X-CSRF-Token': 'synthetic-csrf', 'X-Sabre-UI': '1' });
      if (conflict) {
        expect(await screen.findByRole('alert')).toHaveTextContent('The budget has changed');
        expect(screen.getByRole('meter', { name: 'Tokens' })).toHaveAttribute('max', '900000');
      } else {
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: 'Use per-agent controls' })).not.toBeInTheDocument(),
        );
        const usage = within(screen.getByRole('region', { name: 'Usage and limits' }));
        expect(usage.getByText('44')).toBeVisible();
        expect(usage.getByText(new Intl.NumberFormat('en-US').format(858034))).toBeVisible();
        expect(usage.getByText('26')).toBeVisible();
        expect(usage.queryAllByRole('meter')).toHaveLength(0);
        expect(usage.getByText(/50 steps or 10 minutes per agent/)).toBeVisible();
        expect(usage.getByText(/120-second CLI invocation limit/)).toBeVisible();
        expect(usage.queryByText(/Infinity|NaN|∞/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
      }
      expect(mock.mock.calls.some(([input]) => input.endsWith('/resume'))).toBe(false);
    },
  );

  it('rejects unstructured commands without sending them to the backend', async () => {
    mockApi();
    const user = await enter();
    await legacyRoute('/projects');
    await user.click(screen.getByRole('button', { name: '+ Register project' }));
    await user.type(screen.getByLabelText('Project name'), 'Another project');
    await user.type(screen.getByLabelText('Repository'), 'https://github.com/example/another');
    await user.clear(screen.getByLabelText('Delivery checks'));
    await user.type(screen.getByLabelText('Delivery checks'), 'npm test');
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('JSON argument array');
    expect(writes).toHaveLength(0);
  });

  it('keeps the idempotency key when the submission fails and is retried', async () => {
    const mock = mockApi();
    const handler = mock.getMockImplementation()!;
    let submissions = 0;
    mock.mockImplementation(async (input, options = {}) => {
      if (input === '/api/v1/work' && options.method === 'POST' && submissions++ === 0) {
        return Response.json({ message: 'Service temporarily busy' }, { status: 503 });
      }
      return handler(input, options);
    });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    await user.type(screen.getByLabelText('What do you need?'), 'Add input validation');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Acceptance criteria'), 'Rejects empty input');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('Maximum paid API spend · USD'), '2');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Launch flow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Service temporarily busy');
    await user.click(screen.getByRole('button', { name: 'Launch flow' }));
    await waitFor(() => expect(writes.some((write) => write.path === '/work')).toBe(true));
    const attempts = mock.mock.calls.filter(
      ([input, options]) => input === '/api/v1/work' && options?.method === 'POST',
    );
    expect(attempts).toHaveLength(2);
    expect(JSON.parse(String(attempts[0][1]?.body)).idempotency_key).toBe(
      JSON.parse(String(attempts[1][1]?.body)).idempotency_key,
    );
  });

  it('approves and invalidates a memory while keeping its provenance', async () => {
    memory = [
      {
        id: 'memory-one',
        project_id: project.id,
        kind: 'lesson',
        content: 'Keep the import contract',
        source_commit: 'abc123',
        source_work_id: order.id,
        evidence_digest: null,
        active: false,
        created_at: '2026-11-05T10:00:00Z',
        approved_at: null,
        invalidated_at: null,
      },
    ];
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('link', { name: 'Memory' }));
    await user.click(await screen.findByRole('tab', { name: 'Review queue' }));
    await user.click(await screen.findByRole('button', { name: 'Inspect memory memory-one' }));
    const inspector = screen.getByRole('dialog', { name: 'Memory provenance' });
    await user.click(within(inspector).getByRole('button', { name: 'Approve memory' }));
    await within(inspector).findByText('Approved');
    expect(within(inspector).getByText('abc123')).toBeVisible();
    await user.click(within(inspector).getByRole('button', { name: 'Invalidate memory' }));
    await within(inspector).findByText('Invalidated');
    expect(writes.map((write) => write.path)).toEqual([
      '/memory/memory-one/approve',
      '/memory/memory-one/invalidate',
    ]);
  });

  it('shows the security pipeline without claiming an approval that does not exist', async () => {
    mockApi();
    const user = await enter();
    await selectRun(user);
    await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
    const security = screen.getByRole('heading', { name: 'Security pipeline' }).closest('section')!;
    expect(within(security).getByText(/has not produced a result for this delivery/)).toBeVisible();
  });

  it('approves an exception bound to the finding, snapshot, rules and revision and lets it be revoked', async () => {
    const snapshot = 'a'.repeat(64);
    const finding = {
      fingerprint: 'vulnerability-one',
      scanner: 'trivy',
      category: 'vulnerability',
      severity: 'high',
      title: 'Vulnerability with a reviewed mitigation',
      path: 'requirements.lock',
      reference: 'CVE-TEST-0001',
      baseline: false,
      line: null,
      remediation: null,
      exception_id: null,
    };
    orders = [
      {
        ...order,
        status: 'blocked',
        questions: [],
        findings: [finding],
        security_snapshot_digest: snapshot,
        security_rules_version: 'rules-v3',
      },
    ];
    mockApi();
    const user = await enter();
    await user.click(
      within(runList()).getByRole('link', {
        name: new RegExp(order.objective),
      }),
    );
    await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
    await user.click(screen.getByRole('button', { name: 'Temporary security exception' }));
    await user.selectOptions(screen.getByLabelText('Finding'), finding.fingerprint);
    const justification = 'Temporary mitigation verified by the owner.';
    await user.type(screen.getByLabelText('Exception justification'), justification);
    const expiry = '2026-11-20T12:30';
    fireEvent.change(screen.getByLabelText('Expiry · local time'), { target: { value: expiry } });
    await user.click(screen.getByRole('button', { name: 'Temporarily approve this risk' }));
    await waitFor(() =>
      expect(writes).toContainEqual({
        path: '/work/work-one/security-exceptions',
        body: {
          fingerprint: finding.fingerprint,
          justification,
          expires_at: new Date(expiry).toISOString(),
          snapshot_digest: snapshot,
          rules_version: 'rules-v3',
          plan_revision: 2,
        },
      }),
    );
    expect(await screen.findByText(justification)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Revoke exception' }));
    await waitFor(() =>
      expect(writes).toContainEqual({
        path: '/work/work-one/security-exceptions/exception-one/revoke',
        body: undefined,
      }),
    );
    expect(await screen.findByText(/^Revoked /)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Revoke exception' })).not.toBeInTheDocument();
  });

  it.each(['secret', 'scanner_error'])('offers no exceptions for a %s finding', async (category) => {
    orders = [
      {
        ...order,
        status: 'blocked',
        questions: [],
        security_snapshot_digest: 'a'.repeat(64),
        security_rules_version: 'rules-v3',
        findings: [
          {
            fingerprint: 'mandatory-fix',
            scanner: 'gitleaks',
            category,
            severity: 'high',
            title: 'Finding that requires a fix',
            path: null,
            reference: null,
            baseline: false,
            line: null,
            remediation: null,
            exception_id: null,
          },
        ],
      },
    ];
    mockApi();
    const user = await enter();
    await user.click(
      within(runList()).getByRole('link', {
        name: new RegExp(order.objective),
      }),
    );
    await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
    expect(screen.queryByRole('button', { name: 'Temporary security exception' })).not.toBeInTheDocument();
  });

  it('offers no approval without a security rules version', async () => {
    orders = [
      {
        ...order,
        status: 'blocked',
        questions: [],
        security_snapshot_digest: 'a'.repeat(64),
        security_rules_version: null,
        findings: [
          {
            fingerprint: 'unbound-risk',
            scanner: 'trivy',
            category: 'vulnerability',
            severity: 'high',
            title: 'Finding without bound rules',
            path: null,
            reference: null,
            baseline: false,
            line: null,
            remediation: null,
            exception_id: null,
          },
        ],
      },
    ];
    mockApi();
    const user = await enter();
    await user.click(
      within(runList()).getByRole('link', {
        name: new RegExp(order.objective),
      }),
    );
    await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
    expect(screen.queryByRole('button', { name: 'Temporary security exception' })).not.toBeInTheDocument();
  });

  it.each(['blocked', 'failed'])(
    'shows %s monitoring as remediation proposals without resume or scope change',
    async (status) => {
      orders = [
        {
          ...order,
          mode: 'maintain',
          phase: 'security_watch',
          status,
          questions: [],
          tasks: [{ ...order.tasks[0], title: 'Update the vulnerable dependency' }],
        },
      ];
      mockApi();
      const user = await enter();
      await user.click(
        within(runList()).getByRole('link', {
          name: new RegExp(order.objective),
        }),
      );
      await user.click(screen.getByRole('tab', { name: 'Tasks & evidence' }));
      expect(screen.getByRole('heading', { name: 'Remediation proposals' })).toBeVisible();
      expect(screen.getByRole('heading', { level: 1, name: 'Monitoring Importkit' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
      expect(screen.queryByText('Change request')).not.toBeInTheDocument();
      expect(writes).toEqual([]);
    },
  );
});

describe('API client', () => {
  it('explains network errors without hiding them as an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(createApi('test').projects()).rejects.toThrow('SABRE is unreachable');
  });
});

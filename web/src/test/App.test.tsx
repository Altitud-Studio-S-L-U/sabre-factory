import { configuration } from './modelConfigurationFixture';
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
  created_at: '2026-11-05T10:00:00Z',
} satisfies Project;
const order = {
  id: 'work-one',
  project_id: project.id,
  mode: 'patch',
  objective: 'Corregir la validación de importaciones',
  acceptance: ['Rechaza entradas inválidas'],
  constraints: ['Conservar la API'],
  budget: { max_calls: 40, max_tokens: 100000, max_cost_usd: 5, active_seconds: 3600 },
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
  },
  resolved_flow: null,
  graph_version: 'sabre-v1',
  plan_revision: 2,
  created_at: '2026-11-05T10:00:00Z',
  updated_at: '2026-11-05T10:02:00Z',
  tasks: [
    {
      id: 'task-one',
      title: 'Reproducir el defecto',
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
      prompt: '¿Debe conservarse el formato anterior?',
      kind: 'clarification',
      options: ['Sí, conservarlo', 'No, sustituirlo'],
      subject_digest: null,
      answer: null,
      answered_at: null,
    },
  ],
  findings: [],
  security_snapshot_digest: null,
  security_rules_version: null,
  evidence: null,
  summary: 'Esperando tu decisión',
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
    if (path.endsWith('/execution-events'))
      return Response.json({ items: [], next_cursor: 0, has_more: false });
    if (path === '/status')
      return Response.json({ database: true, executor: false, graph_version: 'sabre-v1' });
    if (path === '/integrations')
      return Response.json([
        {
          id: 'github.read',
          kind: 'github',
          title: 'GitHub · repositorios',
          description: 'Explora repositorios.',
          enabled: true,
          revision: 0,
          toggleable: true,
          credential_ids: ['github.read'],
          credential_configured: false,
          access: 'Acceso público',
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
            detail: 'El ejecutor responde; la sesión no está conectada.',
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
        { id: 1, kind: 'order.created', message: 'Run recibido', created_at: '2026-11-05T10:00:00Z' },
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
    return Response.json({ message: 'Ruta no preparada en la prueba' }, { status: 404 });
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

beforeEach(() => {
  projects = [structuredClone(project)];
  orders = [structuredClone(order)];
  memory = [];
  exceptions = [];
  writes = [];
  window.history.replaceState(null, '', '/');
});

describe('Control room', () => {
  it('expone rutas reales y conserva vista y encargo con Atrás, Adelante y recarga', async () => {
    mockApi();
    const user = userEvent.setup();
    const mounted = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Runs' });
    expect(window.location.pathname).toBe('/work');
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    for (const [name, path] of [
      ['Projects', '/projects'],
      ['Security', '/security'],
      ['Memory', '/memory'],
      ['Integrations', '/integrations'],
      ['About', '/about'],
    ])
      expect(within(navigation).getByRole('link', { name })).toHaveAttribute('href', path);
    await user.click(within(navigation).getByRole('link', { name: 'Projects' }));
    expect(window.location.pathname).toBe('/projects');
    await user.click(within(navigation).getByRole('link', { name: /^Runs/ }));
    await user.click(
      within(screen.getByRole('region', { name: 'Run history' })).getByRole('button', {
        name: new RegExp(order.objective),
      }),
    );
    expect(window.location.pathname).toBe('/work/work-one');
    await act(async () => window.history.back());
    await screen.findByRole('heading', { level: 1, name: 'Runs' });
    expect(window.location.pathname).toBe('/work');
    await act(async () => window.history.back());
    await screen.findByRole('heading', { level: 1, name: 'Projects' });
    await act(async () => window.history.forward());
    await screen.findByRole('heading', { level: 1, name: 'Runs' });
    await act(async () => window.history.forward());
    await screen.findByRole('heading', { level: 1, name: 'Patch Importkit' });
    mounted.unmount();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(window.location.pathname).toBe('/work/work-one');
    expect(writes).toEqual([]);
  });

  it('abre un enlace profundo fuera del listado y retira el ticket antes de cualquier consulta', async () => {
    orders = [];
    window.history.replaceState(null, '', '/work/work-one#ticket=synthetic-deep-link');
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
    expect(window.location.pathname).toBe('/work/work-one');
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/session/exchange'))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/v1/work/work-one')).toBe(true);
    expect(document.body).not.toHaveTextContent('synthetic-deep-link');
    expect(writes).toEqual([]);
  });

  it('muestra el error del enlace de encargo inexistente sin sustituirlo por el listado', async () => {
    window.history.replaceState(null, '', '/work/missing');
    mockApi({ 'GET /work/missing': { status: 404, body: { message: 'No existe' } } });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Run unavailable' })).toBeVisible();
    expect(screen.getByText('This run does not exist or is no longer available.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Run history' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/work/missing');
    await user.click(screen.getByRole('link', { name: '← All runs' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    expect(writes).toEqual([]);
  });

  it('mantiene los runs fallidos en Open y permite revisarlos fuera de Closed', async () => {
    orders = [
      {
        ...order,
        status: 'failed',
        questions: [],
        error_code: 'TOOL_FAILED',
        summary: 'La comprobación no pudo completarse.',
      },
      {
        ...order,
        id: 'completed-work',
        objective: 'Run completado de prueba',
        status: 'completed',
        questions: [],
      },
    ];
    mockApi();
    const user = await enter();
    let history = screen.getByRole('region', { name: 'Run history' });
    await user.click(within(history).getByRole('button', { name: 'Open' }));
    await user.click(within(history).getByRole('button', { name: new RegExp(order.objective) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '← All runs' }));
    history = screen.getByRole('region', { name: 'Run history' });
    await user.click(within(history).getByRole('button', { name: 'Closed' }));
    expect(
      within(history).queryByRole('button', { name: new RegExp(order.objective) }),
    ).not.toBeInTheDocument();
    expect(within(history).getByRole('button', { name: /Run completado de prueba/ })).toBeVisible();
    expect(writes).toEqual([]);
  });

  it('navega con teclado al encabezado de vista y encargo sin robar el foco al actualizar', async () => {
    const fetchMock = mockApi();
    const user = await enter();
    const navigation = screen.getByRole('navigation', { name: 'Main navigation' });
    within(navigation).getByRole('link', { name: 'Projects' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toHaveFocus());
    within(navigation).getByRole('link', { name: /^Runs/ }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toHaveFocus());
    const history = screen.getByRole('region', { name: 'Run history' });
    within(history)
      .getByRole('button', { name: new RegExp(order.objective) })
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

  it('gestiona las credenciales de una integración sin iniciar runs', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('link', { name: 'Integrations' }));
    await user.click(
      await screen.findByRole('button', { name: 'Configure credentials of GitHub · repositorios' }),
    );
    expect(await screen.findByRole('heading', { name: 'SABRE credentials' })).toBeVisible();
    expect(await screen.findByText('No saved credentials yet.')).toBeVisible();
    expect(writes).toEqual([]);
  });
  it('consulta About sin atribuir autenticación a la disponibilidad del ejecutor', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('link', { name: 'Projects' }));
    expect(screen.getByText('1 configured check')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'About' }));
    expect(await screen.findByRole('heading', { name: 'Services and connections' })).toBeVisible();
    const cli = within(screen.getByRole('heading', { name: 'Codex CLI' }).closest('li')!);
    expect(cli.getByText('Responde')).toBeVisible();
    expect(cli.getByText('Not configured')).toBeVisible();
    expect(screen.getByText(/explicit-cli-model/)).toBeVisible();
    expect(screen.getByText(/Automatic \(CLI\)/)).toBeVisible();
    expect(screen.getByText(/synthetic-graph-version/)).toBeVisible();
    expect(writes).toEqual([]);
  });
  it('restaura la sesión del navegador sin bearer ni credenciales en storage y revoca al salir', async () => {
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
    await screen.findByRole('heading', { name: 'Open SABRE from the CLI' });
    const logout = fetchMock.mock.calls.find(([path]) => path.endsWith('/panel/session/logout'));
    expect(logout?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    expect(new Headers(logout?.[1]?.headers).get('X-CSRF-Token')).toBe('synthetic-csrf');
    expect(screen.queryByLabelText('Token de acceso')).not.toBeInTheDocument();
  });

  it('explica cómo abrir el panel cuando no hay sesión sin pedir un token manual', async () => {
    const fetchMock = mockApi({ 'GET /panel/session': { status: 401, body: { message: 'Unauthorized' } } });
    render(<App />);
    await screen.findByRole('heading', { name: 'Open SABRE from the CLI' });
    expect(screen.getByText('node bin/sabre.mjs open')).toBeVisible();
    expect(screen.queryByLabelText('Token de acceso')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it('elimina el ticket del historial antes de enviarlo y lo canjea una sola vez en StrictMode', async () => {
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

  it.each(['rejected', 'network'])('borra el ticket también si el canje falla: %s', async (failure) => {
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

  it('restaura la cookie tras volver a abrir el panel sin reutilizar el ticket', async () => {
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

  it('canjea un enlace nuevo en la pestaña ya abierta sin recargar y borra el fragmento antes del fetch', async () => {
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
    await screen.findByRole('heading', { name: 'Open SABRE from the CLI' });
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

  it('borra un enlace nuevo rechazado y permite otro enlace sin repetir el anterior', async () => {
    const overrides: Record<string, { status: number; body: unknown }> = {
      'POST /panel/session/exchange': { status: 401, body: { message: 'synthetic-expired-link' } },
    };
    const fetchMock = mockApi(overrides);
    await enter();
    window.history.pushState(null, '', '/#ticket=synthetic-expired-link');
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('');
    await screen.findByRole('heading', { name: 'Open SABRE from the CLI' });
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

  it('ignora una restauración antigua que termina después de canjear el nuevo enlace', async () => {
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

  it('una consulta de la sesión anterior no desconecta el nuevo acceso', async () => {
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

  it('retira los datos cuando la sesión caduca durante una consulta', async () => {
    const overrides: Record<string, { status: number; body: unknown }> = {};
    mockApi(overrides);
    const user = await enter();
    overrides['GET /status'] = { status: 401, body: { message: 'Unauthorized' } };
    await user.click(screen.getByRole('button', { name: 'Refresh data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The session expired');
    expect(screen.getByRole('heading', { name: 'Open SABRE from the CLI' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Runs' })).not.toBeInTheDocument();
  });

  it('no abre la fábrica si la respuesta no acredita una sesión válida', async () => {
    mockApi({ 'GET /panel/session': { status: 200, body: { authenticated: false } } });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The SABRE session could not be verified');
    expect(screen.queryByRole('heading', { name: 'Runs' })).not.toBeInTheDocument();
  });

  it('no anuncia una sesión cerrada si el servidor no pudo revocarla', async () => {
    mockApi({ 'POST /panel/session/logout': { status: 503, body: { message: 'Revocación no disponible' } } });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out could not be confirmed');
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeVisible();
  });

  it('pide recargar si otra pestaña renueva la sesión sin repetir la operación rechazada', async () => {
    const overrides: Record<string, { status: number; body: unknown }> = {
      'POST /panel/session/logout': { status: 403, body: { code: 'PANEL_CSRF_DENIED' } },
    };
    const fetchMock = mockApi(overrides);
    const user = userEvent.setup();
    const first = render(<App />);
    await screen.findByRole('heading', { name: 'Runs' });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The browser session changed');
    expect(screen.getByRole('heading', { name: 'Open SABRE from the CLI' })).toBeVisible();
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
    await screen.findByRole('heading', { name: 'Open SABRE from the CLI' });
    const logouts = fetchMock.mock.calls.filter(([path]) => path.endsWith('/panel/session/logout'));
    expect(logouts).toHaveLength(2);
    expect(new Headers(logouts[1][1]?.headers).get('X-CSRF-Token')).toBe('synthetic-renewed-csrf');
  });

  it('no presenta un cero de runs como dato real cuando no puede cargar la fábrica', async () => {
    mockApi({ 'GET /work': { status: 503, body: { message: 'Base de datos no disponible' } } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'The factory could not be loaded' })).toBeVisible();
    expect(screen.queryByText('Your first run starts here')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Base de datos no disponible');
  });

  it('permite recorrer una fábrica vacía y pide registrar proyecto antes de encargar trabajo', async () => {
    projects = [];
    orders = [];
    mockApi();
    const user = await enter();
    expect(screen.getByRole('heading', { name: 'Your first run starts here' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    expect(screen.getByRole('heading', { name: 'Register a project to get started' })).toBeVisible();
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('link', { name: 'Projects' }));
    expect(screen.getByRole('heading', { name: 'Your first project starts here' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Memory' }));
    expect(screen.getByRole('heading', { name: 'Register a project to save knowledge' })).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Security' }));
    expect(await screen.findByRole('heading', { name: 'No recorded findings' })).toBeVisible();
    expect(writes).toEqual([]);
  });

  it('cuenta como entrega solo un encargo completado con PR, excluyendo informes de vigilancia', async () => {
    const evidence: NonNullable<WorkOrder['evidence']> = {
      commit: 'a'.repeat(40),
      snapshot_digest: 'b'.repeat(64),
      profile_digest: 'c'.repeat(64),
      rules_version: 'rules-v3',
      gates: [],
      findings: [],
      review: 'Fixture de entrega revisada',
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
    await enter();
    const summary = screen.getByText('Completed deliveries').parentElement;
    expect(summary).not.toBeNull();
    expect(within(summary!).getByText('1')).toBeVisible();
  });

  it.each([
    { exitCode: 0, matchingSnapshot: true, verdict: 'Superada' },
    { exitCode: 1, matchingSnapshot: true, verdict: 'Fallida' },
    { exitCode: 0, matchingSnapshot: false, verdict: 'Evidencia ajena' },
  ])(
    'presenta evidencia antes del plan sin aprobar gates inválidos: $verdict',
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
        review: 'Review sintética conservada',
        security_policy_digest: 'f'.repeat(64),
        security_exception_ids: [],
        source_digest: null,
        branch: 'fix/synthetic-evidence',
        pr_url: null,
      };
      orders = [{ ...order, status: 'blocked', phase: 'review', questions: [], evidence }];
      mockApi();
      const user = await enter();
      const history = screen.getByRole('region', { name: 'Run history' });
      await user.click(within(history).getByRole('button', { name: new RegExp(order.objective) }));
      const heading = screen.getByRole('heading', { name: 'Delivery evidence' });
      const section = within(heading.closest('section')!);
      expect(
        heading.compareDocumentPosition(screen.getByRole('heading', { name: 'Work plan' })) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(section.getByText('Review sintética conservada')).toBeVisible();
      const gate = within(section.getByRole('list', { name: 'Delivery checks' })).getByRole('listitem');
      expect(gate).toHaveTextContent('npm run check');
      expect(gate).toHaveTextContent(`Salida ${exitCode}`);
      expect(gate).toHaveTextContent(verdict);
      expect(gate).toHaveClass(exitCode === 0 && matchingSnapshot ? 'passed' : 'failed');
      if (matchingSnapshot) expect(section.queryByRole('alert')).not.toBeInTheDocument();
      else expect(section.getByRole('alert')).toHaveTextContent('snapshots do not match');
      expect(section.getByText(evidence.commit)).not.toBeVisible();
      await user.click(section.getByText('Technical references', { selector: 'summary' }));
      expect(section.getByText(evidence.commit)).toBeVisible();
      expect(section.getByText('fix/synthetic-evidence')).toBeVisible();
      expect(writes).toEqual([]);
    },
  );

  it('prioriza el bloqueo sobre un objetivo extenso y conserva el objetivo completo', async () => {
    const objective = 'Corregir la validación ETag de ImportKit conforme a RFC 9110. '.repeat(12);
    orders = [
      {
        ...order,
        objective,
        status: 'blocked',
        phase: 'intake',
        tasks: [],
        questions: [],
        error_code: 'WORKSPACE_SNAPSHOT_FAILED',
        summary: 'No se pudo guardar el resultado del espacio de trabajo.',
      },
    ];
    mockApi();
    const user = await enter();
    await user.click(
      within(screen.getByRole('region', { name: 'Run history' })).getByRole('button', {
        name: /Corregir la validación ETag/,
      }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Patch Importkit' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    expect(screen.getByText('WORKSPACE_SNAPSHOT_FAILED')).toBeVisible();
    expect(screen.getByText('The run is blocked. Review the reason before resuming.')).toBeVisible();
    expect(screen.queryByText('El supervisor prepara el plan')).not.toBeInTheDocument();
    const disclosure = screen.getByText('Full objective').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    await user.click(within(disclosure).getByText('Full objective'));
    expect(disclosure).toHaveAttribute('open');
    expect(within(disclosure).getByText(objective.trim())).toBeVisible();
    expect(writes).toEqual([]);
  });

  it('resuelve HITL con el identificador y revision de la pregunta', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('button', { name: /¿Debe conservarse el formato anterior/ }));
    await user.click(screen.getByRole('button', { name: 'Sí, conservarlo' }));
    await user.click(screen.getByRole('button', { name: 'Answer and continue' }));
    await waitFor(() =>
      expect(writes).toContainEqual({
        path: '/work/work-one/answer',
        body: { question_id: 'question-one', plan_revision: 2, answer: 'Sí, conservarlo' },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Answer and continue' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Work plan' })).toBeVisible();
  });

  it('solo ofrece decisiones pending de la revision actual del plan', async () => {
    orders = [
      {
        ...order,
        questions: [
          { ...order.questions[0], id: 'question-old', plan_revision: 1, prompt: 'Decisión caducada' },
          order.questions[0],
        ],
      },
    ];
    mockApi();
    const user = await enter();
    expect(screen.queryByText('Decisión caducada')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /¿Debe conservarse el formato anterior/ }));
    expect(screen.queryByText('Decisión caducada')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Answer and continue' })).toHaveLength(1);
  });

  it('mantiene visible un error al responder una revision obsoleta', async () => {
    mockApi({
      'POST /work/work-one/answer': {
        status: 409,
        body: {
          detail: { code: 'STALE_REVISION', message: 'La pregunta pertenece a otra revision del plan' },
        },
      },
    });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: /¿Debe conservarse el formato anterior/ }));
    await user.type(screen.getByLabelText('Your answer'), 'Conservar el formato anterior');
    await user.click(screen.getByRole('button', { name: 'Answer and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La pregunta pertenece a otra revision');
    expect(screen.getByLabelText('Your answer')).toHaveValue('Conservar el formato anterior');
  });

  it('pide confirmar la cancelación antes de llamar a la API', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('button', { name: /¿Debe conservarse el formato anterior/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(writes).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(writes).toContainEqual({ path: '/work/work-one/cancel', body: undefined }));
  });

  it('envía un nuevo alcance con control de revision', async () => {
    orders[0].status = 'paused';
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('button', { name: /¿Debe conservarse el formato anterior/ }));
    await user.click(screen.getByText('Change request'));
    await user.clear(screen.getByLabelText('New objective'));
    await user.type(screen.getByLabelText('New objective'), 'Corregir solo los errores de sintaxis');
    await user.click(screen.getByRole('button', { name: 'Update scope' }));
    await waitFor(() =>
      expect(writes).toContainEqual({
        path: '/work/work-one/scope',
        body: {
          expected_revision: 2,
          objective: 'Corregir solo los errores de sintaxis',
          acceptance: ['Rechaza entradas inválidas'],
        },
      }),
    );
  });

  it('exige pausar el encargo antes de aplicar un cambio de alcance', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('button', { name: /¿Debe conservarse el formato anterior/ }));
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
  ] as const)('muestra la solicitud de pausa solo mientras se procesa: %s', async (status, pending) => {
    orders = [{ ...order, status, control: 'pause', questions: [] }];
    mockApi();
    const user = await enter();
    await user.click(
      within(screen.getByRole('region', { name: 'Run history' })).getByRole('button', {
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

  it('crea un encargo con presupuesto explícito, criterios y canal web', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    await user.type(screen.getByLabelText('What do you need?'), 'Añadir validación de entradas');
    await user.type(screen.getByLabelText('Acceptance criteria'), 'Rechaza entradas vacías');
    await user.type(screen.getByLabelText('Maximum budget · USD'), '2');
    await user.click(screen.getByRole('button', { name: 'Launch flow' }));
    await waitFor(() => expect(writes.some((write) => write.path === '/work')).toBe(true));
    const body = writes.find((write) => write.path === '/work')!.body!;
    expect(body).toMatchObject({
      mode: 'patch',
      project_id: project.id,
      objective: 'Añadir validación de entradas',
      acceptance: ['Rechaza entradas vacías'],
      channel: 'web',
      budget: { max_cost_usd: 2, max_calls: 40, max_tokens: 100000, active_seconds: 3600 },
    });
    expect(body.idempotency_key).toMatch(/[a-f0-9-]{36}/);
  });

  it('crea un encargo CLI por agente sin cuotas acumuladas ni autorización de gasto API', async () => {
    mockApi({ 'GET /status': { status: 200, body: cliStatus } });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    expect(screen.getByLabelText('Run controls')).toHaveValue('budget');
    expect(screen.getByLabelText('Tokens')).toHaveValue(100000);
    await user.selectOptions(screen.getByLabelText('Run controls'), 'agent');
    expect(screen.queryByLabelText('Tokens')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Maximum budget · USD')).not.toBeInTheDocument();
    expect(screen.getByText(/50 steps or 10 minutes per agent/)).toBeVisible();
    await user.selectOptions(screen.getByLabelText('Run controls'), 'budget');
    expect(screen.getByLabelText('Tokens')).toHaveValue(100000);
    await user.selectOptions(screen.getByLabelText('Run controls'), 'agent');
    await user.type(screen.getByLabelText('What do you need?'), 'Añadir validación de entradas');
    await user.type(screen.getByLabelText('Acceptance criteria'), 'Rechaza entradas vacías');
    await user.click(screen.getByRole('button', { name: 'Launch flow' }));
    await waitFor(() => expect(writes.find((write) => write.path === '/work')).toBeDefined());
    expect(writes.find((write) => write.path === '/work')!.body?.budget).toEqual({
      max_calls: null,
      max_tokens: null,
      active_seconds: null,
      max_cost_usd: 0,
    });
  });

  it('conserva presupuesto acumulado si un rol utiliza API aunque el modelo principal sea CLI', async () => {
    mockApi({
      'GET /status': {
        status: 200,
        body: { ...cliStatus, roles: { ...cliStatus.roles, reviewer: { provider: 'openai' } } },
      },
    });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    expect(screen.queryByLabelText('Run controls')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Tokens')).toHaveValue(100000);
    expect(screen.getByLabelText('Maximum budget · USD')).toHaveValue(0);
  });

  it.each([false, true])(
    'cambia el control CLI con revision y presupuesto observados, conflicto=%s',
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
                body: { message: 'El presupuesto ha cambiado. Actualiza el encargo.' },
              },
            }
          : {}),
      });
      window.history.replaceState(null, '', '/work/work-one');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: 'Use per-agent controls' }));
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
        expect(await screen.findByRole('alert')).toHaveTextContent('El presupuesto ha cambiado');
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

  it('rechaza comandos no estructurados sin enviarlos al backend', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('link', { name: 'Projects' }));
    await user.click(screen.getByRole('button', { name: '+ Register project' }));
    await user.type(screen.getByLabelText('Project name'), 'Otro proyecto');
    await user.type(screen.getByLabelText('Repository'), 'https://github.com/example/otro');
    await user.clear(screen.getByLabelText('Delivery checks'));
    await user.type(screen.getByLabelText('Delivery checks'), 'npm test');
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('JSON argument array');
    expect(writes).toHaveLength(0);
  });

  it('conserva la clave de idempotencia cuando el envío falla y se reintenta', async () => {
    const mock = mockApi();
    const handler = mock.getMockImplementation()!;
    let submissions = 0;
    mock.mockImplementation(async (input, options = {}) => {
      if (input === '/api/v1/work' && options.method === 'POST' && submissions++ === 0) {
        return Response.json({ message: 'Servicio temporalmente ocupado' }, { status: 503 });
      }
      return handler(input, options);
    });
    const user = await enter();
    await user.click(screen.getByRole('button', { name: '+ New run' }));
    await user.type(screen.getByLabelText('What do you need?'), 'Añadir validación de entradas');
    await user.type(screen.getByLabelText('Acceptance criteria'), 'Rechaza entradas vacías');
    await user.type(screen.getByLabelText('Maximum budget · USD'), '2');
    await user.click(screen.getByRole('button', { name: 'Launch flow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Servicio temporalmente ocupado');
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

  it('permite aprobar e invalidar un recuerdo conservando su procedencia', async () => {
    memory = [
      {
        id: 'memory-one',
        project_id: project.id,
        kind: 'lesson',
        content: 'Conservar el contrato de importación',
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
    await user.click(await screen.findByRole('button', { name: 'Approve memory' }));
    await screen.findByText('Active');
    expect(screen.getByText('abc123')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Invalidate' }));
    await screen.findByText('Invalidated');
    expect(writes.map((write) => write.path)).toEqual([
      '/memory/memory-one/approve',
      '/memory/memory-one/invalidate',
    ]);
  });

  it('muestra la cadena de seguridad sin afirmar una aprobación inexistente', async () => {
    mockApi();
    const user = await enter();
    await user.click(screen.getByRole('button', { name: /¿Debe conservarse el formato anterior/ }));
    const security = screen.getByRole('heading', { name: 'Security pipeline' }).closest('section')!;
    expect(within(security).getByText(/has not produced a result for this delivery/)).toBeVisible();
  });

  it('aprueba una excepción ligada al hallazgo, snapshot, reglas y revision y permite revocarla', async () => {
    const snapshot = 'a'.repeat(64);
    const finding = {
      fingerprint: 'vulnerability-one',
      scanner: 'trivy',
      category: 'vulnerability',
      severity: 'high',
      title: 'Vulnerability con mitigación revisada',
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
      within(screen.getByRole('region', { name: 'Run history' })).getByRole('button', {
        name: new RegExp(order.objective),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Temporary security exception' }));
    await user.selectOptions(screen.getByLabelText('Finding'), finding.fingerprint);
    const justification = 'Mitigación temporal verificada por el propietario.';
    await user.type(screen.getByLabelText('Exception justification'), justification);
    const expiry = '2026-11-20T12:30';
    fireEvent.change(screen.getByLabelText('Caducidad · hora local'), { target: { value: expiry } });
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
    expect(await screen.findByText(/^Revocada /)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Revoke exception' })).not.toBeInTheDocument();
  });

  it.each(['secret', 'scanner_error'])('no ofrece excepciones para un hallazgo %s', async (category) => {
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
            title: 'Finding que exige corrección',
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
      within(screen.getByRole('region', { name: 'Run history' })).getByRole('button', {
        name: new RegExp(order.objective),
      }),
    );
    expect(screen.queryByRole('button', { name: 'Temporary security exception' })).not.toBeInTheDocument();
  });

  it('no ofrece aprobación sin version de reglas de seguridad', async () => {
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
            title: 'Finding sin reglas vinculadas',
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
      within(screen.getByRole('region', { name: 'Run history' })).getByRole('button', {
        name: new RegExp(order.objective),
      }),
    );
    expect(screen.queryByRole('button', { name: 'Temporary security exception' })).not.toBeInTheDocument();
  });

  it.each(['blocked', 'failed'])(
    'muestra vigilancia %s como propuestas de remediación sin reanudar ni cambiar alcance',
    async (status) => {
      orders = [
        {
          ...order,
          mode: 'maintain',
          phase: 'security_watch',
          status,
          questions: [],
          tasks: [{ ...order.tasks[0], title: 'Refresh la dependencia vulnerable' }],
        },
      ];
      mockApi();
      const user = await enter();
      await user.click(
        within(screen.getByRole('region', { name: 'Run history' })).getByRole('button', {
          name: new RegExp(order.objective),
        }),
      );
      expect(screen.getByRole('heading', { name: 'Remediation proposals' })).toBeVisible();
      expect(screen.getByRole('heading', { level: 1, name: 'Monitoring Importkit' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
      expect(screen.queryByText('Change request')).not.toBeInTheDocument();
      expect(writes).toEqual([]);
    },
  );
});

describe('Cliente API', () => {
  it('explica errores de red sin esconderlos como una lista vacía', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(createApi('test').projects()).rejects.toThrow('SABRE is unreachable');
  });
});

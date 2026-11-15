import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { createApi, type Project, type WorkOrder } from '../api';
import ProjectsView from '../features/projects/ProjectsView';
import RunsTable from '../features/runs/RunsTable';

const base = {
  id: 'project-one',
  name: 'Altimeter',
  repository: 'https://github.com/example/altimeter',
  profile: 'node',
  default_branch: 'main',
  gate_commands: [
    ['npm', 'test'],
    ['npm', 'run', 'typecheck'],
  ],
  allowed_mcp_servers: [],
  approved_baseline: [],
  browser_preview: null,
  revision: 2,
  archived_at: null,
  created_at: '2026-11-11T12:00:00Z',
} satisfies Project;
const retired: Project = {
  ...base,
  id: 'project-two',
  name: 'Reference audit',
  repository: 'https://github.com/example/reference',
  revision: 5,
  archived_at: '2026-11-13T09:00:00Z',
};

/** Only the fields the runs list reads. */
const run = (id: string, project: Project, status = 'completed') =>
  ({
    id,
    project_id: project.id,
    mode: 'audit',
    objective: `Audit ${project.name}`,
    status,
    phase: 'delivery',
    plan_revision: 1,
    questions: [],
    tokens_used: 1200,
    control: null,
    evidence: null,
    budget: { max_calls: 40, max_tokens: 100000, max_cost_usd: 0, active_seconds: 3600, policy: null },
    updated_at: '2026-11-13T10:00:00Z',
    created_at: '2026-11-13T09:00:00Z',
  }) as unknown as WorkOrder;

/** The record of a scheduled security review, as the application lists it. */
const review = (id: string, status: string): WorkOrder => ({
  ...run(id, base, status),
  mode: 'maintain',
  phase: 'security_watch',
  objective: 'Security review scheduled',
});

type Call = { method: string; path: string; body: unknown };

/** A synthetic control service whose answers a test can replace per request. */
function service(respond: (call: Call) => Response | undefined = () => undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      const call = {
        method: request.method ?? 'GET',
        path: input.replace('/api/v1', ''),
        body: request.body ? JSON.parse(String(request.body)) : null,
      };
      calls.push(call);
      return respond(call) ?? Response.json({ ...base, revision: base.revision + 1 });
    }),
  );
  return calls;
}

/** The view with the list its parent holds; `reloaded` stands for the parent reading the projects again. */
function Harness({ initial, reloaded }: { initial: Project[]; reloaded?: () => Project[] }) {
  const [projects, setProjects] = useState(initial);
  const [state, setState] = useState({ busy: false, dirty: false });
  return (
    <ProjectsView
      api={createApi('synthetic-csrf')}
      projects={projects}
      orders={[run('run-one', base), run('run-two', retired)]}
      connected
      open={false}
      onOpenChange={() => undefined}
      draftState={state}
      onDraftState={setState}
      onRegistered={async () => {
        if (reloaded) setProjects(reloaded());
      }}
      onCreateRun={() => undefined}
    />
  );
}

it('shows active projects and keeps archived ones behind an explicit filter, with restore', async () => {
  const user = userEvent.setup();
  const calls = service();
  render(
    <Harness
      initial={[base, retired]}
      reloaded={() => [base, { ...retired, revision: 6, archived_at: null }]}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Altimeter' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Reference audit' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Show archived (1)' }));
  const archived = screen.getByRole('region', { name: 'Archived' });
  expect(within(archived).getByRole('heading', { name: 'Reference audit' })).toBeVisible();
  expect(within(archived).getByText(/1 runs · archived Nov 13, 2026/)).toBeVisible();
  // An archived project offers nothing but restoring it.
  expect(within(archived).queryByRole('button', { name: /Create run|Edit|Archive/ })).not.toBeInTheDocument();
  await user.click(within(archived).getByRole('button', { name: 'Restore Reference audit' }));
  await waitFor(() =>
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/projects/project-two/restore',
      body: { expected_revision: 5 },
    }),
  );
  expect(await screen.findByText('Reference audit restored.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Archive Reference audit' })).toBeVisible();
  expect(screen.queryByRole('checkbox', { name: /Show archived/ })).not.toBeInTheDocument();
});

it('edits the editable part of a project and keeps what was typed when the revision is stale', async () => {
  const user = userEvent.setup();
  let refuse = true;
  const calls = service((call) => {
    if (call.method !== 'PUT') return undefined;
    if (!refuse) return undefined;
    refuse = false;
    return Response.json(
      { code: 'PROJECT_CHANGED', message: 'The project changed; refresh it before continuing' },
      { status: 409 },
    );
  });
  render(<Harness initial={[base]} reloaded={() => [{ ...base, revision: 3 }]} />);
  await user.click(screen.getByRole('button', { name: 'Edit Altimeter' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit Altimeter' });
  expect(within(dialog).getByLabelText('Project name')).toHaveValue('Altimeter');
  expect(within(dialog).getByLabelText('Base branch')).toHaveValue('main');
  expect(within(dialog).getByLabelText('Delivery checks')).toHaveValue(
    '["npm","test"]\n["npm","run","typecheck"]',
  );
  // The address identifies the project: shown, never sent.
  expect(within(dialog).getByLabelText('Repository')).toHaveAttribute('readonly');
  expect(within(dialog).queryByText('External tools and security baseline')).not.toBeInTheDocument();

  const checks = within(dialog).getByLabelText('Delivery checks');
  await user.clear(checks);
  await user.click(checks);
  await user.paste('["npm","run","check"]');
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('The project changed');
  expect(within(dialog).getByLabelText('Delivery checks')).toHaveValue('["npm","run","check"]');

  // The parent has read the project again, so the same form now carries the current revision.
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Edit Altimeter' })).not.toBeInTheDocument(),
  );
  const edit = {
    name: 'Altimeter',
    profile: 'node',
    default_branch: 'main',
    gate_commands: [['npm', 'run', 'check']],
    browser_preview: null,
  };
  expect(calls.filter((call) => call.method === 'PUT')).toEqual([
    { method: 'PUT', path: '/projects/project-one', body: { expected_revision: 2, ...edit } },
    { method: 'PUT', path: '/projects/project-one', body: { expected_revision: 3, ...edit } },
  ]);
  expect(screen.getByText('Altimeter saved.')).toBeVisible();
});

it('rejects a check that is not an argument array before sending anything', async () => {
  const user = userEvent.setup();
  const calls = service();
  render(<Harness initial={[base]} />);
  await user.click(screen.getByRole('button', { name: 'Edit Altimeter' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit Altimeter' });
  const checks = within(dialog).getByLabelText('Delivery checks');
  await user.clear(checks);
  await user.click(checks);
  await user.paste('npm test');
  await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Each check must be a JSON argument array',
  );
  expect(calls).toEqual([]);
});

it('archives after confirmation and shows why a project with an open run cannot be archived', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  const calls = service((call) => {
    if (!call.path.endsWith('/archive')) return undefined;
    attempts += 1;
    if (attempts > 1) return undefined;
    return Response.json(
      {
        code: 'PROJECT_HAS_OPEN_RUNS',
        message: 'Run 92d64ad6 is not finished; cancel it or let it finish before archiving',
      },
      { status: 409 },
    );
  });
  render(
    <Harness
      initial={[base]}
      reloaded={() =>
        attempts > 1 ? [{ ...base, revision: 3, archived_at: '2026-11-14T10:00:00Z' }] : [base]
      }
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Archive Altimeter' }));
  const dialog = screen.getByRole('dialog', { name: 'Archive Altimeter' });
  expect(within(dialog).getByText(/Its runs, memory and evidence are kept/)).toBeVisible();
  // Opening the confirmation changes nothing.
  expect(calls).toEqual([]);
  await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Run 92d64ad6 is not finished');
  expect(screen.getByRole('heading', { name: 'Altimeter' })).toBeVisible();

  await user.click(within(dialog).getByRole('button', { name: 'Archive project' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Archive Altimeter' })).not.toBeInTheDocument(),
  );
  expect(calls.filter((call) => call.method === 'POST')).toEqual([
    { method: 'POST', path: '/projects/project-one/archive', body: { expected_revision: 2 } },
    { method: 'POST', path: '/projects/project-one/archive', body: { expected_revision: 2 } },
  ]);
  expect(screen.getByText('Altimeter archived. Its runs and memory are kept.')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'No active project' })).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'Show archived (1)' })).not.toBeChecked();
});

it('leaves the runs of an archived project out of the list until that project is chosen', async () => {
  const user = userEvent.setup();
  service();
  render(
    <MemoryRouter>
      <RunsTable
        api={createApi('synthetic-csrf')}
        orders={[run('run-one', base, 'running'), run('run-two', retired, 'blocked')]}
        projects={[retired, base]}
        onNew={() => undefined}
        onChanged={async () => undefined}
        now={new Date('2026-11-13T12:00:00Z').getTime()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('Audit Altimeter')).toBeVisible();
  expect(screen.queryByText('Audit Reference audit')).not.toBeInTheDocument();
  // Counts follow the list: the archived project's blocked run does not ask for attention.
  expect(within(screen.getByRole('button', { name: 'All' })).getByText('1')).toBeInTheDocument();
  expect(within(screen.getByRole('button', { name: 'Needs you' })).getByText('0')).toBeInTheDocument();
  const filter = screen.getByRole('combobox', { name: 'Project' });
  expect(
    within(filter)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['All projects', 'Altimeter', 'Reference audit (archived)']);
  await user.selectOptions(filter, 'project-two');
  expect(screen.getByText('Audit Reference audit')).toBeVisible();
  expect(screen.queryByText('Audit Altimeter')).not.toBeInTheDocument();
});

it('shows the daily security review as monitoring: no delivery, no pause, and its own label', () => {
  service();
  render(
    <MemoryRouter>
      <RunsTable
        api={createApi('synthetic-csrf')}
        orders={[
          run('delivered', base, 'completed'),
          review('review-done', 'completed'),
          review('review-now', 'running'),
        ]}
        projects={[base]}
        onNew={() => undefined}
        onChanged={async () => undefined}
        now={new Date('2026-11-13T12:00:00Z').getTime()}
      />
    </MemoryRouter>,
  );
  const summary = screen.getByRole('region', { name: 'Runs summary' });
  // One run delivered this week. The review that finished delivered nothing.
  expect(within(summary).getByText('Delivered · 7 days').closest('div')).toHaveTextContent(
    /^Delivered · 7 days1/,
  );
  const rows = screen.getAllByTestId('run-row');
  expect(rows).toHaveLength(3);
  const [, done, running] = rows;
  expect(within(done).getByText('Monitoring')).toBeVisible();
  expect(within(done).queryByText('Maintain')).not.toBeInTheDocument();
  // A review cannot be paused: the application refuses, so the list does not offer it.
  expect(within(running).queryByRole('button', { name: /^Pause run/ })).not.toBeInTheDocument();
  // The owner has launched a run, so the page no longer offers the first one.
  expect(screen.queryByRole('button', { name: 'Create your first run' })).not.toBeInTheDocument();
});

it("keeps the way to a first run in view while the only records are the factory's own reviews", () => {
  service();
  render(
    <MemoryRouter>
      <RunsTable
        api={createApi('synthetic-csrf')}
        orders={[review('review-only', 'completed')]}
        projects={[base]}
        onNew={() => undefined}
        onChanged={async () => undefined}
        now={new Date('2026-11-13T12:00:00Z').getTime()}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('button', { name: 'Create your first run' })).toBeVisible();
  expect(screen.getAllByTestId('run-row')).toHaveLength(1);
});

/** The view with the Add project dialog its parent opens and closes. */
function AddHarness() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ busy: false, dirty: false });
  return (
    <ProjectsView
      api={createApi('synthetic-csrf')}
      projects={[base]}
      orders={[]}
      connected
      open={open}
      onOpenChange={(next) => setOpen(next)}
      draftState={state}
      onDraftState={setState}
      onRegistered={async () => undefined}
      onCreateRun={() => undefined}
    />
  );
}

const reading = {
  id: 'github.read',
  kind: 'github',
  title: 'GitHub · read repositories',
  description: 'Browse repositories.',
  enabled: true,
  revision: 0,
  toggleable: true,
  credential_ids: ['github.read'],
  credential_configured: false,
  access: 'Public access.',
  tools: [],
};
const connection = (state: 'not_connected' | 'connected') => ({
  version: 1,
  state,
  app: null,
  account:
    state === 'connected'
      ? { login: 'octo-fixture', type: 'Organization', repository_selection: 'selected' }
      : null,
  install_url: null,
  manage_url: null,
});

/** What the dialog asks the factory before it can say where a project may come from. */
function sources(state: 'not_connected' | 'connected') {
  return service((call) => {
    if (call.path === '/github/connection') return Response.json(connection(state));
    if (call.path === '/integrations') return Response.json([reading]);
    if (call.path === '/repository-proposals') return Response.json({ items: [], truncated: false });
    if (call.path.startsWith('/github/connection/repositories'))
      return Response.json({
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
      });
    return undefined;
  });
}

const pressed = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .map((button) => [button.textContent, button.getAttribute('aria-pressed')]);

it('adds a project from one place with three sources and keeps a draft while another source is looked at', async () => {
  const user = userEvent.setup();
  sources('not_connected');
  render(<AddHarness />);
  await user.click(screen.getByRole('button', { name: '+ Add project' }));
  const dialog = screen.getByRole('dialog', { name: 'Add project' });
  const group = within(dialog).getByRole('group', { name: 'Where the project comes from' });
  // With no app installed the address form comes first.
  expect(pressed(group)).toEqual([
    ['From GitHub', 'false'],
    ['By address', 'true'],
    ['New repository', 'false'],
  ]);
  await user.type(within(dialog).getByLabelText('Project name'), 'Draft name');

  // While only tokens are configured, GitHub is browsed by account.
  await user.click(within(group).getByRole('button', { name: 'From GitHub' }));
  expect(await within(dialog).findByRole('button', { name: 'Search repositories' })).toBeEnabled();
  expect(within(dialog).queryByRole('button', { name: 'Propose repository' })).not.toBeInTheDocument();

  // A new repository is proposed here too, with its own approval and single attempt.
  await user.click(within(group).getByRole('button', { name: 'New repository' }));
  expect(await within(dialog).findByRole('button', { name: 'Propose repository' })).toBeVisible();
  expect(within(dialog).getByText('Create a repository and launch its flow')).toBeVisible();
  expect(within(dialog).queryByRole('button', { name: 'Search repositories' })).not.toBeInTheDocument();

  await user.click(within(group).getByRole('button', { name: 'By address' }));
  expect(within(dialog).getByLabelText('Project name')).toHaveValue('Draft name');
});

it("starts from the repositories of the GitHub connection once the app is installed and keeps the owner's own choice", async () => {
  const user = userEvent.setup();
  sources('connected');
  render(<AddHarness />);
  await user.click(screen.getByRole('button', { name: '+ Add project' }));
  const dialog = screen.getByRole('dialog', { name: 'Add project' });
  const group = within(dialog).getByRole('group', { name: 'Where the project comes from' });
  expect(await within(dialog).findByText(/2 repositories through the GitHub\s+connection/)).toBeVisible();
  expect(pressed(group)[0]).toEqual(['From GitHub', 'true']);
  expect(within(dialog).getByRole('button', { name: 'Import octo-fixture/widgets' })).toBeEnabled();
  // The account search belongs to the token path.
  expect(within(dialog).queryByRole('button', { name: 'Search repositories' })).not.toBeInTheDocument();
  await user.click(within(group).getByRole('button', { name: 'By address' }));
  await waitFor(() => expect(pressed(group)[1]).toEqual(['By address', 'true']));
});

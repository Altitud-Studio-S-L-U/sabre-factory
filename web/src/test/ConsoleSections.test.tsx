import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import {
  createApi,
  type ConfigurationView,
  type FactoryConfiguration,
  type Project,
  type ProjectKnowledgeReport,
} from '../api';
import ConfigConsole from '../ConfigConsole';
import MemoryConsole from '../MemoryConsole';
import ToolsConsole from '../ToolsConsole';
import { configuration } from './modelConfigurationFixture';
import BudgetFields, { defaultBudgetPolicy } from '../components/BudgetFields';

/** The token a save sends back: the saved revision (3) and the model revision (7) in one number. */
const SAVE_TOKEN = 3 * 2 ** 32 + 7;

const project = {
  id: 'synthetic-project',
  name: 'Synthetic project',
  repository: 'https://github.com/example/synthetic',
  profile: 'node',
  default_branch: 'main',
  gate_commands: [['npm', 'test']],
  allowed_mcp_servers: [],
  approved_baseline: [],
  browser_preview: null,
  created_at: '2026-11-11T12:00:00Z',
  revision: 0,
  archived_at: null,
} satisfies Project;
const models = configuration();
function factory(): ConfigurationView {
  const value: FactoryConfiguration = {
    version: 1,
    models: {
      default: models.default,
      roles: Object.fromEntries(models.roles.map((role) => [role.role, null])),
    },
    flows: Object.fromEntries(
      ['patch', 'maintain', 'create', 'audit'].map((name) => [
        name,
        {
          version: 1 as const,
          phases: {},
          phase_models: {},
          permissions: { architecture: true, dependency_changes: false, draft_pull_request: true },
          repair_cycles: 2,
          budget_policy: null,
        },
      ]),
    ),
    policies: [
      {
        version: 1,
        id: 'verification',
        domain: 'security',
        mode: 'required',
        value: 'required',
        validator: 'registered_checks',
      },
    ],
    context: { deduplicate: true, archive_reads: true, max_input_bytes: 98304 },
  };
  return {
    version: 1,
    // What the application answers after three saves and seven model edits: a token, and the revision.
    revision: SAVE_TOKEN,
    saved_revision: 3,
    configuration: value,
    yaml: JSON.stringify(value, null, 2),
    readiness: [
      {
        id: 'model',
        status: 'missing',
        message: 'Model access has not been checked',
        action: 'Choose an explicit model',
      },
    ],
  };
}

it('marks the saved revision as current in the history, whatever the save token is', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.includes('/configuration/history'))
        return Response.json({
          truncated: false,
          items: [3, 2, 1].map((revision) => ({
            revision,
            created_at: `2026-11-1${revision}T09:00:00Z`,
            changed_paths: ['flows.patch.repair_cycles'],
            changed_paths_truncated: false,
            summary: 'Changed flows.patch.repair_cycles',
          })),
        });
      if (input.endsWith('/model-configuration')) return Response.json(configuration());
      if (input.endsWith('/integrations')) return Response.json([]);
      return Response.json(factory());
    }),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ConfigConsole api={createApi('synthetic-csrf')} projects={[project]} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'History' }));
  const current = await screen.findByText('current');
  expect(current.closest('li')).toHaveTextContent('Revision 3');
  expect(screen.getAllByText('current')).toHaveLength(1);
});

it('validates the same configuration document and retains the model draft after a revision conflict', async () => {
  const user = userEvent.setup();
  const writes: Record<string, unknown>[] = [];
  const current = factory();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      if (input.endsWith('/model-configuration')) return Response.json(models);
      if (input.endsWith('/integrations')) return Response.json([]);
      if (input.endsWith('/configuration/preview')) {
        const body = JSON.parse(String(request.body));
        const next = JSON.parse(body.document);
        return Response.json({
          version: 1,
          valid: true,
          configuration: next,
          yaml: JSON.stringify(next),
          diagnostics: [],
          safe_diff: [
            {
              path: 'models.default.name',
              before: JSON.stringify(models.default.name),
              after: JSON.stringify(next.models.default.name),
            },
          ],
        });
      }
      if (request.method === 'PUT') {
        writes.push(JSON.parse(String(request.body)));
        return Response.json(
          { message: 'Configuration changed in another session. Draft retained.' },
          { status: 409 },
        );
      }
      return Response.json(current);
    }),
  );
  render(
    <MemoryRouter>
      <ConfigConsole api={createApi('synthetic-csrf')} projects={[project]} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'Models' }));
  const name = screen.getByRole('textbox', { name: 'Model identifier' });
  await user.clear(name);
  await user.type(name, 'synthetic-draft-model');
  await user.click(screen.getByRole('button', { name: 'Validate & preview' }));
  expect(await screen.findByText('Schema validated')).toBeVisible();
  await user.click(screen.getByRole('checkbox', { name: /I approve the listed model data destinations/ }));
  await user.click(screen.getByRole('button', { name: 'Save configuration' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Draft retained');
  expect(name).toHaveValue('synthetic-draft-model');
  expect(writes).toHaveLength(1);
  // The save carries the token; the page shows the revision an owner can find in the history.
  expect(writes[0].expected_revision).toBe(SAVE_TOKEN);
  expect(screen.getByText('Revision 3')).toBeVisible();
  expect(screen.queryByText(new RegExp(String(SAVE_TOKEN)))).not.toBeInTheDocument();
  expect(String(writes[0].document)).toContain('synthetic-draft-model');
  expect(writes[0]).not.toHaveProperty('api_key');
});

it('writes the effort of the default model into the document, only for a provider that takes one', async () => {
  const user = userEvent.setup();
  const previews: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      if (input.endsWith('/model-configuration')) return Response.json(models);
      if (input.endsWith('/integrations')) return Response.json([]);
      if (input.endsWith('/configuration/preview')) {
        const body = JSON.parse(String(request.body));
        previews.push(body.document);
        const next = JSON.parse(body.document);
        return Response.json({
          version: 1,
          valid: true,
          configuration: next,
          yaml: JSON.stringify(next),
          diagnostics: [],
          safe_diff: [],
        });
      }
      return Response.json(factory());
    }),
  );
  render(
    <MemoryRouter>
      <ConfigConsole api={createApi('synthetic-csrf')} projects={[project]} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'Models' }));
  await user.click(screen.getByText('Advanced model settings'));
  const effective = screen.getByRole('complementary', { name: 'What the factory will use' });
  // A Codex session is the default here: it takes a level, and none is named yet.
  expect(screen.getByLabelText('Reasoning effort')).toHaveValue('');
  expect(within(effective).getByText('Effort').nextElementSibling).toHaveTextContent('Provider default');
  await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'minimal');
  expect(within(effective).getByText('Effort').nextElementSibling).toHaveTextContent('Minimal');

  // The other CLI has its own levels: the one chosen for Codex is not carried over.
  await user.selectOptions(screen.getByRole('combobox', { name: 'Model provider' }), 'claude_cli');
  await user.type(screen.getByRole('textbox', { name: 'Model identifier' }), 'claude-fixture');
  expect(screen.getByLabelText('Reasoning effort')).toHaveValue('');
  expect(within(effective).getByText('Effort').nextElementSibling).toHaveTextContent('Provider default');
  await user.selectOptions(screen.getByLabelText('Reasoning effort'), 'xhigh');
  expect(within(effective).getByText('Effort').nextElementSibling).toHaveTextContent('Extra high');
  await user.click(screen.getByRole('button', { name: 'Validate & preview' }));
  await waitFor(() => expect(previews).toHaveLength(1));
  expect(JSON.parse(previews[0]).models.default).toMatchObject({
    provider: 'claude_cli',
    name: 'claude-fixture',
    effort: 'xhigh',
  });

  // An API provider has no such control here: the level is not carried along, and the document names none.
  await user.selectOptions(screen.getByRole('combobox', { name: 'Model provider' }), 'anthropic');
  await user.type(screen.getByRole('textbox', { name: 'Model identifier' }), 'api-fixture');
  expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument();
  expect(within(effective).queryByText('Effort')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Validate & preview' }));
  await waitFor(() => expect(previews).toHaveLength(2));
  expect(JSON.parse(previews[1]).models.default).toMatchObject({
    provider: 'anthropic',
    name: 'api-fixture',
  });
  expect(JSON.parse(previews[1]).models.default).not.toHaveProperty('effort');
});

it.each(['models', 'provider'])('a link to %s opens the Models view of Config', async (section) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      if (input.endsWith('/model-configuration')) return Response.json(models);
      if (input.endsWith('/integrations')) return Response.json([]);
      return Response.json(factory());
    }),
  );
  window.history.replaceState(null, '', `/config?section=${section}`);
  render(
    <MemoryRouter>
      <ConfigConsole api={createApi('synthetic-csrf')} projects={[project]} />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('button', { name: 'Models' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('textbox', { name: 'Model identifier' })).toBeVisible();
  window.history.replaceState(null, '', '/');
});

it('reports field diagnostics and blocks saving invalid YAML without erasing the document', async () => {
  const user = userEvent.setup();
  const current = factory();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.endsWith('/model-configuration')
        ? Response.json(models)
        : input.endsWith('/integrations')
          ? Response.json([])
          : input.endsWith('/preview')
            ? Response.json({
                version: 1,
                valid: false,
                configuration: null,
                yaml: null,
                safe_diff: [],
                diagnostics: [{ path: 'document', message: 'Duplicate key rejected' }],
              })
            : Response.json(current),
    ),
  );
  render(
    <MemoryRouter>
      <ConfigConsole api={createApi('synthetic-csrf')} projects={[]} />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'YAML / JSON' }));
  const document = screen.getByLabelText('Configuration document');
  await user.clear(document);
  await user.type(document, 'version: 1\nversion: 1');
  await user.click(screen.getByRole('button', { name: 'Validate & preview' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Duplicate key rejected');
  expect(document).toHaveValue('version: 1\nversion: 1');
  expect(screen.getByRole('button', { name: 'Download document' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Save configuration' })).not.toBeInTheDocument();
});

it('keeps model providers out of Tools and changes only the chosen adapter revision', async () => {
  const user = userEvent.setup();
  const writes: unknown[] = [];
  const item = {
    id: 'github.read',
    kind: 'github',
    title: 'Synthetic GitHub read',
    description: 'Read source only',
    enabled: false,
    revision: 3,
    toggleable: true,
    credential_ids: ['github.read'],
    credential_configured: true,
    access: 'Read scoped repositories',
    tools: [{ name: 'github_read', effect: 'read', roles: ['analyst'] }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      if (input.endsWith('/state')) {
        writes.push(JSON.parse(String(request.body)));
        // The first attempt meets a newer revision saved by another session.
        if (writes.length === 1)
          return Response.json({ message: 'The connection changed; refresh its state.' }, { status: 409 });
        return Response.json({ ...item, enabled: true, revision: 4 });
      }
      if (input.endsWith('/integrations'))
        return Response.json([
          item,
          { ...item, id: 'model.openai', kind: 'model', title: 'Model provider hidden' },
        ]);
      if (input.endsWith('/mcp-connections')) return Response.json([]);
      // The console reads the GitHub connection too; here no app is connected.
      if (input.endsWith('/github/connection'))
        return Response.json({
          version: 1,
          state: 'not_connected',
          app: null,
          account: null,
          install_url: null,
          manage_url: null,
        });
      if (input.endsWith('/repository-proposals')) return Response.json({ items: [], truncated: false });
      if (input.endsWith('/tools/catalog'))
        return Response.json({
          version: 1,
          items: [
            {
              name: 'read_source',
              description: 'Bounded source read',
              effect: 'read',
              roles: ['analyst'],
              scope: 'workspace',
              source: 'builtin',
            },
          ],
        });
      return Response.json([]);
    }),
  );
  const view = render(<ToolsConsole api={createApi('synthetic-csrf')} projects={[project]} />);
  await screen.findByRole('heading', { name: 'Synthetic GitHub read' });
  expect(screen.queryByText('Model provider hidden')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Enable Synthetic GitHub read' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The connection changed');
  // A refused change keeps the confirmed state: the connection still reads as disabled.
  await user.click(screen.getByRole('button', { name: 'Enable Synthetic GitHub read' }));
  await waitFor(() =>
    expect(writes).toEqual([
      { enabled: true, expected_revision: 3 },
      { enabled: true, expected_revision: 3 },
    ]),
  );
  expect(await screen.findByRole('button', { name: 'Disable Synthetic GitHub read' })).toBeEnabled();
  await user.click(screen.getByRole('tab', { name: /^Built-in tools/ }));
  expect(screen.getByRole('heading', { name: 'read_source' })).toBeVisible();
  view.rerender(<ToolsConsole api={createApi('synthetic-csrf')} projects={[project]} connected={false} />);
  await user.click(screen.getByRole('tab', { name: /^MCP servers/ }));
  expect(screen.getByRole('button', { name: 'Add MCP server' })).toBeDisabled();
  await user.click(screen.getByRole('tab', { name: 'GitHub' }));
  // The new client reads the catalog again, so the switch may show either state; it is locked in both.
  expect(screen.getByRole('button', { name: /^(Enable|Disable) Synthetic GitHub read$/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Replace token for Synthetic GitHub read' })).toBeDisabled();
});

it('shows memory provenance by project and keeps proposals separate from approved facts', async () => {
  const user = userEvent.setup();
  const knowledge = {
    project_id: project.id,
    profile: 'node',
    gate_count: 1,
    memories: { total: 2, active: 1, pending: 1, invalidated: 0 },
    checkpoints: { count: 0, threads: 0 },
    context: null,
    semantic_search: false,
    truncated: false,
  } satisfies ProjectKnowledgeReport;
  const base = {
    project_id: project.id,
    kind: 'lesson',
    source_commit: 'a'.repeat(40),
    source_work_id: 'synthetic-run',
    evidence_digest: null,
    created_at: '2026-11-11T12:00:00Z',
    approved_at: null,
    invalidated_at: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      input.includes('/knowledge')
        ? Response.json(knowledge)
        : Response.json([
            { ...base, id: 'approved', content: 'Synthetic reviewed lesson', active: true },
            { ...base, id: 'proposal', content: 'Synthetic proposal', active: false },
            {
              ...base,
              project_id: 'other-project',
              id: 'other',
              content: 'Other project must not appear',
              active: true,
            },
          ]),
    ),
  );
  render(<MemoryConsole api={createApi('synthetic-csrf')} projects={[project]} connected={false} />);
  await user.click(await screen.findByRole('tab', { name: 'Records' }));
  expect(await screen.findByText('Synthetic reviewed lesson')).toBeVisible();
  expect(screen.queryByText('Synthetic proposal')).not.toBeInTheDocument();
  expect(screen.queryByText('Other project must not appear')).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Review queue' }));
  expect(screen.getByRole('tab', { name: 'Review queue' })).toHaveAttribute('aria-selected', 'true');
  await user.click(screen.getByRole('button', { name: 'Inspect memory proposal' }));
  const dialog = screen.getByRole('dialog', { name: 'Memory provenance' });
  expect(within(dialog).getByText('synthetic-run')).toBeVisible();
  expect(within(dialog).getByRole('button', { name: 'Approve memory' })).toBeDisabled();
});

it('queues real repository ingestion without claiming completion and displays retained source metadata', async () => {
  const user = userEvent.setup();
  const writes: Record<string, unknown>[] = [];
  const knowledge: ProjectKnowledgeReport = {
    project_id: project.id,
    profile: 'node',
    gate_count: 1,
    memories: { total: 0, active: 0, pending: 0, invalidated: 0 },
    checkpoints: { count: 0, threads: 0 },
    context: null,
    semantic_search: false,
    truncated: false,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      if (input.includes('/knowledge')) return Response.json(knowledge);
      if (input.includes('/ingestion')) {
        if (request.method === 'POST') {
          writes.push(JSON.parse(String(request.body)));
          return Response.json({
            version: 1,
            id: 'synthetic-job',
            project_id: project.id,
            index_version: 1,
            state: 'queued',
            source_commit: null,
            expected_source_commit: null,
            created_at: '2026-11-11T12:00:00Z',
            finished_at: null,
            error_code: null,
            error_message: null,
          });
        }
        return Response.json({ version: 1, project_id: project.id, jobs: [], latest: null });
      }
      return Response.json([]);
    }),
  );
  render(<MemoryConsole api={createApi('synthetic-csrf')} projects={[project]} />);
  await screen.findByRole('button', { name: 'Read the repository' });
  expect(screen.getByText(/has not been read yet, so the factory knows nothing/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Read the repository' }));
  expect(await screen.findByRole('button', { name: 'Reading…' })).toBeDisabled();
  expect(
    screen.getByText(/Reading the repository. Admission scanning runs before anything is kept/),
  ).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].version).toBe(1);
  expect(writes[0].idempotency_key).toMatch(/^operator:/);
  expect(screen.getByText('Not recorded')).toBeVisible();
});

it('keeps zero repair authority distinct from an uncapped metric and finite reserve', async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const view = render(<BudgetFields value={defaultBudgetPolicy} onChange={changed} />);
  await user.selectOptions(screen.getByLabelText('Tokens policy'), 'uncapped');
  expect(changed).toHaveBeenLastCalledWith({
    ...defaultBudgetPolicy,
    tokens: { primary: null, reserve: 0, absolute: null },
  });
  await user.selectOptions(screen.getByLabelText('Model invocations policy'), 'reserve');
  expect(changed).toHaveBeenLastCalledWith({
    ...defaultBudgetPolicy,
    invocations: { primary: 40, reserve: 20, absolute: 60 },
  });
  view.rerender(
    <BudgetFields
      value={{ ...defaultBudgetPolicy, repairs: { primary: 0, reserve: 0, absolute: 0 } }}
      onChange={changed}
    />,
  );
  expect(screen.getByLabelText('Repair cycles primary ceiling')).toHaveValue(0);
  expect(screen.getByText(/Zero repairs permits no repair attempts/)).toBeVisible();
});

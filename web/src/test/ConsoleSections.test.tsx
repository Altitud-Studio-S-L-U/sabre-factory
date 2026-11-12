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
    revision: 7,
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
  await user.click(await screen.findByRole('button', { name: '02 · Choose model' }));
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
  expect(writes[0].expected_revision).toBe(7);
  expect(String(writes[0].document)).toContain('synthetic-draft-model');
  expect(writes[0]).not.toHaveProperty('api_key');
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

it('keeps model providers out of Tools and changes only the inspected adapter revision', async () => {
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
        return Response.json({ ...item, enabled: true, revision: 4 });
      }
      if (input.endsWith('/integrations'))
        return Response.json([
          item,
          { ...item, id: 'model.openai', kind: 'model', title: 'Model provider hidden' },
        ]);
      if (input.endsWith('/mcp-connections')) return Response.json([]);
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
  await user.click(screen.getByRole('button', { name: 'Enable connection' }));
  await waitFor(() => expect(writes).toEqual([{ enabled: true, expected_revision: 3 }]));
  await user.click(screen.getByRole('button', { name: 'Built-in tools' }));
  expect(screen.getByRole('heading', { name: 'read_source' })).toBeVisible();
  view.rerender(<ToolsConsole api={createApi('synthetic-csrf')} projects={[project]} connected={false} />);
  expect(screen.getByRole('button', { name: 'Add MCP connection' })).toBeDisabled();
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
  await user.click(await screen.findByRole('tab', { name: 'Facts' }));
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
  await screen.findByRole('button', { name: 'Index repository' });
  await user.click(screen.getByRole('button', { name: 'Index repository' }));
  expect(await screen.findByRole('button', { name: 'Indexing queued' })).toBeDisabled();
  expect(screen.getByText(/Indexing queued. Source admission scanning/)).toBeVisible();
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

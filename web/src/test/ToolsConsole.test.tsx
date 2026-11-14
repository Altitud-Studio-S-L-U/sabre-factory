import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { createApi, type IntegrationInfo, type MCPConnectionInfo, type Project } from '../api';
import ToolsConsole from '../ToolsConsole';

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

const read: IntegrationInfo = {
  id: 'github.read',
  kind: 'github',
  title: 'GitHub · read repositories',
  description: 'Browse repositories.',
  enabled: true,
  revision: 0,
  toggleable: true,
  credential_ids: ['github.read'],
  credential_configured: false,
  access: 'Public access; add a read credential for private repositories.',
  tools: [{ name: 'list_repositories', effect: 'read', roles: [] }],
};
const publish: IntegrationInfo = {
  ...read,
  id: 'github.publish',
  title: 'GitHub · draft pull requests',
  description: 'Opens a draft pull request.',
  credential_ids: ['github.publish'],
  credential_configured: true,
  access: 'Credential saved; permissions have not been checked.',
  tools: [{ name: 'publish_draft_pr', effect: 'external_write', roles: [] }],
};
const docs: IntegrationInfo = {
  id: 'mcp.docs',
  kind: 'mcp',
  title: 'MCP · docs',
  description: 'Authorized external tools.',
  enabled: false,
  revision: 2,
  toggleable: true,
  credential_ids: ['mcp.docs'],
  credential_configured: false,
  access: 'No credential; the server must allow anonymous access.',
  tools: [{ name: 'search_docs', effect: 'read', roles: ['analyst'] }],
};
const slack: IntegrationInfo = {
  id: 'slack',
  kind: 'slack',
  title: 'Slack',
  description: 'Owner channel.',
  enabled: true,
  revision: 0,
  toggleable: false,
  credential_ids: ['slack.bot', 'slack.app'],
  credential_configured: false,
  access: 'Configuration or credentials are pending.',
  tools: [],
};
const server: MCPConnectionInfo = {
  name: 'docs',
  endpoint: 'https://tools.example.com/mcp',
  revision: 2,
  credential_id: 'mcp.docs',
  tools: { search_docs: { roles: ['analyst'], effect: 'read', timeout_s: 60 } },
  tool_digests: { search_docs: 'a'.repeat(64), fetch_page: 'b'.repeat(64) },
  source: 'dynamic',
};

type Call = { method: string; path: string; body: unknown };

/** A synthetic control service. Returns every request it received. */
function service(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      const path = input.replace('/api/v1', '');
      const method = request.method ?? 'GET';
      calls.push({ method, path, body: request.body ? JSON.parse(String(request.body)) : null });
      if (path === '/integrations')
        return Response.json([
          read,
          publish,
          docs,
          slack,
          { ...read, id: 'model', kind: 'model', title: 'Model providers' },
        ]);
      if (path === '/mcp-connections') return Response.json([server]);
      if (path === '/tools/catalog')
        return Response.json({
          version: 1,
          items: [
            {
              name: 'read_source',
              description: 'Bounded source read',
              effect: 'read',
              roles: ['analyst', 'developer'],
              scope: 'workspace',
              source: 'builtin',
            },
            {
              name: 'write_file',
              description: 'Write inside the workspace',
              effect: 'workspace_write',
              roles: ['developer'],
              scope: 'workspace',
              source: 'builtin',
            },
          ],
        });
      if (path === '/repository-proposals') return Response.json({ items: [], truncated: false });
      if (path === '/secret-targets')
        return Response.json([
          { id: 'github.read', label: 'GitHub · repository read' },
          { id: 'github.publish', label: 'GitHub · branch and draft PR' },
          { id: 'slack.bot', label: 'Slack · bot' },
        ]);
      if (path === '/secrets')
        return Response.json([
          { id: 'github.publish', version: 3, configured: true, updated_at: '2026-11-10T10:00:00Z' },
        ]);
      if (path === '/notifications')
        return Response.json([
          {
            id: 'synthetic-delivery',
            event_id: 'synthetic-event',
            destination: 'example:0123456789',
            attempts: 6,
            state: 'failed',
            last_error: 'HTTP_503',
          },
        ]);
      if (path.startsWith('/mcp-connections/docs/discover'))
        return Response.json({
          connection_revision: 2,
          truncated: false,
          tools: [
            { name: 'search_docs', description: 'Search', input_schema: {}, manifest_digest: 'a'.repeat(64) },
            { name: 'fetch_page', description: 'Fetch', input_schema: {}, manifest_digest: 'c'.repeat(64) },
          ],
        });
      if (path === `/projects/${project.id}/mcp-tools`)
        return Response.json({
          project_id: project.id,
          revision: method === 'PUT' ? 5 : 4,
          servers: method === 'PUT' ? ['docs'] : [],
        });
      return Response.json([]);
    }),
  );
  return calls;
}

const open = (address: string) => {
  window.history.replaceState(null, '', address);
  return render(<ToolsConsole api={createApi('synthetic-csrf')} projects={[project]} />);
};
const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET');

afterEach(() => window.history.replaceState(null, '', '/'));

it('groups connections by service and keeps the chosen tab in the address', async () => {
  const user = userEvent.setup();
  service();
  open('/tools?tab=builtin');
  expect(await screen.findByRole('tab', { name: /^Built-in tools/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.getByRole('heading', { name: 'read_source' })).toBeVisible();
  // The specialist filter narrows the catalog without another request.
  await user.selectOptions(screen.getByLabelText('Specialist'), 'analyst');
  expect(screen.queryByRole('heading', { name: 'write_file' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'read_source' })).toBeVisible();

  await user.click(screen.getByRole('tab', { name: 'GitHub' }));
  expect(window.location.search).toBe('');
  expect(screen.getByRole('heading', { name: 'GitHub · read repositories' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'GitHub · draft pull requests' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'MCP · docs' })).not.toBeInTheDocument();
  expect(screen.queryByText('Model providers')).not.toBeInTheDocument();
  // State is on the row: nothing has to be selected to read it.
  expect(screen.getByText('No token')).toBeVisible();
  expect(screen.getByText('Token saved')).toBeVisible();

  await user.click(screen.getByRole('tab', { name: /^MCP servers/ }));
  expect(window.location.search).toBe('?tab=mcp');
  expect(screen.getByRole('heading', { name: 'MCP · docs' })).toBeVisible();
  expect(screen.getByText('https://tools.example.com/mcp')).toBeVisible();
  expect(screen.getByText('Disabled')).toBeVisible();

  await user.click(screen.getByRole('tab', { name: 'Notifications' }));
  expect(window.location.search).toBe('?tab=notifications');
  expect(screen.getByRole('heading', { name: 'Slack' })).toBeVisible();
});

it('a connection link opens that connection and writes nothing', async () => {
  const calls = service();
  open('/tools?connection=github.publish');
  const details = await screen.findByRole('group', { name: 'GitHub · draft pull requests details' });
  expect(screen.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
  expect(within(details).getByRole('region', { name: 'Stored credential' })).toBeVisible();
  expect(await within(details).findByText(/Version 3/)).toBeVisible();
  expect(within(details).getByText('publish_draft_pr')).toBeVisible();
  expect(screen.queryByRole('group', { name: 'GitHub · read repositories details' })).not.toBeInTheDocument();
  expect(screen.getByText(/Opening this page does not save credentials/)).toBeVisible();
  // A link shows where the credential goes; it never opens the write-only field by itself.
  expect(screen.queryByRole('dialog', { name: 'Save credential' })).not.toBeInTheDocument();
  expect(writes(calls)).toEqual([]);
});

it('adding or replacing a token opens the editor on that connection, and details alone never do', async () => {
  const user = userEvent.setup();
  const calls = service();
  open('/tools');
  await user.click(await screen.findByRole('button', { name: 'Add token for GitHub · read repositories' }));
  let editor = await screen.findByRole('dialog', { name: 'Save credential' });
  expect(within(editor).getByLabelText('Credential destination')).toHaveValue('github.read');
  expect(within(editor).getByRole('heading', { name: 'Save a credential' })).toBeVisible();
  await user.click(within(editor).getByRole('button', { name: 'Close Save credential' }));
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Save credential' })).not.toBeInTheDocument(),
  );

  // Closing and reopening the details does not bring the editor back.
  await user.click(screen.getByRole('button', { name: 'Hide details of GitHub · read repositories' }));
  await user.click(screen.getByRole('button', { name: 'Details of GitHub · read repositories' }));
  const details = screen.getByRole('group', { name: 'GitHub · read repositories details' });
  expect(await within(details).findByRole('button', { name: 'Save credential' })).toBeEnabled();
  expect(screen.queryByRole('dialog', { name: 'Save credential' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Replace token for GitHub · draft pull requests' }));
  editor = await screen.findByRole('dialog', { name: 'Save credential' });
  expect(within(editor).getByLabelText('Credential destination')).toHaveValue('github.publish');
  expect(within(editor).getByRole('heading', { name: 'Replace version 3' })).toBeVisible();
  expect(writes(calls)).toEqual([]);
});

it('an MCP server compares its remote manifest and saves project access with the policy revision', async () => {
  const user = userEvent.setup();
  const calls = service();
  open('/tools?tab=mcp');
  await user.click(await screen.findByRole('button', { name: 'Details of MCP · docs' }));
  const details = screen.getByRole('group', { name: 'MCP · docs details' });
  expect(within(details).getByText('search_docs')).toBeVisible();
  expect(within(details).getByText('analyst')).toBeVisible();
  await user.click(within(details).getByRole('button', { name: 'Inspect remote manifest' }));
  expect(await within(details).findByText('Matches the reviewed manifest.')).toBeVisible();
  expect(within(details).getByText('Not approved or manifest changed. Review before access.')).toBeVisible();
  expect(writes(calls)).toEqual([
    { method: 'POST', path: '/mcp-connections/docs/discover?expected_revision=2', body: null },
  ]);

  await user.click(screen.getByRole('button', { name: 'Project access' }));
  const dialog = screen.getByRole('dialog', { name: 'Project tool access' });
  await user.selectOptions(within(dialog).getByLabelText('Project'), project.id);
  await user.click(await within(dialog).findByRole('checkbox', { name: 'docs' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save project access' }));
  await waitFor(() =>
    expect(writes(calls)).toContainEqual({
      method: 'PUT',
      path: `/projects/${project.id}/mcp-tools`,
      body: { expected_revision: 4, servers: ['docs'] },
    }),
  );
  expect(await screen.findByText(/Project tool permissions saved/)).toBeVisible();
});

it('the notifications tab shows the owner channel and loads the delivery log', async () => {
  const calls = service();
  open('/tools?tab=notifications');
  expect(await screen.findByRole('heading', { name: 'Slack' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Add credentials for Slack' })).toBeEnabled();
  // A channel bound by the instance has no switch here.
  expect(screen.queryByRole('button', { name: /^(Enable|Disable) Slack/ })).not.toBeInTheDocument();
  const log = screen.getByRole('region', { name: 'Delivery notifications' });
  expect(await within(log).findByRole('cell', { name: 'HTTP_503' })).toBeVisible();
  expect(within(log).getByRole('button', { name: 'Retry delivery' })).toBeEnabled();
  expect(writes(calls)).toEqual([]);
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import MCPConnections from '../MCPConnections';
import { createApi, type MCPConnectionInfo } from '../api';

const digest = 'a'.repeat(64);
const original: MCPConnectionInfo = {
  name: 'docs',
  endpoint: 'https://example.com/mcp',
  revision: 2,
  credential_id: 'mcp.docs.synthetic.token',
  tools: {},
  tool_digests: {},
  source: 'dynamic',
};

function fixture(initial: MCPConnectionInfo[] = [], conflict = false) {
  let items = initial;
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, 'http://localhost');
      const path = url.pathname.replace('/api/v1', '');
      const method = init.method || 'GET';
      if (method === 'GET' && path === '/mcp-connections') return Response.json(items);
      if (method === 'GET' && path === '/projects') return Response.json([]);
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ path: path + url.search, method, body });
      if (method === 'PUT' && path === '/mcp-connections/docs') {
        if (conflict)
          return Response.json(
            { message: 'The MCP connection has changed; refresh before saving.' },
            { status: 409 },
          );
        const current = items.find((item) => item.name === 'docs');
        const next = { ...original, ...body, revision: (current?.revision || 0) + 1 } as MCPConnectionInfo;
        items = [next];
        return Response.json(next);
      }
      if (method === 'POST' && path === '/mcp-connections/docs/discover')
        return Response.json({
          connection_revision: items[0].revision,
          truncated: false,
          tools: [
            {
              name: 'search',
              description: 'Search the reviewed documentation.',
              input_schema: { type: 'object', properties: { query: { type: 'string' } } },
              manifest_digest: digest,
            },
          ],
        });
      throw new Error(`Unexpected fixture request ${method} ${path}`);
    }),
  );
  const onChanged = vi.fn(async () => undefined);
  render(<MCPConnections api={createApi('synthetic-csrf')} onChanged={onChanged} />);
  return { user: userEvent.setup(), calls, onChanged };
}

it('saves disabled and sends only the selected contracts and roles after discovery', async () => {
  const { user, calls } = fixture();
  await user.click(screen.getByRole('button', { name: 'Add MCP server' }));
  await user.type(screen.getByLabelText('Connection name'), 'docs');
  await user.type(screen.getByLabelText('MCP endpoint'), 'https://example.com/mcp');
  await user.click(screen.getByRole('button', { name: 'Save disabled connection' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover tools' })).toBeEnabled());
  expect(calls[0]).toEqual({
    path: '/mcp-connections/docs',
    method: 'PUT',
    body: { endpoint: 'https://example.com/mcp', expected_revision: 0, tools: {}, tool_digests: {} },
  });
  await user.click(screen.getByRole('button', { name: 'Discover tools' }));
  expect(await screen.findByText('Search the reviewed documentation.')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Development' })).not.toBeChecked();
  await user.click(screen.getByText('View input contract'));
  expect(screen.getByText(/"query"/)).toBeVisible();
  await user.click(screen.getByRole('checkbox', { name: 'Development' }));
  await user.click(screen.getByRole('button', { name: 'Save disabled connection' }));
  await waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[1]).toEqual({
    path: '/mcp-connections/docs/discover?expected_revision=1',
    method: 'POST',
    body: null,
  });
  expect(calls[2].body).toEqual({
    endpoint: 'https://example.com/mcp',
    expected_revision: 1,
    tools: { search: { roles: ['developer'], effect: 'read', timeout_s: 60 } },
    tool_digests: { search: digest },
  });
  expect(calls.every((call) => !call.path.includes('/state'))).toBe(true);
});

it('discards permissions and the previously reviewed manifest when the endpoint changes', async () => {
  const { user, calls } = fixture([
    {
      ...original,
      tools: { search: { roles: ['developer'], effect: 'read', timeout_s: 60 } },
      tool_digests: { search: digest },
    },
  ]);
  await user.click(await screen.findByRole('button', { name: 'Configure MCP docs' }));
  expect(screen.getByLabelText('Connection name')).toBeDisabled();
  await user.clear(screen.getByLabelText('MCP endpoint'));
  await user.type(screen.getByLabelText('MCP endpoint'), 'https://example.org/mcp');
  expect(screen.getByRole('button', { name: 'Discover tools' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Save disabled connection' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].body).toEqual({
    endpoint: 'https://example.org/mcp',
    expected_revision: 2,
    tools: {},
    tool_digests: {},
  });
});

it('shows no confirmation and does not resend the operation on a CAS conflict', async () => {
  const { user, calls } = fixture([original], true);
  await user.click(await screen.findByRole('button', { name: 'Configure MCP docs' }));
  await user.click(screen.getByRole('button', { name: 'Save disabled connection' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The MCP connection has changed');
  expect(calls).toHaveLength(1);
  expect(screen.queryByText(/Connection saved and disabled/)).not.toBeInTheDocument();
});

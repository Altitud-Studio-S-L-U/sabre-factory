import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createApi, type A2AAgentInfo, type Project } from '../api';
import RemoteAgentsPanel from '../RemoteAgentsPanel';

const project: Project = {
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
};
const card = {
  name: 'Synthetic review partner',
  description: 'Synthetic test fixture',
  skills: [{ id: 'review', name: 'Review sources', description: 'Review a bounded source task' }],
  supportedInterfaces: [
    { url: 'https://agent.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
};
const digest = 'a'.repeat(64);
const original: A2AAgentInfo = {
  name: 'review-partner',
  endpoint: 'https://agent.example.com/a2a',
  revision: 4,
  card,
  digest,
  enabled: true,
  projects: [project.id],
  roles: ['reviewer'],
  skills: ['review'],
  credential_id: 'a2a.review-partner.synthetic.token',
  cost: 'unknown',
};

it('discovers without authorization and saves only reviewed project, role and skill bindings', async () => {
  const user = userEvent.setup();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      if (input.endsWith('/mcp-connections')) return Response.json([]);
      if (!request.method) return Response.json([]);
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      writes.push({ path: input, body });
      if (input.endsWith('/discover'))
        return Response.json({
          card,
          reviewed_digest: digest,
          endpoint: original.endpoint,
          execution_authorized: false,
        });
      return Response.json({ ...original, ...body, revision: 1 });
    }),
  );
  render(<RemoteAgentsPanel api={createApi('synthetic-csrf')} projects={[project]} />);
  await screen.findByText('No external A2A agents registered');
  await user.click(screen.getByRole('button', { name: 'Register A2A agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Register external A2A agent' });
  await user.type(within(dialog).getByLabelText('Connection name'), 'review-partner');
  await user.type(within(dialog).getByLabelText('A2A endpoint'), original.endpoint);
  await user.click(within(dialog).getByRole('button', { name: 'Discover Agent Card' }));
  expect(await within(dialog).findByText('Discovery grants no execution access')).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({
    endpoint: original.endpoint,
    card_endpoint: 'https://agent.example.com/.well-known/agent-card.json',
  });
  const save = within(dialog).getByRole('button', { name: 'Save disabled registration' });
  expect(save).toBeDisabled();
  await user.click(within(dialog).getByRole('checkbox', { name: 'Synthetic project' }));
  await user.click(within(dialog).getByText('Role and skill bindings'));
  await user.click(within(dialog).getByRole('checkbox', { name: 'reviewer' }));
  await user.click(within(dialog).getByRole('checkbox', { name: /Review sources/ }));
  await user.click(within(dialog).getByRole('checkbox', { name: /I reviewed this Agent Card/ }));
  await user.click(save);
  await screen.findByText(/External agent registration saved/);
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toMatchObject({
    expected_revision: 0,
    reviewed_digest: digest,
    enabled: false,
    projects: [project.id],
    roles: ['reviewer'],
    skills: ['review'],
  });
  expect(writes.some((write) => write.path.includes('message'))).toBe(false);
});

it('retains a reviewed draft after CAS conflict and disables changed manifests until review', async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      if (input.endsWith('/mcp-connections')) return Response.json([]);
      if (input.endsWith('/discover'))
        return Response.json({
          card: { ...card, description: 'Changed synthetic contract' },
          reviewed_digest: 'b'.repeat(64),
          endpoint: original.endpoint,
          execution_authorized: false,
        });
      if (request.method === 'PUT')
        return Response.json(
          { message: 'External agent revision changed; review your retained draft.' },
          { status: 409 },
        );
      return Response.json([original]);
    }),
  );
  render(<RemoteAgentsPanel api={createApi('synthetic-csrf')} projects={[project]} />);
  await user.click(await screen.findByRole('button', { name: 'Review registration' }));
  const dialog = screen.getByRole('dialog', { name: 'Review review-partner' });
  expect(within(dialog).getByRole('checkbox', { name: /Enable this registration/ })).toBeChecked();
  await user.click(within(dialog).getByRole('button', { name: 'Discover Agent Card' }));
  await waitFor(() =>
    expect(within(dialog).getByRole('checkbox', { name: /Enable this registration/ })).not.toBeChecked(),
  );
  expect(within(dialog).getByRole('checkbox', { name: /I reviewed this Agent Card/ })).not.toBeChecked();
  await user.click(within(dialog).getByRole('checkbox', { name: /I reviewed this Agent Card/ }));
  await user.click(within(dialog).getByRole('button', { name: 'Save disabled registration' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('retained draft');
  expect(within(dialog).getByLabelText('A2A endpoint')).toHaveValue(original.endpoint);
});

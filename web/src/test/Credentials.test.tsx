import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Credentials from '../Credentials';
import { createApi, type SecretMetadata, type SecretTarget } from '../api';

const privateValue = 'synthetic-private-value-that-must-not-render';
const defaultTarget = {
  id: 'model.openai.default',
  label: 'Default model · OpenAI',
} satisfies SecretTarget;
const updatedAt = '2026-11-05T11:00:00Z';
let metadata: SecretMetadata[];
let targets: SecretTarget[];

function mockVault(options: { failure?: 'http' | 'network' | 'load'; pendingPost?: Promise<Response> } = {}) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: string, request: RequestInit = {}) => {
    const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
    if ((request.method || 'GET') === 'GET') {
      if (path === '/secret-targets') return Response.json(targets);
      if (path === '/secrets')
        return Response.json(options.failure === 'load' ? { message: privateValue } : metadata, {
          status: options.failure === 'load' ? 503 : 200,
        });
    }
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    writes.push({ path, body });
    if (options.failure === 'network') throw new Error(privateValue);
    if (options.failure === 'http')
      return Response.json({ message: privateValue, value: privateValue }, { status: 503 });
    if (options.pendingPost) return options.pendingPost;
    const id = decodeURIComponent(path.split('/')[2]);
    const current = metadata.find((item) => item.id === id);
    if (body.expected_version !== (current?.version ?? null))
      return Response.json({ message: privateValue }, { status: 409 });
    const next = {
      id,
      version: (current?.version ?? 0) + 1,
      configured: !path.endsWith('/deactivate'),
      updated_at: updatedAt,
    };
    metadata = [...metadata.filter((item) => item.id !== id), next];
    return Response.json(next);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, writes };
}

async function open(onChanged: () => Promise<void> = vi.fn(async () => undefined)) {
  const user = userEvent.setup();
  render(<Credentials api={createApi('synthetic-session-csrf')} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh metadata' })).toBeEnabled());
  return { user, onChanged };
}

beforeEach(() => {
  metadata = [];
  targets = [defaultTarget];
});

describe('Control credentials', () => {
  it('limits the destinations to the integration and clears the editor when it changes', async () => {
    const github = { id: 'github.read', label: 'GitHub · read' };
    targets = [defaultTarget, github];
    mockVault();
    const api = createApi('synthetic-session-csrf');
    const onChanged = vi.fn(async () => undefined);
    const user = userEvent.setup();
    const view = render(<Credentials api={api} onChanged={onChanged} targetIds={[github.id]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save credential' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save credential' }));
    expect(screen.queryByRole('option', { name: defaultTarget.label })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('New credential value'), privateValue);
    view.rerender(<Credentials api={api} onChanged={onChanged} targetIds={[defaultTarget.id]} />);
    await waitFor(() => expect(screen.queryByLabelText('New credential value')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save credential' }));
    expect(screen.getByLabelText('New credential value')).toHaveValue('');
    expect(screen.queryByRole('option', { name: github.label })).not.toBeInTheDocument();
  });

  it('saves only the new value with the creation version and never keeps it on screen or in storage', async () => {
    const { writes } = mockVault();
    const { user, onChanged } = await open();
    expect(screen.getByText('No saved credentials yet.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save credential' }));
    const input = screen.getByLabelText('New credential value');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('');
    await user.type(input, privateValue);
    await user.click(screen.getByRole('button', { name: 'Save encrypted value' }));
    await screen.findByText(/Credential saved for/);
    expect(writes).toEqual([
      { path: '/secrets/model.openai.default', body: { value: privateValue, expected_version: null } },
    ]);
    expect(document.body).not.toHaveTextContent(privateValue);
    expect(screen.queryByLabelText('New credential value')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show|Reveal/ })).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('replaces the selected version and clears the field before the response arrives', async () => {
    metadata = [{ id: defaultTarget.id, version: 3, configured: true, updated_at: updatedAt }];
    let release: (response: Response) => void = () => undefined;
    const pendingPost = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { writes } = mockVault({ pendingPost });
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Replace Default model · OpenAI' }));
    const input = screen.getByLabelText('New credential value');
    await user.type(input, privateValue);
    await user.click(screen.getByRole('button', { name: 'Replace encrypted value' }));
    expect(input).toHaveValue('');
    expect(input).toBeDisabled();
    expect(writes[0].body).toEqual({ value: privateValue, expected_version: 3 });
    await act(async () =>
      release(Response.json({ id: defaultTarget.id, version: 4, configured: true, updated_at: updatedAt })),
    );
    expect(await screen.findByText(/Version 4\./)).toBeVisible();
    expect(document.body).not.toHaveTextContent(privateValue);
  });

  it('rejects a stale version and requires a new action without retrying or restoring the key', async () => {
    metadata = [{ id: defaultTarget.id, version: 3, configured: true, updated_at: updatedAt }];
    const { writes } = mockVault();
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Replace Default model · OpenAI' }));
    await user.type(screen.getByLabelText('New credential value'), privateValue);
    metadata = [{ ...metadata[0], version: 4 }];
    await user.click(screen.getByRole('button', { name: 'Replace encrypted value' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The credential changed in another session');
    expect(writes).toHaveLength(1);
    expect(writes[0].body.expected_version).toBe(3);
    expect(document.body).not.toHaveTextContent(privateValue);
    expect(screen.queryByLabelText('New credential value')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace Default model · OpenAI' }));
    expect(screen.getByLabelText('New credential value')).toHaveValue('');
    expect(screen.getByRole('heading', { name: 'Replace version 4' })).toBeVisible();
  });

  it.each(['http', 'network'] as const)(
    'does not echo private bodies or errors and clears the value after a %s failure',
    async (failure) => {
      mockVault({ failure });
      const { user } = await open();
      await user.click(screen.getByRole('button', { name: 'Save credential' }));
      await user.type(screen.getByLabelText('New credential value'), privateValue);
      await user.click(screen.getByRole('button', { name: 'Save encrypted value' }));
      await screen.findByRole('alert');
      expect(document.body).not.toHaveTextContent(privateValue);
      expect(screen.queryByLabelText('New credential value')).not.toBeInTheDocument();
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    },
  );

  it('confirms deactivating an exact version and states that it is not revoked at the provider', async () => {
    metadata = [{ id: defaultTarget.id, version: 7, configured: true, updated_at: updatedAt }];
    const { writes } = mockVault();
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Disable Default model · OpenAI' }));
    expect(writes).toHaveLength(0);
    expect(
      screen.getByText(
        'The stored value will be removed. This does not revoke the credential at the external provider.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm deactivation' }));
    expect(await screen.findByText('Disabled')).toBeVisible();
    expect(writes).toEqual([
      { path: '/secrets/model.openai.default/deactivate', body: { expected_version: 7 } },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('It has not been revoked at the provider');
  });

  it('uses the destinations and hashes published by the backend without inheriting a credential from another destination', async () => {
    metadata = [{ id: defaultTarget.id, version: 1, configured: true, updated_at: updatedAt }];
    const target = { id: 'mcp.repository.0123456789abcdef.token', label: 'MCP · repository' };
    targets = [target];
    const { writes } = mockVault();
    const { user } = await open();
    expect(screen.queryByRole('button', { name: /Replace/ })).not.toBeInTheDocument();
    expect(screen.getByText('Outside the destinations registered by this instance.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save credential' }));
    expect(screen.getByLabelText('Credential destination')).toHaveValue(target.id);
    expect(screen.getByLabelText('New credential value')).toHaveValue('');
    await user.type(screen.getByLabelText('New credential value'), privateValue);
    await user.click(screen.getByRole('button', { name: 'Save encrypted value' }));
    await screen.findByText(/Credential saved for MCP/);
    expect(writes[0]).toEqual({
      path: `/secrets/${target.id}`,
      body: { value: privateValue, expected_version: null },
    });
  });

  it('shows load errors without inventing an empty store or allowing writes', async () => {
    mockVault({ failure: 'load' });
    await open();
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.queryByText('No saved credentials yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save credential' })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(privateValue);
  });

  it.each(['save', 'deactivate'] as const)(
    'keeps the %s confirmation even when refreshing the overall status fails',
    async (operation) => {
      metadata = [{ id: defaultTarget.id, version: 3, configured: true, updated_at: updatedAt }];
      const { writes } = mockVault();
      const changed = vi.fn(async () => {
        throw new Error(privateValue);
      });
      const { user } = await open(changed);
      if (operation === 'save') {
        await user.click(screen.getByRole('button', { name: 'Replace Default model · OpenAI' }));
        await user.type(screen.getByLabelText('New credential value'), privateValue);
        await user.click(screen.getByRole('button', { name: 'Replace encrypted value' }));
        expect(await screen.findByText(/Credential saved for/)).toBeVisible();
      } else {
        await user.click(screen.getByRole('button', { name: 'Disable Default model · OpenAI' }));
        await user.click(screen.getByRole('button', { name: 'Confirm deactivation' }));
        expect(await screen.findByText(/Credential disabled in SABRE/)).toBeVisible();
      }
      expect(
        await screen.findByText(
          'The credential operation is confirmed. Overall status could not be refreshed.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(writes).toHaveLength(1);
      expect(document.body).not.toHaveTextContent(privateValue);
    },
  );
});

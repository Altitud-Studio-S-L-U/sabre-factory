import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../api';
import GitHubRepositories from '../features/tools/GitHubRepositories';

function mount(options: { searchFailure?: boolean; enabled?: boolean } = {}) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push({ path, body });
        if (path === '/integrations/github/repositories/search')
          return options.searchFailure
            ? Response.json({ message: 'GitHub did not allow listing these repositories.' }, { status: 502 })
            : Response.json({
                page: 1,
                next_page: null,
                access: 'public',
                items: [
                  {
                    id: 42,
                    full_name: 'fixture/example',
                    url: 'https://github.com/fixture/example',
                    default_branch: 'trunk',
                    visibility: 'public',
                    archived: false,
                    disabled: false,
                    description: 'A public fixture',
                    language: 'TypeScript',
                  },
                ],
              });
        if (path === '/integrations/github/import')
          return Response.json({
            id: 'project-fixture',
            name: body.name,
            repository: 'https://github.com/fixture/example',
            default_branch: 'trunk',
            profile: body.profile,
            gate_commands: body.gate_commands,
          });
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    }),
  );
  const onChanged = vi.fn(async () => undefined);
  render(
    <GitHubRepositories
      api={createApi('synthetic-csrf')}
      enabled={options.enabled ?? true}
      onChanged={onChanged}
    />,
  );
  return { user: userEvent.setup(), writes, onChanged };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GitHubRepositories', () => {
  it('browses an account and registers a repository with explicit checks, without starting a run', async () => {
    const { user, writes, onChanged } = mount();
    await user.selectOptions(screen.getByLabelText('Account type'), 'user');
    await user.type(screen.getByLabelText('User or organization'), 'fixture');
    await user.click(screen.getByRole('button', { name: 'Search repositories' }));
    await user.click(await screen.findByRole('button', { name: 'Import fixture/example' }));
    const form = screen.getByRole('form', { name: 'Import fixture/example' });
    await user.click(within(form).getByLabelText('Delivery checks'));
    await user.paste('["npm", "test"]');
    await user.click(within(form).getByRole('button', { name: 'Register project' }));
    expect(await screen.findByText(/example is registered in Projects/)).toBeInTheDocument();
    expect(writes).toEqual([
      {
        path: '/integrations/github/repositories/search',
        body: { owner: 'fixture', owner_type: 'user', page: 1 },
      },
      {
        path: '/integrations/github/import',
        body: {
          owner: 'fixture',
          repository: 'example',
          name: 'example',
          profile: 'node',
          gate_commands: [['npm', 'test']],
        },
      },
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('shows a search failure without inventing available repositories', async () => {
    const { user } = mount({ searchFailure: true });
    await user.type(screen.getByLabelText('User or organization'), 'fixture');
    await user.click(screen.getByRole('button', { name: 'Search repositories' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub did not allow listing');
    expect(screen.queryByRole('button', { name: /^Import / })).not.toBeInTheDocument();
  });

  it('does not search while the GitHub connection is disabled', async () => {
    const { writes } = mount({ enabled: false });
    expect(screen.getByRole('button', { name: 'Search repositories' })).toBeDisabled();
    expect(writes).toEqual([]);
  });
});

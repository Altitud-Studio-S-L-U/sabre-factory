import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Integrations from '../Integrations';
import { createApi, type IntegrationInfo } from '../api';
import { configuration } from './modelConfigurationFixture';

const read: IntegrationInfo = {
  id: 'github.read',
  kind: 'github',
  title: 'GitHub · repositorios',
  description: 'Explora e importa repositorios.',
  enabled: true,
  revision: 2,
  toggleable: true,
  credential_ids: ['github.read'],
  credential_configured: false,
  access: 'Acceso público.',
  tools: [{ name: 'list_repositories', effect: 'read', roles: [] }],
};

function mock(options: { conflict?: boolean; searchFailure?: boolean } = {}) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
      if (path === '/model-configuration' && !init.method) return Response.json(configuration());
      if (path === '/mcp-connections' && !init.method) return Response.json([]);
      if (path === '/repository-proposals' && !init.method)
        return Response.json({ items: [], truncated: false });
      if (path === '/integrations' && !init.method)
        return Response.json([
          read,
          {
            ...read,
            id: 'model',
            kind: 'model',
            title: 'Modelos',
            toggleable: false,
            credential_ids: [],
            tools: [],
          },
        ]);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push({ path, body });
        if (path === '/integrations/github.read/state')
          return options.conflict
            ? Response.json({ message: 'La conexión ha cambiado; actualiza su estado.' }, { status: 409 })
            : Response.json({ ...read, enabled: body.enabled, revision: 3 });
        if (path === '/integrations/github/repositories/search')
          return options.searchFailure
            ? Response.json({ message: 'GitHub no permitió consultar los repositorios.' }, { status: 502 })
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
  render(<Integrations api={createApi('synthetic-csrf')} onChanged={onChanged} />);
  return { user: userEvent.setup(), writes, onChanged };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Integrations', () => {
  it('persiste desactivación con revision y no ofrece controles ficticios a modelos', async () => {
    const { user, writes } = mock();
    await user.click(await screen.findByRole('button', { name: 'Disable GitHub · repositorios' }));
    await screen.findByRole('button', { name: 'Enable GitHub · repositorios' });
    expect(writes).toEqual([
      { path: '/integrations/github.read/state', body: { enabled: false, expected_revision: 2 } },
    ]);
    expect(screen.getByRole('button', { name: 'Search repositories' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Disable Modelos/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Calls already in progress may finish/)).toBeInTheDocument();
  });

  it('mantiene el estado confirmado cuando otra sesión modificó la conexión', async () => {
    const { user } = mock({ conflict: true });
    await user.click(await screen.findByRole('button', { name: 'Disable GitHub · repositorios' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La conexión ha cambiado');
    expect(screen.getByRole('button', { name: 'Disable GitHub · repositorios' })).toBeEnabled();
    expect(screen.queryByText(/conexión activada/)).not.toBeInTheDocument();
  });

  it('explora e importa con comprobaciones explícitas sin iniciar un encargo', async () => {
    const { user, writes, onChanged } = mock();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search repositories' })).toBeEnabled());
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

  it('muestra errores de búsqueda sin inventar repositorios disponibles', async () => {
    const { user } = mock({ searchFailure: true });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search repositories' })).toBeEnabled());
    await user.type(screen.getByLabelText('User or organization'), 'fixture');
    await user.click(screen.getByRole('button', { name: 'Search repositories' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('GitHub no permitió');
    expect(screen.queryByRole('button', { name: /^Import / })).not.toBeInTheDocument();
  });
});

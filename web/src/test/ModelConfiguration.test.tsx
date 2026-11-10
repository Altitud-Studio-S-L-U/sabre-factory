import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createApi, type ModelConfigurationChange } from '../api';
import ModelConfiguration from '../ModelConfiguration';
import { configuration } from './modelConfigurationFixture';

function setup(conflict = false) {
  const writes: ModelConfigurationChange[] = [];
  const onChanged = vi.fn(async () => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string, init: RequestInit = {}) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as ModelConfigurationChange;
        writes.push(body);
        if (conflict)
          return Response.json(
            { message: 'La configuration ha cambiado; actualiza antes de guardar.' },
            { status: 409 },
          );
        const value = configuration();
        return Response.json({
          ...value,
          revision: 1,
          default: body.default,
          roles: value.roles.map((role) => ({
            ...role,
            override: body.roles[role.role],
            effective: body.roles[role.role] ?? body.default,
          })),
        });
      }
      return Response.json(configuration());
    }),
  );
  render(<ModelConfiguration api={createApi('synthetic-csrf')} onChanged={onChanged} />);
  return { writes, onChanged };
}

async function configureReviewer() {
  const user = userEvent.setup();
  await screen.findByText('Team configuration · revision 0');
  const details = screen.getByText('Technical review').closest('details')!;
  await user.click(within(details).getByText('Technical review'));
  await user.click(within(details).getByRole('checkbox', { name: 'Inherit the default model' }));
  await user.selectOptions(within(details).getByRole('combobox', { name: 'Provider' }), 'claude_cli');
  await user.type(within(details).getByRole('textbox', { name: 'Model' }), 'sonnet');
  return user;
}

describe('modelos por especialidad', () => {
  it('distingue la conexión de la selección y exige aprobar los destinos antes del cambio CAS', async () => {
    const { writes, onChanged } = setup();
    const user = await configureReviewer();
    expect(screen.getByText('Session connection required')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save models' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /I authorize sending/ }));
    await user.click(save);
    await screen.findByText(/Configuration saved/);
    expect(writes).toHaveLength(1);
    expect(writes[0].expected_revision).toBe(0);
    expect(writes[0].roles.reviewer).toMatchObject({
      provider: 'claude_cli',
      name: 'sonnet',
      destination: 'http://claude-runner:8092',
    });
    expect(writes[0].roles.developer).toBeNull();
    expect(writes[0].approved_destinations).toEqual([
      'http://claude-runner:8092',
      'http://codex-runner:8091',
    ]);
    expect(JSON.stringify(writes)).not.toContain('api_key');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('conserva el borrador cuando otro canal ha cambiado la revision y no reintenta', async () => {
    const { writes } = setup(true);
    const user = await configureReviewer();
    await user.click(screen.getByRole('checkbox', { name: /I authorize sending/ }));
    await user.click(screen.getByRole('button', { name: 'Save models' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La configuration ha cambiado');
    const details = screen.getByText('Technical review').closest('details')!;
    expect(within(details).getByRole('textbox', { name: 'Model' })).toHaveValue('sonnet');
    expect(writes).toHaveLength(1);
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createApi, type ModelConfigurationChange } from '../api';
import ModelConfiguration from '../ModelConfiguration';
import { configuration } from './modelConfigurationFixture';

function setup(conflict = false, scope: 'all' | 'default' | 'agents' = 'all') {
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
            { message: 'The configuration has changed; refresh before saving.' },
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
  render(<ModelConfiguration api={createApi('synthetic-csrf')} onChanged={onChanged} scope={scope} />);
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

describe('models per specialty', () => {
  it('edits one selected agent while retaining the factory default and other assignments', async () => {
    const { writes } = setup(false, 'agents');
    const user = userEvent.setup();
    const selector = await screen.findByLabelText('Runtime specialists');
    await user.click(within(selector).getByRole('button', { name: /Development/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Inherit the default model' }));
    const role = screen.getByText('Development', { selector: 'summary strong' }).closest('details')!;
    await user.selectOptions(within(role).getByLabelText('Provider'), 'anthropic');
    await user.type(within(role).getByLabelText('Model'), 'synthetic-implementation-model');
    await user.click(screen.getByRole('checkbox', { name: /I authorize sending/ }));
    await user.click(screen.getByRole('button', { name: 'Save models' }));
    await screen.findByText(/Configuration saved/);
    expect(writes).toHaveLength(1);
    expect(writes[0].default).toEqual(configuration().default);
    expect(writes[0].roles.developer).toMatchObject({
      provider: 'anthropic',
      name: 'synthetic-implementation-model',
    });
    expect(writes[0].roles.qa).toBeNull();
  });
  it('offers cache prices for an API model only and sends an emptied price as unset', async () => {
    const { writes } = setup(false, 'agents');
    const user = userEvent.setup();
    const selector = await screen.findByLabelText('Runtime specialists');
    await user.click(within(selector).getByRole('button', { name: /Development/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Inherit the default model' }));
    const role = screen.getByText('Development', { selector: 'summary strong' }).closest('details')!;
    // A CLI session has no price per token, so it has no cache price either.
    expect(within(role).queryByLabelText('USD per million cached input tokens')).not.toBeInTheDocument();
    await user.selectOptions(within(role).getByLabelText('Provider'), 'anthropic');
    await user.type(within(role).getByLabelText('Model'), 'synthetic-implementation-model');
    const read = within(role).getByLabelText('USD per million cached input tokens');
    const written = within(role).getByLabelText('USD per million tokens written to the cache');
    expect(read).toHaveValue(null);
    expect(read).toHaveAccessibleDescription(/Empty: charged at the input price/);
    await user.type(read, '0.3');
    await user.type(written, '3.75');
    await user.clear(written);
    await user.click(screen.getByRole('checkbox', { name: /I authorize sending/ }));
    await user.click(screen.getByRole('button', { name: 'Save models' }));
    await screen.findByText(/Configuration saved/);
    expect(writes[0].roles.developer).toMatchObject({
      provider: 'anthropic',
      cache_read_usd_per_million: 0.3,
      cache_write_usd_per_million: null,
    });
  });
  it('distinguishes the connection from the selection and requires approving the destinations before the CAS change', async () => {
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

  it('keeps the draft when another channel changed the revision and does not retry', async () => {
    const { writes } = setup(true);
    const user = await configureReviewer();
    await user.click(screen.getByRole('checkbox', { name: /I authorize sending/ }));
    await user.click(screen.getByRole('button', { name: 'Save models' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The configuration has changed');
    const details = screen.getByText('Technical review').closest('details')!;
    expect(within(details).getByRole('textbox', { name: 'Model' })).toHaveValue('sonnet');
    expect(writes).toHaveLength(1);
  });
});

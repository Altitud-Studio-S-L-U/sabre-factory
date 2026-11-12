import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createApi } from '../api';
import { ConfigurationHistoryPanel, RuntimeSettingsPanel } from '../features/config/RuntimeSettingsPanel';
import { configurationHistory, runtimeSettings } from './runtimeFixture';

it('shows each runtime setting with the environment variable that sets it, read-only', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ runtime_settings: runtimeSettings() })),
  );
  render(<RuntimeSettingsPanel api={createApi('synthetic-csrf')} />);
  const execution = await screen.findByRole('heading', { name: 'Execution' });
  const card = within(execution.closest('[aria-labelledby]') as HTMLElement);
  expect(card.getByText('SABRE_EXECUTION_SLOTS')).toBeVisible();
  expect(card.getAllByText('Fixed in the executor').length).toBeGreaterThan(0);
  expect(screen.getByText('Not set')).toBeVisible();
  expect(screen.getByText('Sent to jaeger')).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('says so when an older server reports no runtime settings', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({})),
  );
  render(<RuntimeSettingsPanel api={createApi('synthetic-csrf')} />);
  expect(await screen.findByText('This server does not report its runtime settings.')).toBeVisible();
});

it('lists saved revisions with their changed paths and marks the current one', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(configurationHistory())),
  );
  render(<ConfigurationHistoryPanel api={createApi('synthetic-csrf')} revision={2} />);
  const list = await screen.findByRole('list');
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(within(list).getByText('models.roles.developer')).toBeVisible();
  expect(within(list).getByText('current')).toBeVisible();
});

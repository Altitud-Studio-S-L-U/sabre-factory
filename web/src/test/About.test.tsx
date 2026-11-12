import { StrictMode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import About from '../About';
import type { SystemInfo } from '../api';

const info: SystemInfo = {
  checked_at: '2026-11-07T12:00:00Z',
  application: { name: 'SABRE', version: '2.3.4-fixture', graph_version: 'fixture-v2' },
  runtime: { python: '3.14.10', implementation: 'CPython', system: 'Linux', architecture: 'x86_64' },
  packages: [
    { distribution: 'langgraph', version: '1.2.18' },
    { distribution: 'mcp', version: null },
  ],
  components: [
    {
      id: 'database',
      label: 'PostgreSQL',
      configured: true,
      state: 'available',
      detail: 'Connection query completed.',
    },
    {
      id: 'telemetry',
      label: 'OpenTelemetry',
      configured: true,
      state: 'unknown',
      detail: 'The destination is configured; trace delivery is not verified.',
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      configured: null,
      state: 'busy',
      detail: 'The runner is busy; the session is not rechecked during inference.',
    },
  ],
  limits: {
    concurrent_work: 2,
    writers_per_repository: 1,
    repair_cycles: 2,
    codex_invocations: 1,
    claude_invocations: null,
  },
  models: [{ role: 'developer', provider: 'codex_cli', name: '', configured: null }],
};

describe('System information', () => {
  it('queries once in StrictMode and shows versions and capacity without attributing health to configuration', async () => {
    const api = { system: vi.fn().mockResolvedValue(info) };
    render(
      <StrictMode>
        <About api={api} />
      </StrictMode>,
    );
    expect(await screen.findByText(/2.3.4-fixture/)).toBeVisible();
    expect(api.system).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1.2.18')).toBeVisible();
    expect(screen.getByText('Unknown')).toBeVisible();
    const telemetry = screen.getByRole('heading', { name: 'OpenTelemetry' }).closest('li')!;
    expect(within(telemetry).getByText('Configured')).toBeVisible();
    expect(within(telemetry).getByText('Not checked')).toBeVisible();
    expect(within(telemetry).queryByText('Responding')).not.toBeInTheDocument();
    const cli = screen.getByRole('heading', { name: 'Codex CLI' }).closest('li')!;
    expect(within(cli).getByText('Busy')).toBeVisible();
    expect(within(cli).queryByText('Not configured')).not.toBeInTheDocument();
    expect(screen.getByText(/the Codex runner processes one invocation at a time/)).toBeVisible();
    expect(screen.getByText('Developer')).toBeVisible();
    expect(screen.getByText('Session not checked: runner busy')).toBeVisible();
  });

  it('keeps the previous date when the refresh fails and allows a retry without exposing the remote error', async () => {
    const api = {
      system: vi
        .fn()
        .mockResolvedValueOnce(info)
        .mockRejectedValueOnce(new Error('private-error'))
        .mockResolvedValue(info),
    };
    const user = userEvent.setup();
    render(<About api={api} />);
    await screen.findByText(/2.3.4-fixture/);
    await user.click(screen.getByRole('button', { name: 'Refresh system' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Previous results remain visible');
    expect(screen.queryByText('private-error')).not.toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute('datetime', info.checked_at);
    await user.click(screen.getByRole('button', { name: 'Refresh system' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(api.system).toHaveBeenCalledTimes(3);
  });

  it('presents no made-up data when the first query fails', async () => {
    render(<About api={{ system: vi.fn().mockRejectedValue(new Error('private-error')) }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The system could not be queried');
    expect(screen.queryByRole('heading', { name: 'Services and connections' })).not.toBeInTheDocument();
    expect(screen.queryByText('private-error')).not.toBeInTheDocument();
  });
});

it('shows the running console build and flags a newer build served by the factory', async () => {
  vi.stubEnv('VITE_SABRE_BUILD', 'aaaaaaaaaaaaaaaa');
  vi.resetModules();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ build: 'bbbbbbbbbbbbbbbb' })),
  );
  const { default: FreshAbout } = await import('../About');
  render(<FreshAbout api={{ system: async () => info }} />);
  expect(await screen.findByText('aaaaaaaaaaaaaaaa')).toBeVisible();
  expect(await screen.findByText(/The server now serves build/)).toHaveTextContent('bbbbbbbbbbbbbbbb');
  vi.unstubAllEnvs();
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PairedBrowsers from '../PairedBrowsers';
import type { PairedBrowsers as View } from '../api';

const base = {
  created_at: '2026-11-01T09:00:00Z',
  last_used_at: '2026-11-10T09:00:00Z',
  expires_at: '2026-12-10T09:00:00Z',
};

function view(): View {
  return {
    lifetime_days: 30,
    browsers: [
      { ...base, id: '0b0e3f0a-1111-4222-8333-444455556666', client: 'Chrome on Windows', current: true },
      { ...base, id: '1c1f4a1b-2222-4333-8444-555566667777', client: 'Safari on macOS', current: false },
    ],
  };
}

describe('PairedBrowsers', () => {
  it('lists paired browsers, marks this one and offers revocation only for the others', async () => {
    const api = {
      pairedBrowsers: vi.fn(async () => view()),
      revokePairedBrowser: vi.fn(async () => undefined),
    };
    render(<PairedBrowsers api={api} />);
    const list = await screen.findByRole('list', { name: 'Paired browsers' });
    expect(list).toHaveTextContent('Chrome on Windows');
    expect(list).toHaveTextContent('This browser');
    expect(screen.getByText(/signs out after 30 days without use/)).toBeVisible();
    const revoke = screen.getAllByRole('button', { name: /^Revoke / });
    expect(revoke).toHaveLength(1);
    expect(revoke[0]).toHaveAccessibleName(/Safari on macOS/);
  });

  it('revokes by public identifier and reloads the list', async () => {
    const remaining = view();
    remaining.browsers = remaining.browsers.filter((item) => item.current);
    const api = {
      pairedBrowsers: vi
        .fn(async () => view())
        .mockResolvedValueOnce(view())
        .mockResolvedValueOnce(remaining),
      revokePairedBrowser: vi.fn(async () => undefined),
    };
    const user = userEvent.setup();
    render(<PairedBrowsers api={api} />);
    await user.click(await screen.findByRole('button', { name: /^Revoke Safari/ }));
    expect(api.revokePairedBrowser).toHaveBeenCalledWith('1c1f4a1b-2222-4333-8444-555566667777');
    await waitFor(() => expect(screen.queryByText('Safari on macOS')).not.toBeInTheDocument());
    expect(api.pairedBrowsers).toHaveBeenCalledTimes(2);
  });

  it('reports a failed revocation without claiming the browser was signed out', async () => {
    const api = {
      pairedBrowsers: vi.fn(async () => view()),
      revokePairedBrowser: vi.fn(async () => {
        throw new Error('offline');
      }),
    };
    const user = userEvent.setup();
    render(<PairedBrowsers api={api} />);
    await user.click(await screen.findByRole('button', { name: /^Revoke Safari/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Its access remains unchanged');
    expect(screen.getByText('Safari on macOS')).toBeVisible();
  });
});

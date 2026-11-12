import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type OwnerConfirmation, type WorkOrder } from '../api';
import PendingConfirmations from '../features/confirmations/PendingConfirmations';

function confirmation(changes: Partial<OwnerConfirmation> = {}): OwnerConfirmation {
  return {
    version: 1,
    id: 'confirmation-1',
    kind: 'budget.tokens',
    work_id: 'run-1',
    source: 'mcp',
    state: 'pending',
    summary: 'Raise the token limit from 100,000 to 250,000',
    request: { expected_revision: 1, expected_max_tokens: 100000, max_tokens: 250000 },
    request_digest: 'a'.repeat(64),
    created_at: '2026-11-12T09:00:00Z',
    expires_at: '2026-11-13T09:00:00Z',
    decided_at: null,
    error_code: null,
    error_message: null,
    ...changes,
  };
}

const orders = [{ id: 'run-1', objective: 'Correct empty input' }] as WorkOrder[];

type Decisions = Parameters<typeof PendingConfirmations>[0]['api'];

function mount(items: OwnerConfirmation[], api: Partial<Decisions>, connected = true) {
  const onChanged = vi.fn();
  const view = render(
    <MemoryRouter>
      <PendingConfirmations
        api={api as Decisions}
        items={items}
        orders={orders}
        connected={connected}
        onChanged={onChanged}
      />
    </MemoryRouter>,
  );
  return { onChanged, ...view };
}

describe('PendingConfirmations', () => {
  it('renders nothing when no request is pending', () => {
    const { container } = mount([confirmation({ state: 'applied' })], {});
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the exact request with its run and confirms it by its digest', async () => {
    const api = {
      confirmRequest: vi.fn(async () => confirmation({ state: 'applied' })),
      rejectRequest: vi.fn(),
    };
    const { onChanged } = mount([confirmation()], api);
    const user = userEvent.setup();
    const section = screen.getByRole('region', { name: 'A request is waiting for your confirmation' });
    expect(section).toHaveTextContent('Nothing changes until you confirm it here');
    expect(within(section).getByRole('link', { name: 'Correct empty input' })).toHaveAttribute(
      'href',
      '/runs/run-1',
    );
    await user.click(within(section).getByText('Exact request'));
    const request = within(section).getByRole('list', { hidden: true }).querySelector('dl');
    expect(request).toHaveTextContent('Expected max tokens');
    expect(request).toHaveTextContent('250,000');
    await user.click(
      screen.getByRole('button', { name: 'Confirm: Raise the token limit from 100,000 to 250,000' }),
    );
    expect(api.confirmRequest).toHaveBeenCalledExactlyOnceWith('confirmation-1', 'a'.repeat(64));
    expect(api.rejectRequest).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Applied: Raise the token limit from 100,000 to 250,000.',
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('rejects without confirming and says nothing changed', async () => {
    const api = {
      confirmRequest: vi.fn(),
      rejectRequest: vi.fn(async () => confirmation({ state: 'rejected' })),
    };
    mount(
      [
        confirmation(),
        confirmation({ id: 'confirmation-2', summary: 'Raise the model call limit from 40 to 80' }),
      ],
      api,
    );
    const user = userEvent.setup();
    expect(
      screen.getByRole('heading', { name: '2 requests are waiting for your confirmation' }),
    ).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'Reject: Raise the model call limit from 40 to 80' }),
    );
    expect(api.rejectRequest).toHaveBeenCalledExactlyOnceWith('confirmation-2', 'a'.repeat(64));
    expect(api.confirmRequest).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent('Nothing changed.');
  });

  it('never reports a refused or unknown outcome as applied', async () => {
    const results = [
      confirmation({ state: 'failed', error_code: 'STALE_BUDGET', error_message: 'The budget changed.' }),
      confirmation({ state: 'applying' }),
    ];
    const api = { confirmRequest: vi.fn(async () => results.shift()!), rejectRequest: vi.fn() };
    mount([confirmation()], api);
    const user = userEvent.setup();
    const confirm = () => screen.getByRole('button', { name: /^Confirm: / });
    await user.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not applied: Raise the token limit from 100,000 to 250,000. The budget changed. (STALE_BUDGET) Check the run before asking again.',
    );
    await user.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'is unknown. Inspect the run before asking again.',
    );
    expect(screen.queryByText(/^Applied/)).not.toBeInTheDocument();
  });

  it('shows the server refusal and keeps decisions disabled while disconnected', async () => {
    const api = {
      confirmRequest: vi.fn(async () => {
        throw new ApiError(409, 'This request was already decided or has expired');
      }),
      rejectRequest: vi.fn(),
    };
    const first = mount([confirmation()], api);
    await userEvent.setup().click(screen.getByRole('button', { name: /^Confirm: / }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This request was already decided or has expired',
    );
    expect(first.onChanged).toHaveBeenCalledOnce();
    first.unmount();
    mount([confirmation()], api, false);
    expect(screen.getByRole('button', { name: /^Confirm: / })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Reject: / })).toBeDisabled();
  });
});

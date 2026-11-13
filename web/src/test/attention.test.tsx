import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerConfirmation, WorkOrder } from '../api';
import AttentionToasts, { TOAST_MS, useAttentionToasts } from '../features/attention/AttentionToasts';
import {
  attentionTone,
  PROBLEM_WINDOW_MS,
  remember,
  remembered,
  runTransition,
  unresolved,
} from '../features/attention/attention';

const NOW = Date.parse('2026-11-13T12:00:00Z');

function confirmation(changes: Partial<OwnerConfirmation> = {}): OwnerConfirmation {
  return {
    version: 1,
    id: 'confirmation-1',
    kind: 'budget.amend',
    work_id: 'run-1',
    source: 'mcp',
    state: 'pending',
    summary: 'Change the token budget to 800,000, then resume the run',
    request: {},
    request_digest: 'a'.repeat(64),
    created_at: '2026-11-13T09:00:00Z',
    expires_at: '2026-11-14T09:00:00Z',
    decided_at: null,
    error_code: null,
    error_message: null,
    ...changes,
  };
}

type Run = Pick<WorkOrder, 'id' | 'objective' | 'status' | 'error_code'>;
const run = (status: string, error_code: string | null = null): Run =>
  ({ id: 'run-1', objective: 'Audit the example project', status, error_code }) as Run;

beforeEach(() => localStorage.clear());

describe('attention model', () => {
  it('keeps a refused or unknown decision until it is dismissed or a day old', () => {
    const failed = confirmation({ id: 'failed', state: 'failed', decided_at: '2026-11-13T11:00:00Z' });
    const unknown = confirmation({ id: 'unknown', state: 'applying', decided_at: '2026-11-13T11:00:00Z' });
    const settling = confirmation({ id: 'settling', state: 'applying', decided_at: '2026-11-13T11:59:30Z' });
    const old = confirmation({
      id: 'old',
      state: 'failed',
      decided_at: new Date(NOW - PROBLEM_WINDOW_MS - 1).toISOString(),
    });
    const others = [confirmation(), confirmation({ id: 'applied', state: 'applied' })];
    const items = [failed, unknown, settling, old, ...others];
    expect(unresolved(items, new Set(), NOW).map((item) => item.id)).toEqual(['failed', 'unknown']);
    expect(unresolved(items, new Set(['failed']), NOW).map((item) => item.id)).toEqual(['unknown']);
  });

  it('is red for a fault, amber for something that waits and silent otherwise', () => {
    expect(attentionTone({ problems: 1, failedRuns: 0, waiting: 3 })).toBe('danger');
    expect(attentionTone({ problems: 0, failedRuns: 1, waiting: 1 })).toBe('danger');
    expect(attentionTone({ problems: 0, failedRuns: 0, waiting: 2 })).toBe('warning');
    expect(attentionTone({ problems: 0, failedRuns: 0, waiting: 0 })).toBeNull();
  });

  it('announces only the transitions an owner acts on', () => {
    expect(runTransition(run('running'), undefined)).toBeNull();
    expect(runTransition(run('running'), 'queued')).toBeNull();
    expect(runTransition(run('blocked'), 'blocked')).toBeNull();
    expect(runTransition(run('completed'), 'running')).toMatchObject({
      tone: 'success',
      title: 'Run completed',
    });
    expect(runTransition(run('blocked', 'BUDGET_TOKENS'), 'running')).toMatchObject({
      tone: 'warning',
      title: 'Run blocked · BUDGET_TOKENS',
      run: 'run-1',
    });
    expect(runTransition(run('failed'), 'running')).toMatchObject({ tone: 'danger', title: 'Run failed' });
    expect(runTransition(run('waiting_input'), 'running')).toMatchObject({ tone: 'warning' });
  });

  it('remembers ids across reloads and survives unusable storage', () => {
    remember('dismissed', ['a', 'b']);
    remember('dismissed', ['b', 'c']);
    expect([...remembered('dismissed')]).toEqual(['a', 'b', 'c']);
    expect(remembered('announced').size).toBe(0);
    localStorage.setItem('sabre.attention.v1', '{not json');
    expect(remembered('dismissed').size).toBe(0);
    const broken = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => remember('announced', ['x'])).not.toThrow();
    broken.mockRestore();
  });
});

function Harness({
  orders,
  confirmations,
  inboxOpen = false,
  onReview = () => undefined,
}: {
  orders: Run[];
  confirmations: OwnerConfirmation[];
  inboxOpen?: boolean;
  onReview?: () => void;
}) {
  const { toasts, dismiss } = useAttentionToasts({ orders, confirmations, ready: true, inboxOpen });
  return (
    <MemoryRouter>
      <AttentionToasts toasts={toasts} docked={false} onDismiss={dismiss} onReview={onReview} />
    </MemoryRouter>
  );
}

describe('attention toasts', () => {
  it('says nothing about what was already there and announces a run that changes', async () => {
    const view = render(<Harness orders={[run('running')]} confirmations={[]} />);
    expect(screen.queryByTestId('attention-toast')).not.toBeInTheDocument();
    view.rerender(<Harness orders={[run('completed')]} confirmations={[]} />);
    const toast = await screen.findByTestId('attention-toast');
    expect(toast).toHaveTextContent('Run completed');
    expect(toast).toHaveTextContent('Audit the example project');
    expect(screen.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', '/runs/run-1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss: Run completed' }));
    expect(screen.queryByTestId('attention-toast')).not.toBeInTheDocument();
  });

  it('announces a request once, in this browser, and opens the inbox to review it', async () => {
    const onReview = vi.fn();
    const first = render(<Harness orders={[]} confirmations={[confirmation()]} onReview={onReview} />);
    expect(await screen.findByTestId('attention-toast')).toHaveTextContent(
      'An agent asks for your confirmation',
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('attention-toast')).not.toBeInTheDocument();
    first.unmount();
    // A reload: the request still waits in the inbox, but it is not announced again.
    render(<Harness orders={[]} confirmations={[confirmation()]} />);
    await act(async () => undefined);
    expect(screen.queryByTestId('attention-toast')).not.toBeInTheDocument();
  });

  it('does not announce a request while the inbox that shows it is open', async () => {
    const view = render(<Harness orders={[]} confirmations={[confirmation()]} inboxOpen />);
    await act(async () => undefined);
    expect(screen.queryByTestId('attention-toast')).not.toBeInTheDocument();
    view.rerender(<Harness orders={[]} confirmations={[confirmation()]} />);
    await act(async () => undefined);
    expect(screen.queryByTestId('attention-toast')).not.toBeInTheDocument();
  });

  it('leaves by itself and waits while the owner is reading it', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness orders={[]} confirmations={[confirmation()]} />);
      await act(async () => undefined);
      const toast = screen.getByTestId('attention-toast');
      act(() => toast.focus());
      act(() => {
        toast.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      });
      await act(async () => vi.advanceTimersByTime(TOAST_MS * 2));
      expect(screen.getByTestId('attention-toast')).toBeInTheDocument();
      act(() => {
        toast.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      await act(async () => vi.advanceTimersByTime(TOAST_MS + 50));
      expect(screen.queryByTestId('attention-toast')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

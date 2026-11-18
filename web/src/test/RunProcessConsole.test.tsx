import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import RunProcessConsole from '../RunProcessConsole';
import {
  createApi,
  type ProcessTopology,
  type RunUsageSnapshot,
  type SequencedEvent,
  type WorkOrder,
} from '../api';
import useRunUsage from '../useRunUsage';

function order(status: WorkOrder['status']): WorkOrder {
  return {
    id: status,
    phase: 'implementation',
    status,
    project_id: 'p',
    mode: 'patch',
    objective: `Run ${status}`,
    acceptance: ['Test acceptance'],
    constraints: [],
    budget: { max_cost_usd: 0, max_calls: 40, max_tokens: 100000, active_seconds: 3600, policy: null },
    idempotency_key: `fixture-${status}`,
    channel: 'mcp',
    channel_thread: null,
    flow_config: {
      version: 1,
      phases: {},
      phase_models: {},
      permissions: { architecture: true, dependency_changes: false, draft_pull_request: true },
      repair_cycles: 2,
      budget_policy: null,
    },
    resolved_flow: null,
    configuration_snapshot: null,
    admission_request_digest: null,
    effective_budget_policy: null,
    budget_revision: 0,
    limiting_metric: null,
    budget_denial: null,
    repair_cycles_used: 0,
    last_failure_fingerprint: null,
    identical_failure_count: 0,
    last_failure_cycle: -1,
    graph_version: 'sabre-v1',
    plan_revision: 1,
    created_at: '2026-11-07T12:00:00Z',
    updated_at: '2026-11-07T12:00:00Z',
    tasks: [],
    questions: [],
    findings: [],
    security_snapshot_digest: null,
    security_rules_version: null,
    evidence: null,
    summary: 'Persisted summary',
    error_code: null,
    calls_used: 0,
    tokens_used: 0,
    cost_usd: 0,
    active_seconds_used: 0,
    control: null,
  };
}

const topology: ProcessTopology = {
  version: 1,
  graph_version: 'sabre-v1',
  mode: 'patch',
  alternatives: [],
  stations: [],
  loops: [],
  lanes: [
    { id: 'spec', label: 'Spec', specialist: 'PM', stages: ['analyze', 'clarify'], next: ['build'] },
    { id: 'build', label: 'Build', specialist: 'Developer', stages: ['implement'], next: [] },
  ],
};
function event(sequence: number, name: string, correlation: string): SequencedEvent {
  return {
    sequence,
    event: {
      version: 1,
      id: `event-${sequence}`,
      work_id: 'synthetic-run',
      plan_revision: 1,
      phase: name,
      correlation_id: correlation,
      parent_id: null,
      kind: 'stage',
      state: 'completed',
      name,
      timestamp: `2026-11-07T12:00:${String(sequence).padStart(2, '0')}Z`,
      duration_ms: 500,
      error_code: null,
      provider: null,
      model: null,
      trace_id: null,
      span_id: null,
    },
  };
}
function failed(sequence: number, name: string, correlation: string, code: string): SequencedEvent {
  const base = event(sequence, name, correlation);
  return { ...base, event: { ...base.event, state: 'failed', error_code: code } };
}

describe('Recorded step errors', () => {
  const inspectorNotice = () => within(screen.getByRole('region', { name: 'Execution inspector' }));

  it('retains the failed attempt as history after a saved authorization covers it', () => {
    render(
      <RunProcessConsole
        order={{
          ...order('blocked'),
          error_code: 'BUDGET_TOKENS',
          budget_denial: {
            version: 1,
            metric: 'tokens',
            basis: 'next_reservation',
            used: 900,
            reserved: 0,
            requested: 600,
            required: 1500,
            limit: 1000,
          },
          effective_budget_policy: {
            version: 1,
            tokens: { primary: null, reserve: 0, absolute: null },
            invocations: { primary: 20, reserve: 0, absolute: 20 },
            active_seconds: { primary: 900, reserve: 0, absolute: 900 },
            repairs: { primary: 2, reserve: 0, absolute: 2 },
            no_progress_threshold: 3,
          },
        }}
        topology={topology}
        entries={[failed(1, 'implement', 'checks', 'BUDGET_TOKENS')]}
      />,
    );
    expect(inspectorNotice().getByText(/Historical record · BUDGET_TOKENS/)).toBeVisible();
    expect(inspectorNotice().queryByText(/Current stop reason/)).not.toBeInTheDocument();
  });

  it('explains only the latest failed step with the current summary while the run is blocked', async () => {
    const user = userEvent.setup();
    const blocked = {
      ...order('blocked'),
      error_code: 'BUDGET_EXHAUSTED',
      summary: 'The budget does not allow another model call',
    };
    render(
      <RunProcessConsole
        order={blocked}
        topology={topology}
        entries={[
          failed(1, 'implement', 'attempt-1', 'BUDGET_EXHAUSTED'),
          failed(2, 'implement', 'attempt-2', 'BUDGET_EXHAUSTED'),
        ]}
      />,
    );
    expect(inspectorNotice().getByText('Current stop reason · BUDGET_EXHAUSTED')).toBeVisible();
    expect(inspectorNotice().getByText('The budget does not allow another model call')).toBeVisible();
    const attempts = screen.getAllByRole('button', { name: 'implement · failed' });
    expect(attempts).toHaveLength(2);
    await user.click(attempts[0]);
    expect(inspectorNotice().getByText(/Historical record · BUDGET_EXHAUSTED · event #1/)).toBeVisible();
    expect(
      inspectorNotice().queryByText('The budget does not allow another model call'),
    ).not.toBeInTheDocument();
  });

  it('labels a failed step as a historical record once the run is cancelled', () => {
    const cancelled = {
      ...order('cancelled'),
      error_code: 'BUDGET_EXHAUSTED',
      control: 'cancel' as const,
      summary: 'Work order cancelled',
    };
    render(
      <RunProcessConsole
        order={cancelled}
        topology={topology}
        entries={[failed(1, 'implement', 'checks', 'BUDGET_EXHAUSTED')]}
      />,
    );
    expect(inspectorNotice().getByText(/Historical record · BUDGET_EXHAUSTED · event #1/)).toBeVisible();
    expect(inspectorNotice().queryByText('Work order cancelled')).not.toBeInTheDocument();
    expect(inspectorNotice().queryByText(/Current stop reason/)).not.toBeInTheDocument();
  });

  it('presents an owner pause or cancellation on a step as a control outcome', () => {
    render(
      <RunProcessConsole
        order={{ ...order('cancelled'), error_code: 'CANCEL_REQUESTED', summary: 'Cancellation requested' }}
        topology={topology}
        entries={[failed(1, 'implement', 'stopped', 'CANCEL_REQUESTED')]}
      />,
    );
    expect(screen.getByRole('button', { name: 'implement · interrupted' })).toBeInTheDocument();
    expect(inspectorNotice().getByText(/Stopped by an owner pause or cancellation request/)).toBeVisible();
  });
});

describe('Recorded process console', () => {
  it('expands the existing workspace, retains inspection and zoom, then restores operator focus', async () => {
    const user = userEvent.setup();
    const view = render(
      <>
        <button>Outside the workspace</button>
        <RunProcessConsole
          order={order('paused')}
          topology={topology}
          entries={[event(1, 'analyze', 'first')]}
        />
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Outside the workspace' });
    await user.click(screen.getByRole('button', { name: 'analyze · completed' }));
    await user.click(screen.getByRole('tab', { name: 'JSON' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in timeline' }));
    await user.click(screen.getByRole('button', { name: 'Expand workspace' }));
    const expanded = screen.getByRole('dialog', { name: 'Expanded run workspace' });
    expect(outside.inert).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(within(expanded).getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true');
    expect(within(expanded).getByRole('button', { name: 'analyze · completed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(expanded).getByText('200%')).toBeVisible();
    fireEvent.keyDown(expanded, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(outside.inert).toBeFalsy();
    expect(document.body.style.overflow).toBe('');
    expect(screen.getByRole('button', { name: 'Expand workspace' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('button', { name: 'Fit timeline' }));
    expect(screen.getByText('100%')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Expand workspace' }));
    view.unmount();
    expect(document.body.style.overflow).toBe('');
  });
  it('keeps expected phases separate from observed steps and labels only actual repeated steps as attempts', () => {
    render(
      <RunProcessConsole
        order={order('paused')}
        topology={topology}
        entries={[
          event(1, 'analyze', 'first'),
          event(2, 'clarify', 'clarify'),
          event(3, 'analyze', 'second'),
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /Build.*Developer.*Planned/ })).toBeVisible();
    expect(screen.getByText('Waiting for this phase')).toBeVisible();
    const analyze = screen.getAllByRole('button', { name: 'analyze · completed' });
    expect(within(analyze[0]).getByText(/attempt 1/)).toBeVisible();
    expect(within(analyze[1]).getByText(/attempt 2/)).toBeVisible();
    expect(
      within(screen.getByRole('button', { name: 'clarify · completed' })).queryByText(/attempt/),
    ).not.toBeInTheDocument();
  });
  it('pins a selected step across new events and exposes a dismissible keyboard preview', async () => {
    const user = userEvent.setup();
    const onInspect = vi.fn();
    const entries = [event(1, 'analyze', 'first')];
    const view = render(
      <RunProcessConsole
        order={order('paused')}
        topology={topology}
        entries={entries}
        onInspect={onInspect}
      />,
    );
    const selected = screen.getByRole('button', { name: 'analyze · completed' });
    await user.click(selected);
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('tooltip')).toHaveTextContent('analyze');
    fireEvent.keyDown(selected, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    view.rerender(
      <RunProcessConsole
        order={order('paused')}
        topology={topology}
        entries={[...entries, event(2, 'implement', 'next')]}
        onInspect={onInspect}
      />,
    );
    expect(screen.getByRole('button', { name: 'analyze · completed' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'implement · completed' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(onInspect).toHaveBeenCalledTimes(1);
  });
  it('shows a failed model call with its failure class next to the agent that made it', async () => {
    const user = userEvent.setup();
    const agent = event(1, 'analyst', 'agent');
    const call = failed(2, 'rate limit', 'failed-call', 'MODEL_RATE_LIMITED');
    render(
      <RunProcessConsole
        order={order('blocked')}
        topology={topology}
        entries={[
          { ...agent, event: { ...agent.event, kind: 'agent', phase: 'analyze' } },
          // A failed call has no "started" record: it is drawn from its own duration.
          {
            ...call,
            event: {
              ...call.event,
              kind: 'model',
              phase: 'analyze',
              parent_id: 'agent',
              provider: 'anthropic',
            },
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Spec.*PM.*2 actions/ }));
    const rows = screen.getAllByTestId('timeline-child-row');
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^modelrate limit/)]),
    );
    expect(screen.getByRole('button', { name: 'rate limit · failed' })).toBeVisible();
  });

  it('binds a selected agent attempt to its recorded invocation rather than the latest agent with the same role', async () => {
    const user = userEvent.setup();
    const onInspect = vi.fn();
    const entries = [event(1, 'developer', 'first-agent'), event(2, 'developer', 'second-agent')].map(
      (item, index) => ({
        ...item,
        event: {
          ...item.event,
          kind: 'agent' as const,
          phase: 'analyze',
          agent_id: (index ? 'b' : 'a').repeat(64),
        },
      }),
    );
    render(
      <RunProcessConsole
        order={order('paused')}
        topology={topology}
        entries={entries}
        onInspect={onInspect}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Spec.*PM.*2 actions/ }));
    await user.click(screen.getAllByRole('button', { name: 'developer · completed' })[0]);
    expect(onInspect).toHaveBeenLastCalledWith('developer', 'a'.repeat(64));
    await user.click(screen.getAllByRole('button', { name: 'developer · completed' })[1]);
    expect(onInspect).toHaveBeenLastCalledWith('developer', 'b'.repeat(64));
  });
  it('keeps and labels a pinned historical selection after its event leaves the bounded live window', async () => {
    const user = userEvent.setup();
    const view = render(
      <RunProcessConsole
        order={order('paused')}
        topology={topology}
        entries={[event(1, 'analyze', 'first')]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'analyze · completed' }));
    view.rerender(
      <RunProcessConsole
        order={order('paused')}
        topology={topology}
        entries={[event(2, 'implement', 'latest-window')]}
      />,
    );
    expect(screen.getByText(/Pinned historical event/)).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Execution inspector' })).getByRole('heading', {
        name: 'analyze',
      }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'implement · completed' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

function liveSnapshot(
  measured = 100,
  calls = 1,
  unsettled = 0,
  reported: number | null = null,
): RunUsageSnapshot {
  return {
    version: 1,
    work_id: 'synthetic-live',
    usage: {
      calls,
      settled_calls: calls - unsettled,
      unsettled_calls: unsettled,
      tokens: measured + unsettled * 1000,
      measured_tokens: measured,
      unknown_reserved_tokens: unsettled * 1000,
      cost_usd: 2.5,
    },
    measured_api_cost_usd: unsettled === calls ? null : 0.25,
    reserved_api_cost_usd: unsettled ? 2.25 : 0,
    reported_cost_usd: reported,
  };
}
function UsageConsole({
  api,
  connected = true,
  status = 'running',
  id = 'synthetic-live',
}: {
  api: ReturnType<typeof createApi>;
  connected?: boolean;
  status?: WorkOrder['status'];
  id?: string;
}) {
  const liveUsage = useRunUsage(api, id, status, connected);
  return <RunProcessConsole order={{ ...order(status), id }} entries={[]} liveUsage={liveUsage} />;
}
const flushUsage = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

describe('Live ledger usage', () => {
  it('updates within the same phase, preserves disconnected values, and refreshes once at cancellation', async () => {
    vi.useFakeTimers();
    try {
      let snapshot = liveSnapshot();
      const fetch = vi.fn(async (input: string) => {
        if (!input.endsWith('/synthetic-live/usage')) throw new Error('Unexpected fixture request');
        return Response.json(snapshot);
      });
      vi.stubGlobal('fetch', fetch);
      const api = createApi('synthetic-csrf');
      const view = render(<UsageConsole api={api} />);
      await flushUsage();
      const readout = screen.getByLabelText('Recorded run state');
      expect(within(readout).getByText('100', { exact: true })).toBeVisible();
      expect(within(readout).getByText('$0.2500', { exact: true })).toBeVisible();
      // Nothing was reported by the provider, so nothing is said about a reported cost.
      expect(within(readout).queryByText(/reported/)).not.toBeInTheDocument();
      snapshot = liveSnapshot(100, 1, 0, 0.0421);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      // A cost the CLI session reported is shown as reported, beside the recorded API cost.
      expect(within(readout).getByText(/The CLI session reported \$0\.0421 at API rates/)).toBeVisible();
      snapshot = liveSnapshot(750, 3, 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(within(readout).getByText('750', { exact: true })).toBeVisible();
      expect(within(readout).getByText('Model calls').parentElement).toHaveTextContent('3 / 40');
      expect(within(readout).getByText(/1 calls pending.*1,000 tokens reserved/)).toBeVisible();
      expect(within(readout).getByText('$0.2500', { exact: true })).toBeVisible();
      expect(within(readout).getByText(/\$2.2500 reserved.*pending cost unknown/)).toBeVisible();
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls.every((call) => String(call[0]).endsWith('/synthetic-live/usage'))).toBe(true);
      view.rerender(<UsageConsole api={api} connected={false} />);
      expect(screen.getByText(/Disconnected.*snapshot; it may be stale/)).toHaveAttribute('role', 'status');
      expect(within(readout).getByText('750', { exact: true })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Retry usage' })).toBeDisabled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(fetch).toHaveBeenCalledTimes(3);
      snapshot = liveSnapshot(900, 4);
      view.rerender(<UsageConsole api={api} status="cancelled" />);
      await flushUsage();
      expect(within(readout).getByText('900', { exact: true })).toBeVisible();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(fetch).toHaveBeenCalledTimes(4);
      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
  it('retains a stale snapshot after failure, stops polling and recovers only on explicit retry', async () => {
    vi.useFakeTimers();
    try {
      let failed = false;
      const fetch = vi.fn(async () =>
        failed
          ? Response.json({ message: 'Synthetic outage' }, { status: 503 })
          : Response.json(liveSnapshot()),
      );
      vi.stubGlobal('fetch', fetch);
      const api = createApi('synthetic-csrf');
      const view = render(<UsageConsole api={api} />);
      await flushUsage();
      failed = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByRole('alert')).toHaveTextContent('may be stale');
      expect(screen.getByText('100', { exact: true })).toBeVisible();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      failed = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry usage' }));
      await flushUsage();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(fetch).toHaveBeenCalledTimes(3);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it('aborts pending work on unmount and never invents zero usage or settled cost for an unsettled call', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      let finish: (value: Response) => void = () => {};
      const fetch = vi.fn((_input: string, options: RequestInit) => {
        requestSignal = options.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      });
      vi.stubGlobal('fetch', fetch);
      const api = createApi('synthetic-csrf');
      const view = render(<UsageConsole api={api} />);
      await flushUsage();
      expect(screen.getAllByText('Not available')).toHaveLength(2);
      expect(screen.getByText('Unknown', { exact: true })).toBeVisible();
      view.unmount();
      expect(requestSignal?.aborted).toBe(true);
      finish(Response.json(liveSnapshot(0, 1, 1)));
      await flushUsage();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(liveSnapshot(0, 1, 1))),
      );
      const next = render(<UsageConsole api={api} status="blocked" />);
      await flushUsage();
      expect(screen.getByText('Unknown', { exact: true })).toBeVisible();
      expect(screen.getByText(/1 calls pending.*1,000 tokens reserved/)).toBeVisible();
      expect(screen.getByText(/\$2.2500 reserved.*pending cost unknown/)).toBeVisible();
      next.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Idle time', () => {
  const at = (sequence: number, name: string, timestamp: string): SequencedEvent => {
    const base = event(sequence, name, `stage-${sequence}`);
    return { ...base, event: { ...base.event, timestamp, duration_ms: 60_000 } };
  };
  const entries = [
    at(1, 'analyze', '2026-11-07T12:01:00Z'),
    at(2, 'implement', '2026-11-07T12:03:00Z'),
    at(3, 'implement', '2026-11-07T14:01:00Z'),
  ];

  it('draws a long pause as a narrow labelled band that the owner can expand back to scale', async () => {
    const user = userEvent.setup();
    render(<RunProcessConsole order={order('completed')} topology={topology} entries={entries} />);
    const toggle = screen.getByRole('button', { name: 'Collapse idle time' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId('idle-band')).toHaveLength(1);
    expect(screen.getByText('1 h 57 min idle')).toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('idle-band')).not.toBeInTheDocument();
  });

  it('offers no idle control when the run never paused for long', () => {
    render(
      <RunProcessConsole
        order={order('completed')}
        topology={topology}
        entries={[at(1, 'analyze', '2026-11-07T12:01:00Z'), at(2, 'implement', '2026-11-07T12:02:30Z')]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Collapse idle time' })).not.toBeInTheDocument();
  });
});

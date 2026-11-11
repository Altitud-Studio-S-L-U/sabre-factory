import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import RunProcessConsole from '../RunProcessConsole';
import type { ProcessTopology, SequencedEvent, WorkOrder } from '../api';

function order(status: WorkOrder['status']): WorkOrder {
  return {
    id: status,
    phase: 'implementation',
    status,
    project_id: 'p',
    mode: 'patch',
    objective: `Run ${status}`,
    acceptance: ['Aceptación de prueba'],
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
    summary: 'Resumen persistido',
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
describe('Recorded process console', () => {
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

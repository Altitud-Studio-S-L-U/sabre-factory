import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FactoryOverview from '../FactoryOverview';
import type { WorkOrder } from '../api';

function order(id: string, phase: string, status: WorkOrder['status']): WorkOrder {
  return {
    id,
    phase,
    status,
    project_id: 'p',
    mode: 'patch',
    objective: `Run ${id}`,
    acceptance: ['Regresión corregida'],
    budget: { max_cost_usd: 1, max_calls: 40, max_tokens: 100000, active_seconds: 3600, policy: null },
    idempotency_key: `fixture-${id}`,
    constraints: [],
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
    created_at: '2026-11-06T10:00:00Z',
    updated_at: '2026-11-06T10:01:00Z',
    tasks: [],
    questions: [],
    findings: [],
    security_snapshot_digest: null,
    security_rules_version: null,
    evidence: null,
    summary: 'Estado de prueba',
    error_code: null,
    calls_used: 0,
    tokens_used: 0,
    cost_usd: 0,
    active_seconds_used: 0,
    control: null,
  };
}

describe('factory production line', () => {
  it('shows an occupied CLI without presenting it as a disconnected session', () => {
    render(
      <FactoryOverview
        orders={[]}
        projects={[]}
        status={{ model: { cli: { available: true, authenticated: null, busy: true } } }}
        onOpen={vi.fn()}
        onView={vi.fn()}
      />,
    );
    expect(screen.getByText('Codex is processing an invocation')).toBeInTheDocument();
    expect(screen.queryByText('Codex session needs connection')).not.toBeInTheDocument();
  });
  it('keeps waiting work in its stage without claiming completed or cancelled work is active', () => {
    const onOpen = vi.fn();
    const waiting = order('waiting', 'analysis', 'waiting_input');
    render(
      <FactoryOverview
        orders={[waiting, order('done', 'analysis', 'completed'), order('stopped', 'analysis', 'cancelled')]}
        projects={[]}
        status={{}}
        onOpen={onOpen}
        onView={vi.fn()}
      />,
    );
    const line = screen.getByRole('region', { name: 'Factory phases' });
    expect(within(line).getByText('Decision needed')).toBeInTheDocument();
    expect(within(line).queryByText('Run done')).not.toBeInTheDocument();
    expect(within(line).queryByText('Run stopped')).not.toBeInTheDocument();
    fireEvent.click(within(line).getByRole('button', { name: /Run waiting/ }));
    expect(onOpen).toHaveBeenCalledWith(waiting);
  });

  it('shows security work in its own lane and retains unknown phases', () => {
    render(
      <FactoryOverview
        orders={[order('watch', 'security_watch', 'running'), order('future', 'new-stage', 'paused')]}
        projects={[]}
        status={{}}
        onOpen={vi.fn()}
        onView={vi.fn()}
      />,
    );
    const line = screen.getByRole('region', { name: 'Factory phases' });
    expect(within(line).queryByText('Run watch')).not.toBeInTheDocument();
    expect(screen.getByText('Run watch')).toBeInTheDocument();
    expect(screen.getByText('Other recorded phases')).toBeInTheDocument();
    expect(screen.getByText('Run future')).toBeInTheDocument();
  });

  it('distinguishes configured telemetry from measured health and links to memory', () => {
    const onView = vi.fn();
    render(
      <FactoryOverview
        orders={[]}
        projects={[]}
        status={{
          roles: { developer: { configured: true }, reviewer: { configured: false } },
          memory: { store: 'postgres-pgvector', semantic_search: false },
          telemetry: { configured: true },
        }}
        onOpen={vi.fn()}
        onView={onView}
      />,
    );
    expect(screen.getByText('1 of 2 configured roles')).toBeInTheDocument();
    expect(screen.getByText('Trace export configured')).toBeInTheDocument();
    expect(screen.queryByText(/trazas saludables/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Memory/ }));
    expect(onView).toHaveBeenCalledWith('memory');
  });
});

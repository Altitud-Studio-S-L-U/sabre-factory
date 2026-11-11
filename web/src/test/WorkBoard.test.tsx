import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WorkBoard from '../WorkBoard';
import type { Project, WorkOrder } from '../api';

const project: Project = {
  id: 'p',
  name: 'Project de prueba',
  repository: 'https://github.com/example/fixture',
  profile: 'node',
  default_branch: 'main',
  gate_commands: [['npm', 'test']],
  allowed_mcp_servers: [],
  approved_baseline: [],
  browser_preview: null,
  created_at: '2026-11-07T12:00:00Z',
};
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
    summary: 'Resumen persistido',
    error_code: null,
    calls_used: 0,
    tokens_used: 0,
    cost_usd: 0,
    active_seconds_used: 0,
    control: null,
  };
}

describe('Run board', () => {
  it('agrupa todos los estados reales y abre el mismo encargo sin ofrecer reordenación ficticia', () => {
    const onOpen = vi.fn();
    const statuses: WorkOrder['status'][] = [
      'queued',
      'running',
      'waiting_input',
      'paused',
      'blocked',
      'failed',
      'completed',
      'cancelled',
    ];
    const orders = statuses.map(order);
    render(<WorkBoard orders={orders} projects={[project]} onOpen={onOpen} />);
    expect(within(screen.getByRole('region', { name: 'Pending' })).getAllByRole('button')).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: 'Running' })).getAllByRole('button')).toHaveLength(1);
    const waiting = screen.getByRole('region', { name: 'Waiting' });
    expect(within(waiting).getAllByRole('button')).toHaveLength(4);
    expect(within(waiting).getByText('Failed')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Finished' })).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(within(waiting).getByRole('button', { name: /Run blocked/ }));
    expect(onOpen).toHaveBeenCalledWith(orders[4]);
    expect(document.querySelector('[draggable="true"]')).not.toBeInTheDocument();
  });

  it('identifica la vigilancia como tal y conserva fases desconocidas sin inventar una etapa', () => {
    const watch = { ...order('completed'), phase: 'security_watch', objective: 'Vigilar dependencias' };
    const future = { ...order('queued'), phase: 'future-phase', project_id: 'missing' };
    render(<WorkBoard orders={[watch, future]} projects={[project]} onOpen={vi.fn()} />);
    const card = screen.getByRole('button', { name: /Vigilar dependencias/ });
    expect(within(card).getByText('Security monitoring')).toBeVisible();
    expect(within(card).queryByText('Patch')).not.toBeInTheDocument();
    expect(screen.getByText('Phase: future-phase')).toBeVisible();
    expect(screen.getByText('Project unavailable')).toBeVisible();
    expect(screen.getAllByText('No runs in this state')).toHaveLength(2);
  });
});

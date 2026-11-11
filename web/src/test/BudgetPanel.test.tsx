import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import BudgetPanel from '../BudgetPanel';
import { createApi, type BudgetView, type WorkOrder } from '../api';

const work: WorkOrder = {
  id: 'synthetic-budget-work',
  project_id: 'synthetic-project',
  mode: 'patch',
  objective: 'Correct the synthetic fixture',
  acceptance: ['Tests pass'],
  constraints: [],
  budget: { max_calls: 40, max_tokens: 100000, active_seconds: 3600, max_cost_usd: 0, policy: null },
  idempotency_key: 'synthetic-work-key',
  channel: 'web',
  channel_thread: null,
  status: 'blocked',
  phase: 'implementation',
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
  budget_revision: 7,
  limiting_metric: 'tokens',
  budget_denial: null,
  repair_cycles_used: 1,
  last_failure_fingerprint: null,
  identical_failure_count: 0,
  last_failure_cycle: -1,
  graph_version: 'sabre-v1',
  plan_revision: 1,
  created_at: '2026-11-11T12:00:00Z',
  updated_at: '2026-11-11T12:00:00Z',
  tasks: [],
  questions: [],
  findings: [],
  security_snapshot_digest: null,
  security_rules_version: null,
  evidence: null,
  summary: 'Synthetic budget pause',
  error_code: 'TOKEN_BUDGET_EXHAUSTED',
  calls_used: 4,
  tokens_used: 0,
  cost_usd: 0,
  active_seconds_used: 20,
  control: null,
};
const snapshot: BudgetView = {
  version: 1,
  denial: null,
  revision: 7,
  metrics: {
    tokens: {
      policy: { primary: 1000, reserve: 200, absolute: 1200 },
      used: null,
      reserved: 900,
      remaining: 100,
      unknown: true,
    },
    invocations: {
      policy: { primary: 40, reserve: 0, absolute: 40 },
      used: 4,
      reserved: 0,
      remaining: 36,
      unknown: false,
    },
    active_seconds: {
      policy: { primary: null, reserve: 0, absolute: null },
      used: 20,
      reserved: 0,
      remaining: null,
      unknown: false,
    },
    repairs: {
      policy: { primary: 2, reserve: 0, absolute: 2 },
      used: 1,
      reserved: 0,
      remaining: 1,
      unknown: false,
    },
  },
  authorizations: [],
  limiting_metric: 'tokens',
  pending_step: 'implementation',
  token_prevention: 'cli_post_invocation',
  unsettled_usage_ids: ['synthetic-usage-1', 'synthetic-usage-2'],
  unreconciled_calls: 2,
};

function connect(options: { loseFirst?: boolean; stale?: boolean } = {}) {
  const writes: Record<string, unknown>[] = [];
  let revision = 7;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, request: RequestInit = {}) => {
      if (!request.method) return Response.json({ ...snapshot, revision });
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      writes.push(body);
      if (options.loseFirst && writes.length === 1) throw new TypeError('Synthetic lost response');
      if (options.stale) {
        revision = 8;
        return Response.json(
          { message: 'The budget revision changed; refresh before saving.' },
          { status: 409 },
        );
      }
      revision = 8;
      return Response.json({
        version: 1,
        command_id: body.idempotency_key,
        correlation_id: body.correlation_id,
        work_id: work.id,
        phase: work.phase,
        work: { ...work, budget_revision: revision },
      });
    }),
  );
  return { api: createApi('synthetic-csrf'), writes };
}

it('preserves unknown consumption, reservations and independent policy ceilings', async () => {
  const { api } = connect();
  render(<BudgetPanel api={api} work={work} />);
  await screen.findByText('Authorization revision 7');
  const tokens = screen.getByRole('row', { name: /Tokens Unknown 900/ });
  expect(within(tokens).getByText('Unknown')).toBeInTheDocument();
  expect(within(tokens).getByText('Unsettled usage')).toBeInTheDocument();
  expect(within(tokens).getByText('1,200')).toBeInTheDocument();
  expect(
    screen.getByText(/CLI aggregate token usage can be known only after an invocation/),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Amend limits' })).toBeEnabled();
});

it('validates integer ceilings and submits a revision-bound receipt without resuming', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect();
  render(<BudgetPanel api={api} work={work} />);
  await user.click(await screen.findByRole('button', { name: 'Amend limits' }));
  const dialog = screen.getByRole('dialog', { name: 'Amend run limits' });
  await user.type(
    within(dialog).getByLabelText('Reason for this authorization'),
    'Authorize a bounded synthetic correction',
  );
  const primary = within(dialog).getByLabelText('Primary ceiling');
  fireEvent.change(primary, { target: { value: '1.5' } });
  expect(within(dialog).getByRole('button', { name: 'Save limits' })).toBeDisabled();
  fireEvent.change(primary, { target: { value: '1500' } });
  await user.click(within(dialog).getByRole('button', { name: 'Save limits' }));
  await screen.findByText('Limits saved. The run was not resumed.');
  const body = writes[0];
  expect(body).toMatchObject({
    version: 1,
    payload: {
      type: 'work.budget.amend',
      work_id: work.id,
      request: {
        version: 1,
        expected_revision: 7,
        metric: 'tokens',
        policy: { primary: 1500, reserve: 200, absolute: 1700 },
        resume: false,
      },
    },
  });
  expect(body.idempotency_key).toEqual(body.correlation_id);
  expect(writes).toHaveLength(1);
});

it('retries a lost response with the same locked candidate and command receipt', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect({ loseFirst: true });
  render(<BudgetPanel api={api} work={work} />);
  await user.click(await screen.findByRole('button', { name: 'Amend limits' }));
  const dialog = screen.getByRole('dialog', { name: 'Amend run limits' });
  await user.type(
    within(dialog).getByLabelText('Reason for this authorization'),
    'Retry a synthetic authorization',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Save limits' }));
  const retry = await within(dialog).findByRole('button', { name: 'Retry exact command' });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(within(dialog).getByLabelText('Primary ceiling')).toBeDisabled();
  await user.click(retry);
  await screen.findByText('Limits saved. The run was not resumed.');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
});

it('requires inspection after a stale authorization instead of silently replaying against a new revision', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect({ stale: true });
  render(<BudgetPanel api={api} work={work} />);
  await user.click(await screen.findByRole('button', { name: 'Amend limits' }));
  const dialog = screen.getByRole('dialog', { name: 'Amend run limits' });
  await user.type(
    within(dialog).getByLabelText('Reason for this authorization'),
    'A synthetic stale revision',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Save limits' }));
  await within(dialog).findByText('The budget revision changed; refresh before saving.');
  await user.click(within(dialog).getByRole('button', { name: 'Inspect current limits' }));
  await screen.findByText('Authorization revision 8');
  expect(writes).toHaveLength(1);
});

it('reconciles only selected unknown reservations and does not fabricate measured tokens', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect();
  render(<BudgetPanel api={api} work={work} />);
  await user.click(await screen.findByRole('button', { name: 'Review unsettled usage (2)' }));
  const dialog = screen.getByRole('dialog', { name: 'Review unsettled usage' });
  await user.click(within(dialog).getByRole('checkbox', { name: 'synthetic-usage-1' }));
  await user.type(
    within(dialog).getByLabelText('Reason for this authorization'),
    'Retain the complete unknown reservation',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Retain selected reservations' }));
  await screen.findByText('Selected reservations retained as unknown usage. The run was not resumed.');
  expect(writes[0]).toMatchObject({
    payload: {
      type: 'work.budget.reconcile',
      work_id: work.id,
      request: { version: 1, expected_revision: 7, usage_ids: ['synthetic-usage-1'] },
    },
  });
  expect(screen.getByRole('row', { name: /Tokens Unknown 900/ })).toBeInTheDocument();
});

it('blocks amendments while the run is executing', async () => {
  const { api } = connect();
  render(<BudgetPanel api={api} work={{ ...work, status: 'running' }} />);
  await screen.findByText('Authorization revision 7');
  expect(screen.getByRole('button', { name: 'Amend limits' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Review unsettled usage (2)' })).toBeDisabled();
});

it('preserves the inspected snapshot and draft while disabling mutations on disconnect', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect();
  const view = render(<BudgetPanel api={api} work={work} connected />);
  await user.click(await screen.findByRole('button', { name: 'Amend limits' }));
  const dialog = screen.getByRole('dialog', { name: 'Amend run limits' });
  await user.type(
    within(dialog).getByLabelText('Reason for this authorization'),
    'A retained synthetic draft',
  );
  view.rerender(<BudgetPanel api={api} work={work} connected={false} />);
  expect(screen.getByText('Authorization revision 7')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Reason for this authorization')).toHaveValue(
    'A retained synthetic draft',
  );
  expect(within(dialog).getByRole('button', { name: 'Save limits' })).toBeDisabled();
  expect(screen.getByText(/Disconnected. Budget changes are unavailable/)).toBeInTheDocument();
  expect(writes).toHaveLength(0);
});

it('offers a budget decision without changing a ceiling or resuming automatically', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect();
  render(<BudgetPanel api={api} work={{ ...work, error_code: 'BUDGET_EXHAUSTED' }} />);
  const decision = await screen.findByRole('region', { name: 'Budget decision' });
  expect(within(decision).getByText('Budget authorization required — choose how to continue')).toBeInTheDocument();
  await user.click(within(decision).getByRole('button', { name: 'Set a new limit' }));
  const dialog = screen.getByRole('dialog', { name: 'Amend run limits' });
  expect(within(dialog).getByLabelText('Cumulative limit policy')).toHaveValue('bounded');
  expect(within(dialog).getByLabelText('Resume this run after saving the limits')).not.toBeChecked();
  expect(writes).toHaveLength(0);
});

it('requires explicit authorization to remove one ceiling and blocks resume with unsettled usage', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect();
  render(<BudgetPanel api={api} work={work} />);
  await user.click(await screen.findByRole('button', { name: 'Remove a ceiling' }));
  const dialog = screen.getByRole('dialog', { name: 'Amend run limits' });
  expect(within(dialog).getByText(/This removes the cumulative tokens ceiling/)).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Resume this run after saving the limits')).toBeDisabled();
  expect(within(dialog).getByRole('button', { name: 'Save limits' })).toBeDisabled();
  await user.type(
    within(dialog).getByLabelText('Reason for this authorization'),
    'Remove the synthetic token cap',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Save limits' }));
  await screen.findByText('Limits saved. The run was not resumed.');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    payload: {
      request: {
        metric: 'tokens',
        policy: { primary: null, reserve: 0, absolute: null },
        resume: false,
      },
    },
  });
});

it('requests a resume only when the owner opts in after reviewing a new limit', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect();
  vi.spyOn(api, 'workBudget').mockResolvedValue({
    ...snapshot,
    unsettled_usage_ids: [],
    unreconciled_calls: 0,
  });
  render(<BudgetPanel api={api} work={work} />);
  await user.click(await screen.findByRole('button', { name: 'Set a new limit' }));
  const dialog = screen.getByRole('dialog', { name: 'Amend run limits' });
  fireEvent.change(within(dialog).getByLabelText('Primary ceiling'), { target: { value: '5000' } });
  await user.type(
    within(dialog).getByLabelText('Reason for this authorization'),
    'Authorize another bounded attempt',
  );
  await user.click(within(dialog).getByLabelText('Resume this run after saving the limits'));
  expect(writes).toHaveLength(0);
  await user.click(within(dialog).getByRole('button', { name: 'Save limits and resume' }));
  await screen.findByText('Limits saved. Resume requested; the run remains subject to its other controls.');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    payload: {
      request: {
        expected_revision: 7,
        metric: 'tokens',
        policy: { primary: 5000, reserve: 0, absolute: 5000 },
        resume: true,
      },
    },
  });
});

it('does not suggest removing cumulative ceilings for a context-size failure', async () => {
  const { api } = connect();
  render(<BudgetPanel api={api} work={{ ...work, error_code: 'CONTEXT_BUDGET_EXHAUSTED' }} />);
  await screen.findByText('Authorization revision 7');
  expect(screen.queryByRole('region', { name: 'Budget decision' })).not.toBeInTheDocument();
});

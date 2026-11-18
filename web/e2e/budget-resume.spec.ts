import { test, expect } from '@playwright/test';
import { mockFactoryApi, syntheticRun } from './fixtures';
import type { BudgetPolicy, WorkOrder } from '../src/api';

test('a saved ceiling change survives reload and offers resume without another authorization', async ({
  page,
}) => {
  await mockFactoryApi(page);
  const policy: BudgetPolicy = {
    version: 1,
    tokens: { primary: 1000, reserve: 0, absolute: 1000 },
    invocations: { primary: 20, reserve: 0, absolute: 20 },
    active_seconds: { primary: 900, reserve: 0, absolute: 900 },
    repairs: { primary: 2, reserve: 0, absolute: 2 },
    no_progress_threshold: 3,
  };
  let order: WorkOrder = {
    ...syntheticRun(),
    status: 'blocked',
    error_code: 'BUDGET_TOKENS',
    effective_budget_policy: policy,
    budget_revision: 1,
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
  };
  let amendments = 0;
  let resumes = 0;
  await page.route('**/api/v1/commands', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.payload.type).toBe('work.budget.amend');
    expect(body.payload.request.resume).toBe(false);
    expect(body.payload.request.policy).toEqual({ primary: null, reserve: 0, absolute: null });
    amendments++;
    policy.tokens = body.payload.request.policy;
    order = { ...order, budget_revision: 2, updated_at: '2026-11-18T10:00:00Z' };
    await route.fulfill({
      json: {
        version: 1,
        command_id: body.idempotency_key,
        correlation_id: body.correlation_id,
        work_id: order.id,
        phase: order.phase,
        work: order,
      },
    });
  });
  await page.route('**/api/v1/work**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/work')) return route.fulfill({ json: [order] });
    if (path.endsWith('/work/synthetic-run')) return route.fulfill({ json: order });
    if (path.endsWith('/resume')) {
      resumes++;
      order = { ...order, status: 'queued', error_code: null, updated_at: '2026-11-18T10:01:00Z' };
      return route.fulfill({ json: order });
    }
    if (path.endsWith('/budget'))
      return route.fulfill({
        json: {
          version: 1,
          revision: order.budget_revision,
          denial: order.budget_denial,
          metrics: Object.fromEntries(
            ['tokens', 'invocations', 'active_seconds', 'repairs'].map((metric) => [
              metric,
              {
                policy:
                  policy[
                    metric as keyof Pick<
                      BudgetPolicy,
                      'tokens' | 'invocations' | 'active_seconds' | 'repairs'
                    >
                  ],
                used: 100,
                reserved: 0,
                remaining: null,
                unknown: false,
              },
            ]),
          ),
          authorizations: [],
          limiting_metric: 'tokens',
          pending_step: order.phase,
          token_prevention: 'cli_post_invocation',
          unsettled_usage_ids: [],
          unreconciled_calls: 0,
        },
      });
    await route.fallback();
  });
  await page.goto('/runs/synthetic-run');
  await page.getByRole('button', { name: 'Review budget options' }).click();
  await page.getByRole('button', { name: 'Remove a ceiling', exact: true }).click();
  await page.getByLabel('Reason for this authorization').fill('Authorize this synthetic ceiling removal');
  await page.getByRole('button', { name: 'Save limits', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Limits updated — resume to recheck' })).toBeVisible();
  expect(amendments).toBe(1);
  expect(resumes).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Resolve budget', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Limits & scope', exact: true }).click();
  const decision = page.getByRole('region', { name: 'Budget decision' });
  await expect(decision.getByRole('button', { name: 'Set a new limit' })).toHaveCount(0);
  await decision.screenshot({ path: `../work/budget-resume-${test.info().project.name}.png` });
  await decision.getByRole('button', { name: 'Resume and recheck' }).click();
  await expect(page.getByTestId('run-header').getByText('Queued', { exact: true })).toBeVisible();
  expect(amendments).toBe(1);
  expect(resumes).toBe(1);
});

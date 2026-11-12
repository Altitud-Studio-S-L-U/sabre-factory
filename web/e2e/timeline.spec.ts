import { test, expect } from '@playwright/test';
import { captureSource, syntheticRun } from './fixtures';
import { runUsageSnapshot } from '../src/test/runUsageFixture';
import type { WorkOrder, SequencedEvent } from '../src/api';

test('incremental timeline reconciles tool completion and pause reflects persisted state', async ({
  page,
}) => {
  let order = syntheticRun();
  const event = (sequence: number, changes: Partial<SequencedEvent['event']>): SequencedEvent => ({
    sequence,
    event: {
      version: 1,
      id: `event-${sequence}`,
      work_id: order.id,
      phase: 'implementation',
      plan_revision: 1,
      correlation_id: 'synthetic-tool',
      parent_id: null,
      trace_id: null,
      span_id: null,
      kind: 'tool',
      state: 'started',
      name: 'read_file',
      timestamp: '2026-11-10T10:00:00Z',
      duration_ms: null,
      error_code: null,
      provider: null,
      model: null,
      ...changes,
    },
  });
  const cursors: number[] = [];
  await page.route('**/api/v1/work**', async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = [];
    if (url.pathname === '/api/v1/work') json = [order];
    if (url.pathname.endsWith('/synthetic-run')) json = order;
    if (url.pathname.endsWith('/usage')) json = runUsageSnapshot(order.id, 1, 100);
    if (url.pathname.endsWith('/pause')) {
      order = { ...order, status: 'paused', phase: 'implementation' };
      json = order;
    }
    if (url.pathname.endsWith('/audit'))
      json = {
        work_id: order.id,
        plan_revision: order.plan_revision,
        status: order.status,
        phase: order.phase,
        agents: [],
        tools: [],
        models: [],
        checkpoint_count: 0,
        checkpoint_threads: 0,
        truncated: false,
        context: null,
        usage: {
          calls: 1,
          tokens: 100,
          measured_tokens: 100,
          cost_usd: 0,
          settled_calls: 1,
          unsettled_calls: 0,
          unknown_reserved_tokens: 0,
        },
      };
    if (url.pathname.endsWith('/execution-events')) {
      const after = Number(url.searchParams.get('after'));
      cursors.push(after);
      json =
        after === 0
          ? { items: [event(1, {})], next_cursor: 1, has_more: true }
          : {
              items: [
                event(2, { state: 'completed', duration_ms: 1200 }),
                event(3, {
                  kind: 'stage',
                  correlation_id: 'synthetic-stage',
                  name: 'implement',
                  state: 'completed',
                  duration_ms: 1500,
                }),
              ],
              next_cursor: 3,
              has_more: false,
            };
    }
    if (url.pathname.endsWith('/inspection'))
      json = {
        version: 1,
        work_id: order.id,
        plan_revision: order.plan_revision,
        agent_id: null,
        role: null,
        agents: [],
        records: [],
        evaluations: [],
        logs: [],
        context: null,
        next_cursor: 0,
        has_more: false,
        truncated: false,
        checkpoint_id: null,
        current: true,
      };
    await route.fulfill({ json });
  });
  await page.goto('/work/synthetic-run');
  const timeline = page.getByRole('region', { name: 'Execution timeline' });
  await timeline.getByText('Recorded event list', { exact: true }).click();
  await expect(timeline.locator('.execution-phase-heading').getByText('1.5 s')).toBeVisible();
  const map = timeline.getByRole('button', { name: 'implement · completed', exact: true });
  await expect(map).toBeVisible();
  await map.click();
  const inspector = timeline.getByRole('region', { name: 'Execution inspector' });
  await inspector.getByRole('tab', { name: 'JSON', exact: true }).click();
  await expect(inspector.locator('pre').first()).toContainText('synthetic-stage');
  await expect(timeline.getByLabel('Recorded run state')).toContainText('100');
  await timeline.getByText('1 tool calls · 0 agent steps').click();
  await expect(timeline.locator('.execution-calls').getByText('read_file', { exact: true })).toHaveCount(1);
  await expect(timeline.locator('.execution-calls').getByText('1.2 s', { exact: true })).toBeVisible();
  // Development StrictMode replays the initial read; cursor advancement must still use the server receipt.
  expect([...new Set(cursors)].slice(0, 2)).toEqual([0, 1]);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.screenshot({ path: `../work/timeline-${test.info().project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('recorded process keeps phase attempts, agent tools, memory and failed checks separate from planned work', async ({
  page,
}) => {
  const order: WorkOrder = {
    ...syntheticRun(),
    status: 'blocked',
    phase: 'verification',
    error_code: 'SYNTHETIC_GATE_FAILED',
    summary:
      'Synthetic fixture: the verification check failed. Evidence is retained for an authorized recovery.',
    calls_used: 3,
    tokens_used: 2300,
    active_seconds_used: 22,
  };
  const events: SequencedEvent[] = [];
  const origin = Date.parse('2026-11-11T12:00:00Z');
  const span = (
    id: string,
    kind: SequencedEvent['event']['kind'],
    phase: string,
    name: string,
    start: number,
    end: number,
    options: Partial<SequencedEvent['event']> = {},
  ) => {
    for (const [offset, state] of [
      [start, 'started'],
      [end, options.error_code ? 'failed' : 'completed'],
    ] as const)
      events.push({
        sequence: 0,
        event: {
          version: 1,
          id: 'pending',
          work_id: order.id,
          plan_revision: 1,
          phase,
          correlation_id: id,
          parent_id: null,
          agent_id: null,
          trace_id: '1'.repeat(32),
          span_id: '2'.repeat(16),
          kind,
          state,
          name,
          timestamp: new Date(origin + offset * 1000).toISOString(),
          duration_ms: state === 'started' ? null : (end - start) * 1000,
          error_code: state === 'started' ? null : (options.error_code ?? null),
          provider: kind === 'agent' ? 'claude_cli' : null,
          model: kind === 'agent' ? 'synthetic-sonnet' : null,
          ...options,
        },
      });
  };
  span('preflight', 'stage', 'intake', 'intake', 0, 2);
  span('spec', 'stage', 'analysis', 'analyze', 2, 7);
  span('pm-agent', 'agent', 'analysis', 'analyst', 2.2, 6.8, {
    parent_id: 'spec',
    agent_id: 'synthetic-pm-invocation',
  });
  span('build-one', 'stage', 'implementation', 'implement', 7, 12, { error_code: 'SYNTHETIC_GATE_FAILED' });
  span('developer-one', 'agent', 'implementation', 'developer', 7.1, 11.8, {
    parent_id: 'build-one',
    agent_id: 'synthetic-developer-one',
  });
  span('build-two', 'stage', 'implementation', 'implement', 13, 18);
  span('developer-two', 'agent', 'implementation', 'developer', 13.1, 17.8, {
    parent_id: 'build-two',
    agent_id: 'synthetic-developer-two',
  });
  span('read-memory', 'tool', 'implementation', 'read_memory', 14, 14.4, {
    parent_id: 'developer-two',
    agent_id: 'synthetic-developer-two',
  });
  span('read-source', 'tool', 'implementation', 'read_source', 14.5, 15.2, {
    parent_id: 'developer-two',
    agent_id: 'synthetic-developer-two',
  });
  span('verification', 'stage', 'verification', 'checks', 18, 22, { error_code: 'SYNTHETIC_GATE_FAILED' });
  span('qa-agent', 'agent', 'verification', 'qa', 18.05, 21.8, {
    parent_id: 'verification',
    agent_id: 'synthetic-qa-invocation',
  });
  span('check-command', 'tool', 'verification', 'execute', 18.2, 21.5, {
    parent_id: 'qa-agent',
    agent_id: 'synthetic-qa-invocation',
    error_code: 'SYNTHETIC_GATE_FAILED',
  });
  const recorded = events
    .sort((left, right) => Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp))
    .map((item, index) => ({
      sequence: index + 1,
      event: { ...item.event, id: `synthetic-event-${index + 1}` },
    }));
  await page.route('**/api/v1/flows/patch/topology', async (route) =>
    route.fulfill({
      json: {
        version: 1,
        graph_version: 'sabre-v1',
        mode: 'patch',
        lanes: [
          { id: 'preflight', label: 'Preflight', specialist: 'System', stages: ['intake'], next: ['spec'] },
          { id: 'spec', label: 'Spec', specialist: 'PM', stages: ['analysis', 'analyze'], next: ['build'] },
          {
            id: 'build',
            label: 'Build',
            specialist: 'Developer',
            stages: ['implementation', 'implement'],
            next: ['verify'],
          },
          {
            id: 'verify',
            label: 'Verify',
            specialist: 'QA',
            stages: ['verification', 'checks'],
            next: ['review'],
          },
          {
            id: 'review',
            label: 'Review',
            specialist: 'Independent review',
            stages: ['review'],
            next: ['security'],
          },
          { id: 'security', label: 'Security', specialist: 'CISO', stages: ['security'], next: ['deliver'] },
          { id: 'deliver', label: 'Deliver', specialist: 'DevOps', stages: ['delivery'], next: ['memory'] },
          { id: 'memory', label: 'Memory', specialist: 'Verified evidence', stages: ['remember'], next: [] },
        ],
        alternatives: [
          { source: 'review', target: 'build', condition: 'Repair requires an authorized remaining budget' },
        ],
      },
    }),
  );
  const invocations: string[] = [];
  await page.route('**/api/v1/work**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/work') {
      await route.fulfill({ json: [order] });
      return;
    }
    if (path === `/api/v1/work/${order.id}`) {
      await route.fulfill({ json: order });
      return;
    }
    if (path.endsWith('/execution-events')) {
      await route.fulfill({ json: { items: recorded, next_cursor: recorded.length, has_more: false } });
      return;
    }
    if (path.endsWith('/usage')) {
      await route.fulfill({ json: runUsageSnapshot(order.id, 3, 2300) });
      return;
    }
    if (path.endsWith('/audit')) {
      await route.fulfill({
        json: {
          work_id: order.id,
          plan_revision: 1,
          status: order.status,
          phase: order.phase,
          context: null,
          usage: {
            calls: 3,
            settled_calls: 3,
            unsettled_calls: 0,
            tokens: 2300,
            measured_tokens: 2300,
            unknown_reserved_tokens: 0,
            cost_usd: 0,
          },
          agents: [],
          tools: [],
          models: [],
          checkpoint_count: 3,
          checkpoint_threads: 3,
          truncated: false,
        },
      });
      return;
    }
    if (path.endsWith('/inspection')) {
      const agentId = url.searchParams.get('agent_id') ?? 'synthetic-qa-invocation';
      invocations.push(agentId);
      await route.fulfill({
        json: {
          version: 1,
          work_id: order.id,
          plan_revision: 1,
          agent_id: agentId,
          role: agentId.includes('developer') ? 'developer' : 'qa',
          agents: [
            { id: 'synthetic-developer-two', role: 'developer', plan_revision: 1 },
            { id: 'synthetic-qa-invocation', role: 'qa', plan_revision: 1 },
          ],
          records: [
            {
              sequence: 0,
              id: 'synthetic-context-call',
              kind: 'tool_call',
              sender: 'developer',
              recipient: 'tool',
              content:
                'Synthetic retrieval: project-scoped source and reviewed memory for this implementation attempt.',
              tool: 'read_memory',
              redacted: false,
              truncated: false,
            },
            {
              sequence: 1,
              id: 'synthetic-context-result',
              kind: 'tool_result',
              sender: 'tool',
              recipient: 'developer',
              content:
                'Synthetic evidence: memory-one · commit aaaaaaaa · source run synthetic-prior-run. Context only; no instruction or permission authority.',
              tool: 'read_memory',
              redacted: false,
              truncated: false,
            },
          ],
          evaluations: [],
          logs: [],
          context: {
            source: 'synthetic-context-receipt',
            sent_bytes: 4096,
            input_limit_bytes: 98304,
            references_retained: true,
          },
          next_cursor: 2,
          has_more: false,
          truncated: false,
          checkpoint_id: 'synthetic-checkpoint-two',
          current: true,
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto(`/work/${order.id}`);
  const timeline = page.getByRole('region', { name: 'Execution timeline' });
  await expect(timeline.getByRole('button', { name: 'implement · failed', exact: true })).toBeVisible();
  await timeline.getByRole('button', { name: /Build Developer/ }).click();
  await timeline.getByRole('button', { name: 'developer · completed', exact: true }).last().click();
  const inspector = timeline.getByRole('region', { name: 'Execution inspector' });
  await inspector.getByRole('tab', { name: 'Memory', exact: true }).click();
  await expect(inspector.getByText(/Synthetic evidence: memory-one/)).toBeVisible();
  expect(invocations).toContain('synthetic-developer-two');
  await expect(timeline.getByRole('button', { name: 'implement · completed', exact: true })).toContainText(
    'attempt 2',
  );
  await expect(timeline.getByText('Planned · not started').first()).toBeVisible();
  await expect(timeline.locator('.child').filter({ hasText: 'read_memory' })).toContainText('memory');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (test.info().project.name === 'desktop') {
    await page.evaluate(() => window.scrollTo(0, 0));
    const workspace = await timeline.locator('.console-workspace').boundingBox();
    expect(workspace).not.toBeNull();
    expect(workspace!.y).toBeLessThanOrEqual(400);
    expect(
      await timeline
        .locator('.observed-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  }
  if (test.info().project.name === 'mobile')
    expect(
      await timeline
        .locator('.observed-scroll')
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
  await captureSource(page, 'process');
});

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AuditView, ProjectKnowledgeReport } from '../api';
import ProjectKnowledge from '../ProjectKnowledge';
import WorkAudit from '../WorkAudit';

describe('recorded activity and context', () => {
  it('distinguishes unknown reservations, failed commands and unanswered requests', () => {
    const agent = {
      id: 'agent',
      role: 'developer',
      plan_revision: 2,
      model_responses: 1,
      input_tokens: 25,
      output_tokens: 5,
      cache_read_tokens: 8,
      tool_requests: 2,
      tool_responses: 1,
      notes_recorded: 0,
      last_checkpoint_at: null,
      duration_ms: null,
    };
    const data: AuditView = {
      work_id: 'work',
      plan_revision: 2,
      status: 'blocked',
      phase: 'review',
      checkpoint_count: 9,
      checkpoint_threads: 2,
      truncated: false,
      context: null,
      models: [],
      calls: [],
      calls_truncated: false,
      tool_timings: [],
      usage: {
        calls: 2,
        settled_calls: 1,
        unsettled_calls: 1,
        tokens: 150,
        measured_tokens: 30,
        unknown_reserved_tokens: 120,
        cost_usd: 0,
      },
      agents: [agent],
      tools: [
        {
          id: 'command',
          agent_id: agent.id,
          role: 'developer',
          plan_revision: 2,
          name: 'execute',
          sequence: 1,
          response: 'received',
          exit_code: 1,
          output_digest: null,
          duration_ms: null,
        },
        {
          id: 'read',
          agent_id: agent.id,
          role: 'developer',
          plan_revision: 2,
          name: 'read_file',
          sequence: 2,
          response: 'requested',
          exit_code: null,
          output_digest: null,
          duration_ms: null,
        },
      ],
    };
    render(<WorkAudit data={data} />);
    expect(screen.getByText(/120 tokens remain reserved/)).toBeInTheDocument();
    expect(
      screen.getByText(/runs recorded before this measurement show them as unknown/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Tool time' })).not.toBeInTheDocument();
    expect(screen.queryByText(/model calls/)).not.toBeInTheDocument();
    const tools = screen.getByText('View 2 tool requests').closest('details');
    expect(tools).not.toHaveAttribute('open');
    expect(within(tools!).getByText('Command finished · exit 1')).toBeInTheDocument();
    expect(within(tools!).getByText('Request with no recorded response')).toBeInTheDocument();
    expect(screen.queryByText('Response received')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Sent context' })).getByText(/has no measurements/),
    ).toBeVisible();
  });

  it('distinguishes measured bytes, historical coverage and unknown recoveries', () => {
    const data = {
      work_id: 'work',
      plan_revision: 2,
      status: 'blocked',
      phase: 'review',
      checkpoint_count: 9,
      checkpoint_threads: 2,
      truncated: false,
      agents: [],
      models: [],
      calls: [],
      calls_truncated: false,
      tool_timings: [],
      tools: [],
      usage: {
        calls: 5,
        settled_calls: 5,
        unsettled_calls: 0,
        tokens: 200,
        measured_tokens: 200,
        unknown_reserved_tokens: 0,
        cost_usd: 0,
      },
      context: {
        requests_with_context: 3,
        requests_without_context: 2,
        original_bytes: 120000,
        sent_bytes: 84000,
        compacted_results: 7,
        restored_pages: null as number | null,
        requests_with_restored_pages: 0,
        references_truncated: true,
        policies: [{ version: 1, policy: 'bounded_reads_v1', input_limit_bytes: 98304 }],
      },
    };
    const { rerender } = render(<WorkAudit data={data} />);
    const context = within(screen.getByRole('region', { name: 'Sent context' }));
    expect(context.getByText(/Measured in 3 of 5 recorded invocations/)).toHaveTextContent(
      '2 have no context measurement',
    );
    expect(context.getByText('120,000 bytes')).toBeVisible();
    expect(context.getByText('84,000 bytes')).toBeVisible();
    expect(context.getByText('7')).toBeVisible();
    expect(context.getByText('Not measured')).toBeVisible();
    expect(context.queryByText(/0 pages/)).not.toBeInTheDocument();
    expect(context.getByText(/Reference details are bounded/)).toBeVisible();
    expect(context.getByText(/Bytes are not equivalent to tokens/)).toBeVisible();
    expect(context.queryByText(/%/)).not.toBeInTheDocument();
    rerender(
      <WorkAudit
        data={{ ...data, context: { ...data.context, restored_pages: 2, requests_with_restored_pages: 1 } }}
      />,
    );
    expect(context.getByText('2 pages · measured in 1 of 3 invocations')).toBeVisible();
    rerender(
      <WorkAudit
        data={{ ...data, context: { ...data.context, restored_pages: 0, requests_with_restored_pages: 3 } }}
      />,
    );
    expect(context.getByText('0 pages · measured in 3 of 3 invocations')).toBeVisible();
  });

  it('shows checkpoints and recorded code even with no memories, without claiming it is current', () => {
    const data: ProjectKnowledgeReport = {
      project_id: 'project',
      profile: 'node',
      gate_count: 1,
      memories: { total: 0, active: 0, pending: 0, invalidated: 0 },
      checkpoints: { count: 9, threads: 2 },
      semantic_search: false,
      truncated: false,
      context: {
        work_id: 'work',
        plan_revision: 2,
        role: 'developer',
        captured_at: null,
        source_commit: 'a'.repeat(40),
        snapshot_digest: 'b'.repeat(64),
        total_files: 62,
        text_files: 62,
        omitted_files: 61,
        source: 'recorded_checkpoint',
        currentness: 'unknown',
        files: [{ path: 'src/main.ts', content_digest: 'c'.repeat(64), lines: 30, indexable: true }],
      },
    };
    const { rerender } = render(<ProjectKnowledge data={data} />);
    expect(screen.getByText('0 active · 0 pending')).toBeInTheDocument();
    expect(screen.getByText('9 development checkpoints')).toBeInTheDocument();
    expect(screen.getByText(/No memories yet/)).toBeInTheDocument();
    expect(screen.getByText(/the reference may be outdated/)).toBeInTheDocument();
    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
    expect(screen.getByText(/Vector memory search is not configured/)).toBeInTheDocument();
    rerender(<ProjectKnowledge data={{ ...data, context: null, truncated: true }} />);
    expect(screen.getByText('No context is available in this bounded selection.')).toBeInTheDocument();
    expect(
      screen.queryByText('No source context recorded for the current revision.'),
    ).not.toBeInTheDocument();
  });
  it('shows measured tool time and per-call tokens, keeping unreported values unknown', () => {
    const data = {
      work_id: 'work',
      plan_revision: 1,
      status: 'blocked',
      phase: 'verification',
      checkpoint_count: 1,
      checkpoint_threads: 1,
      truncated: false,
      context: null,
      models: [],
      usage: {
        calls: 2,
        settled_calls: 1,
        unsettled_calls: 1,
        tokens: 12005,
        measured_tokens: 3005,
        unknown_reserved_tokens: 9000,
        cost_usd: 0,
      },
      agents: [
        {
          id: 'a'.repeat(64),
          role: 'qa',
          plan_revision: 1,
          model_responses: 1,
          input_tokens: 3000,
          output_tokens: 5,
          cache_read_tokens: 2048,
          tool_requests: 52,
          tool_responses: 52,
          notes_recorded: 0,
          last_checkpoint_at: null,
          duration_ms: 61000,
        },
      ],
      tools: [],
      calls: [
        {
          sequence: 1,
          role: 'qa',
          model_provider: 'codex_cli',
          model_name: 'gpt-5',
          reserved_tokens: 9000,
          measured_tokens: 3005,
          input_tokens: 3000,
          output_tokens: 5,
          cache_read_tokens: 2048,
          sent_bytes: 8100,
          original_bytes: 12000,
          call_ms: 4200,
        },
        {
          sequence: 2,
          role: 'qa',
          model_provider: 'codex_cli',
          model_name: 'gpt-5',
          reserved_tokens: 9000,
          measured_tokens: null,
          input_tokens: null,
          output_tokens: null,
          cache_read_tokens: null,
          sent_bytes: 8200,
          original_bytes: 8200,
          call_ms: null,
        },
      ],
      calls_truncated: false,
      tool_timings: [
        {
          agent_id: 'a'.repeat(64),
          name: 'read_file',
          count: 52,
          failed: 1,
          total_ms: 72800,
          max_ms: 2100,
          output_bytes: 180000,
        },
        {
          agent_id: 'b'.repeat(64),
          name: 'read_file',
          count: 2,
          failed: 0,
          total_ms: 200,
          max_ms: 150,
          output_bytes: null,
        },
        {
          agent_id: 'a'.repeat(64),
          name: 'execute',
          count: 1,
          failed: 0,
          total_ms: 900,
          max_ms: 900,
          output_bytes: 300,
        },
      ],
    } satisfies AuditView;
    render(<WorkAudit data={data} />);
    expect(screen.getByText('Active 1 min 1 s')).toBeVisible();
    const time = within(screen.getByRole('region', { name: 'Tool time' }));
    const rows = time.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Read file');
    expect(rows[0]).toHaveTextContent('54 calls · 1 min 13 s total · slowest 2.1 s · 1 failed');
    expect(rows[0]).toHaveTextContent('Results sent to the model: 175.8 KB');
    expect(rows[1]).toHaveTextContent('Execute command');
    const calls = screen.getByText('View 2 model calls').closest('details')!;
    const cells = within(calls)
      .getAllByRole('row')
      .map((row) => row.textContent);
    expect(cells[1]).toBe('1Verification9,0003,0002,04857.9 KB4.2 s');
    expect(cells[2]).toBe('2Verification9,000unknownunknownunknown8.0 KBunknown');
  });
});

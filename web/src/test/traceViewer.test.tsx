import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import RunInspector from '../RunInspector';
import type { SequencedEvent, WorkOrder } from '../api';
import type { ObservedSpan } from '../executionProjection';
import { TraceViewer, traceLink, traceViewerOf } from '../lib/traceViewer';

const TRACE = 'a1'.repeat(16);
const SPAN = 'b2'.repeat(8);

function span(traceId: string | null): ObservedSpan {
  const event = {
    version: 1,
    id: 'event-1',
    work_id: 'run-1',
    plan_revision: 1,
    phase: 'analysis',
    correlation_id: 'correlation-1',
    parent_id: null,
    kind: 'stage',
    state: 'completed',
    name: 'analysis',
    timestamp: '2026-11-14T10:00:00Z',
    duration_ms: 1200,
    error_code: null,
    provider: null,
    model: null,
    trace_id: traceId,
    span_id: traceId ? SPAN : null,
  } as SequencedEvent['event'];
  return {
    id: 'correlation-1',
    phase: 'analysis',
    event,
    records: [{ sequence: 1, event }],
    start: 0,
    end: 1200,
  };
}

const order = {
  id: 'run-1',
  phase: 'analysis',
  status: 'running',
  questions: [],
  findings: [],
  tasks: [],
} as unknown as WorkOrder;

async function openTraceTab(viewer: string | null, traceId: string | null) {
  render(
    <TraceViewer value={viewer}>
      <RunInspector order={order} current={span(traceId)} />
    </TraceViewer>,
  );
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Trace' }));
}

describe('the trace viewer address', () => {
  it('is the template the factory reports, when it is an http(s) address that names the trace', () => {
    const template = 'http://127.0.0.1:16686/trace/{trace_id}';
    expect(traceViewerOf({ telemetry: { configured: true, viewer_url: template } })).toBe(template);
    for (const status of [
      {},
      { telemetry: {} },
      { telemetry: { viewer_url: null } },
      { telemetry: { viewer_url: 'http://127.0.0.1:16686/search' } },
      { telemetry: { viewer_url: 'javascript:alert("{trace_id}")' } },
      { telemetry: { viewer_url: '/trace/{trace_id}' } },
      { telemetry: { viewer_url: 42 } },
    ])
      expect(traceViewerOf(status)).toBeNull();
  });

  it('builds the address of one trace only from a well-formed identifier', () => {
    const template = 'https://traces.example/t/{trace_id}?tab=timeline';
    expect(traceLink(template, TRACE)).toBe(`https://traces.example/t/${TRACE}?tab=timeline`);
    expect(traceLink(template, null)).toBeNull();
    expect(traceLink(template, 'not-a-trace')).toBeNull();
    expect(traceLink(template, `${TRACE}/../../admin`)).toBeNull();
    expect(traceLink(null, TRACE)).toBeNull();
  });
});

describe('the trace tab of the run inspector', () => {
  it('links the trace to the configured viewer', async () => {
    await openTraceTab('http://127.0.0.1:16686/trace/{trace_id}', TRACE);
    const link = screen.getByRole('link', { name: TRACE });
    expect(link).toHaveAttribute('href', `http://127.0.0.1:16686/trace/${TRACE}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByText(SPAN)).toBeVisible();
    expect(screen.getByText(/The trace opens in the configured viewer/)).toBeVisible();
  });

  it('shows the identifiers as text when no viewer is configured', async () => {
    await openTraceTab(null, TRACE);
    expect(screen.queryByRole('link', { name: TRACE })).not.toBeInTheDocument();
    expect(screen.getByText(TRACE)).toBeVisible();
    expect(screen.getByText(/No trace viewer is configured/)).toBeVisible();
  });

  it('says so when the step recorded no trace', async () => {
    await openTraceTab('http://127.0.0.1:16686/trace/{trace_id}', null);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getAllByText('Not recorded')).toHaveLength(2);
    expect(screen.getByText(/This step recorded no trace to open/)).toBeVisible();
  });
});

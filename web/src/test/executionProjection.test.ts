import { expect, test } from 'vitest';
import { projectExecution } from '../executionProjection';
import type { SequencedEvent } from '../api';

function event(
  sequence: number,
  correlation: string,
  state: 'started' | 'completed' | 'failed',
  timestamp: string,
  duration: number | null = null,
): SequencedEvent {
  return {
    sequence,
    event: {
      version: 1,
      id: `e-${sequence}`,
      work_id: 'synthetic-run',
      phase: 'implementation',
      plan_revision: 1,
      correlation_id: correlation,
      parent_id: null,
      trace_id: null,
      span_id: null,
      kind: 'stage',
      state,
      name: 'implement',
      timestamp,
      duration_ms: duration,
      error_code: null,
      provider: null,
      model: null,
    },
  };
}
test('projects separate repair attempts and uses sequence order for replay', () => {
  const spans = projectExecution([
    event(4, 'b', 'completed', '2026-11-11T10:00:04Z', 1000),
    event(1, 'a', 'started', '2026-11-11T10:00:00Z'),
    event(3, 'b', 'started', '2026-11-11T10:00:03Z'),
    event(2, 'a', 'failed', '2026-11-11T10:00:02Z', 2000),
  ]);
  expect(spans).toHaveLength(2);
  expect(spans[0].event.state).toBe('failed');
  expect(spans[0].records.map((r) => r.sequence)).toEqual([1, 2]);
  expect(spans[1].start).toBe(Date.parse('2026-11-11T10:00:03Z'));
  expect(spans[1].end).toBe(Date.parse('2026-11-11T10:00:04Z'));
});
test('does not invent timing when no start or measured duration is recorded', () => {
  const [span] = projectExecution([event(1, 'a', 'failed', '2026-11-11T10:00:02Z')]);
  expect(span.start).toBeNull();
  expect(span.phase).toBe('Build');
});
test('reconstructs a missing start only from an actual measured duration', () => {
  const [span] = projectExecution([event(2, 'a', 'completed', '2026-11-11T10:00:02Z', 1200)]);
  expect(span.start).toBe(Date.parse('2026-11-11T10:00:00.800Z'));
});

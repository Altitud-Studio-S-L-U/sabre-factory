import type { SequencedEvent } from './api';
import { isControlCode } from './runState';

export const phaseLabel: Record<string, string> = {
  intake: 'Preflight',
  reproduce: 'Reproduce',
  analyze: 'Analysis',
  analysis: 'Analysis',
  clarify: 'Requirements',
  design: 'Design',
  architecture: 'Architecture',
  plan: 'Plan',
  planning: 'Plan',
  implement: 'Build',
  implementation: 'Build',
  checks: 'Verify',
  verification: 'Verify',
  review: 'Review',
  security_check: 'Security',
  security: 'Security',
  commit: 'Prepare delivery',
  deliver: 'Deliver',
  delivery: 'Deliver',
  remember: 'Memory',
  audit_report: 'Audit report',
};
export interface ObservedSpan {
  id: string;
  phase: string;
  event: SequencedEvent['event'];
  records: SequencedEvent[];
  start: number | null;
  end: number | null;
}
export function projectExecution(entries: SequencedEvent[]): ObservedSpan[] {
  const groups = new Map<string, SequencedEvent[]>();
  for (const item of [...entries].sort((a, b) => a.sequence - b.sequence)) {
    const group = groups.get(item.event.correlation_id) ?? [];
    group.push(item);
    groups.set(item.event.correlation_id, group);
  }
  return [...groups].map(([id, records]) => {
    const last = records.at(-1)!.event;
    // Older runs recorded an owner pause/cancel as a failed step; it is a control outcome, not a failure.
    const event =
      last.state === 'failed' && isControlCode(last.error_code) ? { ...last, state: 'interrupted' as const } : last;
    const started = records.find((item) => item.event.state === 'started');
    const stamp = Date.parse(event.timestamp);
    const start = started
      ? Date.parse(started.event.timestamp)
      : event.duration_ms != null
        ? stamp - event.duration_ms
        : null;
    return {
      id,
      phase: phaseLabel[event.phase] ?? event.phase.replaceAll('_', ' '),
      event,
      records,
      start: start != null && Number.isFinite(start) ? start : null,
      end: event.state === 'started' || !Number.isFinite(stamp) ? null : stamp,
    };
  });
}

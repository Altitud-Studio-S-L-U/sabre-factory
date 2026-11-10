import { useEffect, useState } from 'react';
import { type Api, type SequencedEvent } from './api';
import './ExecutionTimeline.css';

const phaseNames: Record<string, string> = {
  analyze: 'analysis',
  plan: 'planning',
  implement: 'implementation',
  checks: 'verification',
  security_check: 'security',
  commit: 'prepare_delivery',
  deliver: 'delivery',
};
const duration = (value: number | null | undefined) =>
  value == null ? 'Not measured' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;

export default function ExecutionTimeline({
  api,
  workId,
  active,
}: {
  api: Api;
  workId: string;
  active: boolean;
}) {
  const [entries, setEntries] = useState<SequencedEvent[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await api.executionEvents(workId, cursor);
        if (stopped) return;
        cursor = page.next_cursor;
        setEntries((prior) =>
          [...new Map([...prior, ...page.items].map((item) => [item.sequence, item])).values()].slice(-1000),
        );
        setError('');
        if (active || page.has_more) timer = setTimeout(poll, page.has_more ? 50 : 2000);
      } catch {
        if (!stopped) setError('Execution events could not be refreshed. Your run continues independently.');
        if (!stopped && active) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, workId, active]);
  const latest = new Map<string, SequencedEvent['event']>();
  for (const item of entries) latest.set(item.event.correlation_id, item.event);
  const phases = new Map<string, SequencedEvent['event'][]>();
  for (const event of latest.values()) {
    const phase = phaseNames[event.phase] || event.phase;
    phases.set(phase, [...(phases.get(phase) || []), event]);
  }
  return (
    <section className="execution-timeline" aria-labelledby="execution-timeline-title">
      <div className="section-heading">
        <h2 id="execution-timeline-title">Execution timeline</h2>
        <span className="count-label">Measured events</span>
      </div>
      {error && <p role="alert">{error}</p>}
      {!entries.length && !error && (
        <p className="quiet-state">
          Events appear as the flow runs. Historical runs may have no timing measurements.
        </p>
      )}
      {entries.length >= 1000 && (
        <p className="hint">
          Showing the most recent 1,000 loaded events. Earlier events remain available through the paginated
          API.
        </p>
      )}
      <ol className="execution-phases">
        {[...phases].map(([phase, events]) => {
          const stages = events.filter((item) => item.kind === 'stage');
          const last = stages.at(-1) || events.at(-1)!;
          const measured = stages.filter((item) => item.duration_ms != null);
          return (
            <li key={phase} className={`execution-phase state-${last.state}`}>
              <div className="execution-phase-heading">
                <h3>{phase.replaceAll('_', ' ')}</h3>
                <span>
                  {last.state === 'started' ? (active ? 'Running' : 'No completion recorded') : last.state}
                </span>
                <time>
                  {measured.length
                    ? duration(measured.reduce((sum, item) => sum + (item.duration_ms || 0), 0))
                    : 'Not measured'}
                </time>
              </div>
              <details>
                <summary>
                  {events.filter((item) => item.kind === 'tool').length} tool calls ·{' '}
                  {events.filter((item) => item.kind === 'agent').length} agent steps
                </summary>
                <ul className="execution-calls">
                  {events
                    .filter((item) => item.kind !== 'stage')
                    .map((item) => (
                      <li key={item.correlation_id}>
                        <span className="event-kind">{item.kind}</span>
                        <strong>{item.name}</strong>
                        <span>{item.model || item.error_code || item.state}</span>
                        <time>{duration(item.duration_ms)}</time>
                      </li>
                    ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

import { useEffect, useState } from 'react';
import {
  type Api,
  type AuditView,
  type ProcessTopology,
  type RunInspection,
  type SequencedEvent,
  type WorkOrder,
} from './api';
import ExecutionConsole from './ExecutionConsole';
import type { RunUsageState } from './useRunUsage';
import Disclosure from './components/Disclosure';
import Notice from './components/Notice';

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
  order,
  audit,
  liveUsage,
}: {
  api: Api;
  workId: string;
  active: boolean;
  order: WorkOrder;
  audit?: AuditView | null;
  liveUsage?: RunUsageState;
}) {
  const [entries, setEntries] = useState<SequencedEvent[]>([]);
  const [error, setError] = useState('');
  const [topology, setTopology] = useState<ProcessTopology | null>(null);
  const [inspection, setInspection] = useState<RunInspection | null>(null);
  const [inspectorError, setInspectorError] = useState('');
  const [query, setQuery] = useState<{
    role?: string;
    agentId?: string;
    after: number;
    checkpointId?: string;
  }>({ after: 0 });
  useEffect(() => {
    let current = true;
    void api
      .flowTopology(order.mode)
      .then((value) => {
        if (current && Array.isArray(value.lanes)) setTopology(value);
      })
      .catch(() => {
        if (current) setTopology(null);
      });
    return () => {
      current = false;
    };
  }, [api, order.mode]);
  useEffect(() => {
    let current = true;
    void api
      .inspection(workId, query.role, query.agentId, query.after, query.checkpointId)
      .then((value) => {
        if (!current) return;
        if (!Array.isArray(value.records)) throw new Error('Recorded inspection data is not available.');
        setInspection((prior) =>
          query.after && prior?.agent_id === value.agent_id && prior?.checkpoint_id === value.checkpoint_id
            ? {
                ...value,
                records: [
                  ...new Map(
                    [...prior.records, ...value.records].map((record) => [
                      `${record.sequence}:${record.id}`,
                      record,
                    ]),
                  ).values(),
                ],
              }
            : value,
        );
        setInspectorError('');
      })
      .catch(() => {
        if (current)
          setInspectorError('Inspection could not be refreshed. Recorded timeline data is still available.');
      });
    return () => {
      current = false;
    };
  }, [api, workId, query, order.calls_used, order.phase, order.status]);
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
    <section aria-labelledby="execution-timeline-title" className="grid min-w-0 gap-3">
      {/* The Process tab already titles this view; the heading names the region for assistive technology. */}
      <h2 id="execution-timeline-title" className="sr-only">
        Execution timeline
      </h2>
      {error && (
        <Notice tone="warning" role="alert">
          {error}
        </Notice>
      )}
      <ExecutionConsole
        api={api}
        entries={entries}
        order={order}
        topology={topology}
        audit={audit}
        liveUsage={liveUsage}
        inspection={inspection}
        inspectorError={inspectorError}
        onInspect={(role, agentId) => setQuery({ role, agentId, after: 0 })}
        onMore={() => {
          if (inspection?.checkpoint_id && inspection.agent_id)
            setQuery((prior) => ({
              ...prior,
              agentId: inspection.agent_id ?? undefined,
              checkpointId: inspection.checkpoint_id ?? undefined,
              after: inspection.next_cursor,
            }));
        }}
      />
      {!entries.length && !error && (
        <p className="rounded-md border border-border bg-code px-4 py-3 text-sm text-muted-foreground">
          Events appear as the flow runs. Historical runs may have no timing measurements.
        </p>
      )}
      {entries.length >= 1000 && (
        <p className="text-xs text-muted-foreground">
          Showing the most recent 1,000 loaded events. Earlier events remain available through the paginated
          API.
        </p>
      )}
      <Disclosure summary="Recorded event list">
        <ol className="grid gap-2">
          {[...phases].map(([phase, events]) => {
            const stages = events.filter((item) => item.kind === 'stage');
            const last = stages.at(-1) || events.at(-1)!;
            const measured = stages.filter((item) => item.duration_ms != null);
            return (
              <li
                key={phase}
                data-state={last.state}
                className="grid gap-2 rounded-md border border-border bg-code p-3"
              >
                <div data-testid="phase-summary" className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <h3 className="mr-auto text-sm font-semibold capitalize">{phase.replaceAll('_', ' ')}</h3>
                  <span className="text-xs text-muted-foreground capitalize">
                    {last.state === 'started' ? (active ? 'Running' : 'No completion recorded') : last.state}
                  </span>
                  <time className="font-mono text-xs">
                    {measured.length
                      ? duration(measured.reduce((sum, item) => sum + (item.duration_ms || 0), 0))
                      : 'Not measured'}
                  </time>
                </div>
                <Disclosure
                  variant="plain"
                  summary={`${events.filter((item) => item.kind === 'tool').length} tool calls · ${
                    events.filter((item) => item.kind === 'agent').length
                  } agent steps`}
                >
                  <ul data-testid="phase-calls" className="grid gap-1">
                    {events
                      .filter((item) => item.kind !== 'stage')
                      .map((item) => (
                        <li
                          key={item.correlation_id}
                          className="grid grid-cols-[4rem_minmax(0,1fr)_auto_auto] items-center gap-3 text-xs"
                        >
                          <span className="font-mono text-muted-foreground">{item.kind}</span>
                          <strong className="truncate font-medium">{item.name}</strong>
                          <span className="truncate text-muted-foreground">
                            {item.model || item.error_code || item.state}
                          </span>
                          <time className="font-mono">{duration(item.duration_ms)}</time>
                        </li>
                      ))}
                  </ul>
                </Disclosure>
              </li>
            );
          })}
        </ol>
      </Disclosure>
    </section>
  );
}

import { useState } from 'react';
import type { SequencedEvent, WorkOrder } from './api';
import { projectExecution, type ObservedSpan } from './executionProjection';
import './ExecutionConsole.css';

const duration = (ms: number | null | undefined) =>
  ms == null ? 'Not measured' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
type Inspection = 'State' | 'JSON' | 'Errors' | 'Trace';

export default function ExecutionConsole({
  entries,
  order,
}: {
  entries: SequencedEvent[];
  order: WorkOrder;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection>('State');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const spans = projectExecution(entries);
  const current =
    spans.find((s) => s.id === selected) ??
    [...spans].reverse().find((s) => s.event.kind === 'stage') ??
    spans.at(-1);
  const knownStarts = spans.flatMap((s) => (s.start == null ? [] : [s.start]));
  const origin = knownStarts.length ? Math.min(...knownStarts) : null;
  const latestTimestamp = Math.max(
    0,
    ...entries.map((item) => Date.parse(item.event.timestamp)).filter(Number.isFinite),
  );
  const horizon = Math.max(1000, origin == null ? 0 : latestTimestamp - origin);
  const phases = [...new Set(spans.map((s) => s.phase))];
  const groups = phases.map((phase) => ({
    phase,
    stages: spans.filter((s) => s.phase === phase && s.event.kind === 'stage'),
    children: spans.filter((s) => s.phase === phase && s.event.kind !== 'stage'),
  }));
  function bar(span: ObservedSpan) {
    const end = span.end ?? latestTimestamp;
    const left =
      origin == null || span.start == null ? null : Math.max(0, ((span.start - origin) / horizon) * 100);
    const width = span.start == null ? 0 : Math.max(0.8, ((end - span.start) / horizon) * 100);
    return (
      <button
        type="button"
        key={span.id}
        className={`observed-bar kind-${span.event.kind} state-${span.event.state}`}
        style={left == null ? undefined : { left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
        aria-pressed={current?.id === span.id}
        onClick={() => setSelected(span.id)}
        title={`${span.event.name} · ${span.event.state} · ${duration(span.event.duration_ms)}`}
        aria-label={`${span.event.name} · ${span.event.state}`}
      >
        <strong>
          {span.event.state === 'failed' ? '× ' : ''}
          {span.event.name}
        </strong>
        <small>{duration(span.event.duration_ms)}</small>
      </button>
    );
  }
  return (
    <div className="run-console">
      <div className="console-readout" aria-label="Recorded run state">
        <div>
          <span>State</span>
          <strong>{order.status}</strong>
        </div>
        <div>
          <span>Current phase</span>
          <strong>{order.phase.replaceAll('_', ' ')}</strong>
        </div>
        <div>
          <span>Recorded tokens</span>
          <strong>{order.tokens_used.toLocaleString('en-US')}</strong>
        </div>
        <div>
          <span>Model calls</span>
          <strong>
            {order.calls_used} / {order.budget.max_calls ?? 'Uncapped'}
          </strong>
        </div>
        <div>
          <span>Active time recorded</span>
          <strong>{order.active_seconds_used.toFixed(1)} s</strong>
        </div>
      </div>
      <div className="console-workspace">
        <section className="observed-timeline" aria-label="Project timeline">
          <div className="console-panel-heading">
            <strong>Observed execution</strong>
            <span>Recorded events · expand phases for agents and tools</span>
          </div>
          {!entries.length ? (
            <p className="console-empty">
              Waiting for recorded events. Historical runs may have no timing measurements.
            </p>
          ) : (
            <div className="observed-scroll">
              <div className="observed-grid">
                <div className="observed-row ruler">
                  <div className="observed-label">PHASE / ACTIVITY</div>
                  <div className="observed-track">
                    {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                      <span key={f} style={{ left: `${f * 100}%` }}>
                        {time(horizon * f)}
                      </span>
                    ))}
                  </div>
                </div>
                {groups.map(({ phase, stages, children }) => (
                  <div key={phase}>
                    <div className="observed-row">
                      <div className="observed-label">
                        <button
                          type="button"
                          className="phase-expander"
                          aria-expanded={expanded.has(phase)}
                          onClick={() =>
                            setExpanded((prior) => {
                              const next = new Set(prior);
                              if (next.has(phase)) next.delete(phase);
                              else next.add(phase);
                              return next;
                            })
                          }
                        >
                          <span>{expanded.has(phase) ? '⌄' : '›'}</span>
                          <strong>{phase}</strong>
                          <small>{children.length} actions</small>
                        </button>
                      </div>
                      <div className="observed-track">
                        {stages.length ? (
                          stages.map(bar)
                        ) : (
                          <span className="unmeasured-phase">No phase span recorded</span>
                        )}
                      </div>
                    </div>
                    {expanded.has(phase) &&
                      children.map((span) => (
                        <div className="observed-row child" key={span.id}>
                          <div className="observed-label">
                            <span>{span.event.kind}</span>
                            <strong>{span.event.name}</strong>
                          </div>
                          <div className="observed-track">
                            {span.start == null ? (
                              <button className="unmeasured-action" onClick={() => setSelected(span.id)}>
                                {span.event.name} · timing unavailable
                              </button>
                            ) : (
                              bar(span)
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="console-footnote">
            Elapsed axis uses recorded timestamps. Unfinished spans end at the latest observed event; this is
            not a live token meter.
          </p>
        </section>
        <section className="console-inspector" aria-label="Execution inspector">
          <h3>Inspector</h3>
          {current ? (
            <>
              <h4>{current.event.name}</h4>
              <div className="console-tabs">
                {(['State', 'JSON', 'Errors', 'Trace'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    aria-pressed={inspection === tab}
                    onClick={() => setInspection(tab)}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              {inspection === 'State' && (
                <dl>
                  <dt>Kind</dt>
                  <dd>{current.event.kind}</dd>
                  <dt>State</dt>
                  <dd>{current.event.state}</dd>
                  <dt>Model</dt>
                  <dd>{current.event.model || 'Not attributed'}</dd>
                  <dt>Provider</dt>
                  <dd>{current.event.provider || 'Not attributed'}</dd>
                  <dt>Duration</dt>
                  <dd>{duration(current.event.duration_ms)}</dd>
                  <dt>Last event</dt>
                  <dd>{new Date(current.event.timestamp).toLocaleString()}</dd>
                </dl>
              )}
              {inspection === 'JSON' && <pre>{JSON.stringify(current.records, null, 2)}</pre>}
              {inspection === 'Errors' && (
                <p>{current.event.error_code || 'No error code recorded for this action.'}</p>
              )}
              {inspection === 'Trace' && (
                <>
                  <p>
                    Correlation: <code>{current.id}</code>
                  </p>
                  <p>
                    Trace ID: <code>{current.event.trace_id || 'Not recorded'}</code>
                  </p>
                  <p>
                    Span ID: <code>{current.event.span_id || 'Not recorded'}</code>
                  </p>
                  <p>
                    Trace identifiers correlate exported OpenTelemetry data. No external trace destination has
                    been configured in this view.
                  </p>
                </>
              )}
              <p className="console-footnote">
                Metadata only. Prompts, tool payloads and evaluator results are not inferred from these
                events.
              </p>
            </>
          ) : (
            <p>Select an observed activity to inspect it.</p>
          )}
        </section>
      </div>
      <details className="console-contract">
        <summary>Run configuration and global state</summary>
        <pre>
          {JSON.stringify(
            {
              id: order.id,
              status: order.status,
              phase: order.phase,
              plan_revision: order.plan_revision,
              budget: order.budget,
              flow_config: order.flow_config,
              resolved_flow: order.resolved_flow,
              tasks: order.tasks,
              error_code: order.error_code,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}

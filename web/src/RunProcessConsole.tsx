import { useEffect, useId, useState } from 'react';
import type { Api, AuditView, ProcessTopology, RunInspection, SequencedEvent, WorkOrder } from './api';
import { projectExecution, type ObservedSpan } from './executionProjection';
import RunInspector, { specialistNames } from './RunInspector';
import JsonView from './components/JsonView';
import './ExecutionConsole.css';

const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const duration = (ms: number | null | undefined) =>
  ms == null ? 'Not recorded' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const memoryTools = new Set(['read_memory', 'propose_memory', 'resolve_memory', 'read_context']);

export default function RunProcessConsole({
  api,
  entries,
  order,
  topology,
  audit,
  inspection,
  inspectorError,
  onInspect,
  onMore,
}: {
  api?: Api;
  entries: SequencedEvent[];
  order: WorkOrder;
  topology?: ProcessTopology | null;
  audit?: AuditView | null;
  inspection?: RunInspection | null;
  inspectorError?: string;
  onInspect?: (role?: string, agentId?: string) => void;
  onMore?: () => void;
}) {
  const tooltipId = useId();
  const [preview, setPreview] = useState<ObservedSpan | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState<ObservedSpan | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const spans = projectExecution(entries);
  const running = ['running', 'queued'].includes(order.status);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const current =
    spans.find((span) => span.id === selected) ??
    (selected?.startsWith('phase:')
      ? undefined
      : selected
        ? (pinned ?? undefined)
        : ([...spans].reverse().find((span) => span.event.kind === 'stage') ?? spans.at(-1)));
  const registered = topology?.lanes ?? [];
  const laneFor = (span: ObservedSpan) =>
    registered.find(
      (lane) =>
        lane.stages.includes(span.event.phase) ||
        (span.event.kind === 'stage' && lane.stages.includes(span.event.name)),
    )?.id ?? span.phase;
  const laneIds = [...new Set([...registered.map((lane) => lane.id), ...spans.map(laneFor)])];
  const selectedLane = selected?.startsWith('phase:')
    ? selected.slice(6)
    : current
      ? laneFor(current)
      : laneIds[0];
  const lane = registered.find((item) => item.id === selectedLane);
  const known = spans.flatMap((span) => (span.start == null ? [] : [span.start]));
  const origin = known.length ? Math.min(...known) : null;
  const latest = Math.max(
    0,
    ...entries.map((entry) => Date.parse(entry.event.timestamp)).filter(Number.isFinite),
  );
  const end = running ? Math.max(now, latest) : latest;
  const horizon = Math.max(1000, origin == null ? 0 : end - origin);
  const pin = (span: ObservedSpan) => {
    setSelected(span.id);
    setPinned(span);
    const parent = spans.find((candidate) => candidate.id === span.event.parent_id);
    onInspect?.(
      span.event.kind === 'agent'
        ? span.event.name
        : parent?.event.kind === 'agent'
          ? parent.event.name
          : undefined,
      span.event.agent_id ?? parent?.event.agent_id ?? undefined,
    );
  };
  const renderBar = (span: ObservedSpan, index: number, total: number, attempt = index + 1) => {
    const left =
      origin == null || span.start == null ? null : Math.max(0, ((span.start - origin) / horizon) * 100);
    const width = span.start == null ? 0 : Math.max(1.1, (((span.end ?? end) - span.start) / horizon) * 100);
    return (
      <button
        type="button"
        key={span.id}
        className={`observed-bar kind-${span.event.kind} state-${span.event.state}`}
        style={
          left == null
            ? undefined
            : { left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, top: `${9 + index * 38}px` }
        }
        aria-pressed={current?.id === span.id}
        onClick={() => pin(span)}
        onMouseEnter={() => setPreview(span)}
        onMouseLeave={() => setPreview(null)}
        onFocus={() => setPreview(span)}
        onBlur={() => setPreview(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setPreview(null);
        }}
        aria-describedby={preview?.id === span.id ? tooltipId : undefined}
        aria-label={`${span.event.name} · ${span.event.state}`}
      >
        <strong>
          {span.event.state === 'failed' ? '× ' : ''}
          {specialistNames[span.event.name] ?? span.event.name.replaceAll('_', ' ')}
          {total > 1 ? ` · attempt ${attempt}` : ''}
        </strong>
        <small>
          {span.event.state === 'started' && span.start != null
            ? `${clock(Math.max(0, end - span.start))} · active`
            : duration(span.event.duration_ms)}
        </small>
      </button>
    );
  };
  return (
    <div className="run-console">
      <div className="console-readout" aria-label="Recorded run state">
        <div>
          <span>Current phase</span>
          <strong>{order.phase.replaceAll('_', ' ')}</strong>
        </div>
        <div>
          <span>Measured tokens</span>
          <strong>{audit ? audit.usage.measured_tokens.toLocaleString('en-US') : 'Not available'}</strong>
          <small>
            {audit?.usage.unknown_reserved_tokens
              ? `${audit.usage.unknown_reserved_tokens.toLocaleString('en-US')} reserved · pending`
              : audit?.usage.unsettled_calls
                ? `${audit.usage.unsettled_calls} calls pending · usage unknown`
                : 'Settled provider usage'}
          </small>
        </div>
        <div>
          <span>Model calls</span>
          <strong>
            {order.calls_used}
            <small>
              {' '}
              /{' '}
              {(order.effective_budget_policy ?? order.budget.policy)?.invocations.primary ??
                (order.effective_budget_policy || order.budget.policy
                  ? 'Uncapped'
                  : (order.budget.max_calls ?? 'Uncapped'))}
            </small>
          </strong>
        </div>
        <div>
          <span>Active time recorded</span>
          <strong>{clock(order.active_seconds_used * 1000)}</strong>
          <small>Excludes idle and operator waits</small>
        </div>
        <div>
          <span>Recorded model API cost</span>
          <strong>{audit ? `$${audit.usage.cost_usd.toFixed(4)}` : 'Unknown'}</strong>
          <small>Subscription fees and unknown remote costs excluded</small>
        </div>
      </div>
      <div className="console-workspace">
        <section className="observed-timeline" aria-label="Project timeline">
          <div className="console-panel-heading">
            <div>
              <strong>Process timeline</strong>
              <span>
                {order.mode.toUpperCase()} · {topology?.graph_version ?? order.graph_version}
              </span>
            </div>
            <div className="timeline-legend">
              <span>
                <i className="legend-observed" />
                Recorded
              </span>
              <span>
                <i className="legend-pending" />
                Planned
              </span>
              <span>
                <i className="legend-error" />
                Error
              </span>
            </div>
          </div>
          <div className="observed-scroll">
            <div className="observed-grid">
              <div className="observed-row ruler">
                <div className="observed-label">PHASE / SPECIALIST</div>
                <div className="observed-track">
                  {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
                    <span key={fraction} style={{ left: `${fraction * 100}%` }}>
                      {clock(horizon * fraction)}
                    </span>
                  ))}
                </div>
              </div>
              {laneIds.map((id) => {
                const descriptor = registered.find((item) => item.id === id);
                const activities = spans.filter((span) => laneFor(span) === id);
                const stages = activities.filter((span) => span.event.kind === 'stage');
                const children = activities.filter((span) => span.event.kind !== 'stage');
                return (
                  <div
                    className={`timeline-lane ${selectedLane === id ? 'is-selected' : ''} ${activities.some((span) => span.event.state === 'failed') ? 'has-error' : ''}`}
                    key={id}
                  >
                    <div
                      className="observed-row"
                      style={{ minHeight: `${Math.max(66, stages.length * 38 + 18)}px` }}
                    >
                      <div className="observed-label">
                        <button
                          type="button"
                          className="phase-expander"
                          aria-expanded={expanded.has(id)}
                          onClick={() => {
                            setSelected(`phase:${id}`);
                            setExpanded((prior) => {
                              const next = new Set(prior);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            });
                          }}
                        >
                          <span>{expanded.has(id) ? '⌄' : '›'}</span>
                          <strong>{descriptor?.label ?? id}</strong>
                          <small>{descriptor?.specialist ?? 'Recorded activity'}</small>
                          <small>
                            {children.length
                              ? `${children.length} actions`
                              : activities.length
                                ? 'Recorded'
                                : 'Planned · not started'}
                          </small>
                        </button>
                      </div>
                      <div className="observed-track">
                        {stages.length ? (
                          stages.map((span, index) =>
                            renderBar(
                              span,
                              index,
                              stages.filter((item) => item.event.name === span.event.name).length,
                              stages.slice(0, index + 1).filter((item) => item.event.name === span.event.name)
                                .length,
                            ),
                          )
                        ) : (
                          <span className="unmeasured-phase">
                            {activities.length ? 'No phase duration recorded' : 'Waiting for this phase'}
                          </span>
                        )}
                      </div>
                    </div>
                    {expanded.has(id) &&
                      children.map((span) => (
                        <div className="observed-row child" key={span.id}>
                          <div className="observed-label">
                            <span>
                              {span.event.kind === 'tool' && memoryTools.has(span.event.name)
                                ? 'memory'
                                : span.event.kind}
                            </span>
                            <strong>{specialistNames[span.event.name] ?? span.event.name}</strong>
                          </div>
                          <div className="observed-track">
                            {span.start == null ? (
                              <button className="unmeasured-action" onClick={() => pin(span)}>
                                {span.event.name} · timing unavailable
                              </button>
                            ) : (
                              renderBar(span, 0, 1)
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                );
              })}
              {!laneIds.length && (
                <p className="console-empty">
                  Loading the registered process. Execution data remains available independently.
                </p>
              )}
            </div>
          </div>
          {!!topology?.alternatives.length && (
            <details className="process-alternatives">
              <summary>Alternative routes · repair and human decisions</summary>
              {topology.alternatives.map((route, index) => (
                <p key={index}>
                  <strong>
                    {route.source} → {route.target}
                  </strong>
                  <span>{route.condition}</span>
                </p>
              ))}
            </details>
          )}
          <div className="console-footnote">
            {running
              ? 'Live elapsed ruler · usage updates after each provider response.'
              : 'Saved execution · timing uses recorded boundaries.'}{' '}
            Planned lanes describe the registered flow; empty lanes are not execution evidence.
          </div>
        </section>
        <RunInspector
          historicalSelection={Boolean(selected && pinned && !spans.some((span) => span.id === selected))}
          api={api}
          current={current}
          lane={lane}
          order={order}
          inspection={inspection}
          error={inspectorError}
          onInspect={onInspect}
          onMore={onMore}
        />
      </div>
      {preview && (
        <div className="timeline-preview" id={tooltipId} role="tooltip">
          <strong>
            {preview.event.name} · {preview.event.state}
          </strong>
          <span>
            {duration(preview.event.duration_ms)} · {preview.event.kind} · {preview.event.phase}
          </span>
          <small>Click to pin details · Escape to dismiss</small>
        </div>
      )}
      <details className="console-contract">
        <summary>Immutable configuration and global state</summary>
        <JsonView
          value={{
            id: order.id,
            status: order.status,
            phase: order.phase,
            plan_revision: order.plan_revision,
            budget: order.budget,
            flow_config: order.flow_config,
            resolved_flow: order.resolved_flow,
            tasks: order.tasks,
            error_code: order.error_code,
          }}
          label="Global run state"
        />
      </details>
    </div>
  );
}

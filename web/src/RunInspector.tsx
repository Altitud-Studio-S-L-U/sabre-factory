import { useState } from 'react';
import type { Api, ProcessTopology, RunInspection, WorkOrder } from './api';
import type { ObservedSpan } from './executionProjection';
import Tabs from './components/Tabs';
import JsonView from './components/JsonView';
import BrowserReportsPanel from './BrowserReportsPanel';

type InspectionTab = 'State' | 'Messages' | 'Tools' | 'Memory' | 'Evals' | 'Logs' | 'JSON' | 'Trace';
const tabs: { value: InspectionTab; label: string }[] = [
  'State',
  'Messages',
  'Tools',
  'Memory',
  'Evals',
  'Logs',
  'JSON',
  'Trace',
].map((label) => ({ value: label as InspectionTab, label }));
export const specialistNames: Record<string, string> = {
  analyst: 'PM',
  architect: 'Developer · architecture',
  supervisor: 'Supervisor',
  developer: 'Developer',
  qa: 'QA',
  reviewer: 'Independent review',
  security: 'CISO',
  designer: 'Designer',
  devops: 'DevOps',
};
const memoryTools = new Set(['read_memory', 'propose_memory', 'resolve_memory', 'read_context']);

export default function RunInspector({
  api,
  historicalSelection = false,
  current,
  lane,
  order,
  inspection,
  error,
  onInspect,
  onMore,
}: {
  api?: Api;
  historicalSelection?: boolean;
  current?: ObservedSpan;
  lane?: ProcessTopology['lanes'][number];
  order: WorkOrder;
  inspection?: RunInspection | null;
  error?: string;
  onInspect?: (role?: string, agentId?: string) => void;
  onMore?: () => void;
}) {
  const [tab, setTab] = useState<InspectionTab>('State');
  const records = inspection?.records ?? [];
  const tools = records.filter(
    (record) =>
      record.kind !== 'message' &&
      (!current || current.event.kind !== 'tool' || record.tool === current.event.name),
  );
  const recordList = (items: typeof records, empty: string) =>
    items.length ? (
      <div className="inspection-records">
        {items.map((record) => (
          <article
            className={`inspection-record record-${record.kind}`}
            key={`${record.sequence}-${record.id}`}
          >
            <header>
              <strong>
                {specialistNames[record.sender] ?? record.sender} →{' '}
                {specialistNames[record.recipient] ?? record.recipient}
              </strong>
              <span>{record.tool ?? record.kind.replaceAll('_', ' ')}</span>
            </header>
            <pre>{record.content}</pre>
            {record.truncated && (
              <small>Preview truncated. The original remains in its recorded checkpoint.</small>
            )}
            {record.redacted && <small>Secret policy applied.</small>}
          </article>
        ))}
      </div>
    ) : (
      <p className="inspector-empty">{empty}</p>
    );
  return (
    <section className="console-inspector" aria-label="Execution inspector">
      <header className="inspector-heading">
        <span>INSPECTOR</span>
        <h3>
          {current
            ? (specialistNames[current.event.name] ?? current.event.name.replaceAll('_', ' '))
            : (lane?.label ?? 'Run state')}
        </h3>
        <span className={`inspector-status ${current?.event.state ?? 'planned'}`}>
          {current?.event.state ?? 'Planned'}
        </span>
      </header>
      {historicalSelection && (
        <p className="notice warning">
          Pinned historical event. New events have moved beyond this timeline window; this selection has not
          changed.
        </p>
      )}
      {error && (
        <p className="notice warning" role="alert">
          {error}
        </p>
      )}
      <Tabs items={tabs} value={tab} onChange={setTab} label="Execution inspection">
        {(active) => (
          <>
            {active === 'State' && (
              <>
                <dl>
                  <dt>Specialist</dt>
                  <dd>
                    {current?.event.kind === 'agent'
                      ? (specialistNames[current.event.name] ?? current.event.name)
                      : (lane?.specialist ?? 'System')}
                  </dd>
                  <dt>Status</dt>
                  <dd>{current?.event.state ?? 'No execution recorded'}</dd>
                  <dt>Provider</dt>
                  <dd>
                    {current?.event.provider ??
                      (current?.event.kind === 'stage' ? 'System step' : 'Not recorded')}
                  </dd>
                  <dt>Model</dt>
                  <dd>{current?.event.model ?? 'Not attributed'}</dd>
                  <dt>Duration</dt>
                  <dd>
                    {current?.event.duration_ms == null
                      ? 'Not recorded'
                      : `${(current.event.duration_ms / 1000).toFixed(2)} s`}
                  </dd>
                  <dt>Event sequence</dt>
                  <dd>{current?.records.at(-1)?.sequence ?? 'Not recorded'}</dd>
                </dl>
                {current?.event.error_code && (
                  <div className="notice error">
                    <strong>{current.event.error_code}</strong>
                    <p>
                      {order.error_code === current.event.error_code
                        ? order.summary
                        : 'Inspect the saved logs and authorized recovery controls.'}
                    </p>
                  </div>
                )}
              </>
            )}
            {active === 'Messages' && (
              <>
                <p className="inspector-caption">
                  Recorded instructions and visible responses for the invocation selected below. Historical
                  stage events may have no invocation binding. Hidden reasoning is not collected.
                </p>
                {inspection?.agents.length ? (
                  <label className="inspection-agent-picker">
                    Invocation
                    <select
                      value={inspection.agent_id ?? ''}
                      onChange={(event) => onInspect?.(undefined, event.target.value)}
                    >
                      {inspection.agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {specialistNames[agent.role] ?? agent.role} · revision {agent.plan_revision} ·{' '}
                          {agent.id.slice(0, 6)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {recordList(
                  records.filter((record) => record.kind === 'message'),
                  'No visible agent messages recorded for this selection.',
                )}
              </>
            )}
            {active === 'Tools' &&
              recordList(tools, 'No tool requests or results recorded for this selection.')}
            {active === 'Memory' && (
              <>
                {recordList(
                  records.filter((record) => record.tool && memoryTools.has(record.tool)),
                  'No memory retrieval or write recorded in this invocation.',
                )}
                <h4>Context receipt</h4>
                {inspection?.context ? (
                  <JsonView value={inspection.context} label="Recorded context use" />
                ) : (
                  <p className="inspector-empty">No context measurement recorded.</p>
                )}
              </>
            )}
            {active === 'Evals' && (
              <>
                {api && (
                  <BrowserReportsPanel
                    api={api}
                    workId={order.id}
                    sourceDigest={order.evidence?.source_digest ?? undefined}
                    refreshKey={order.updated_at}
                  />
                )}
                {inspection?.evaluations.length ? (
                  inspection.evaluations.map((evaluation) => (
                    <article className="inspection-evaluation" key={evaluation.id}>
                      <strong>
                        {evaluation.kind} · {evaluation.status}
                      </strong>
                      <p>{evaluation.criterion}</p>
                      {evaluation.snapshot_digest && <code>Snapshot: {evaluation.snapshot_digest}</code>}
                      {evaluation.artifact_digest && <code>Evidence: {evaluation.artifact_digest}</code>}
                    </article>
                  ))
                ) : (
                  <p className="inspector-empty">
                    No recorded evaluation evidence yet. Planned checks are not results.
                  </p>
                )}
              </>
            )}
            {active === 'Logs' && (
              <>
                {inspection?.logs.length ? (
                  inspection.logs.map((entry, index) => (
                    <article className="inspection-log" key={String(entry.id ?? index)}>
                      <time>{String(entry.timestamp ?? '')}</time>
                      <strong>{String(entry.kind ?? 'event')}</strong>
                      <p>{String(entry.message ?? '')}</p>
                    </article>
                  ))
                ) : (
                  <p className="inspector-empty">No persisted log entries available.</p>
                )}
              </>
            )}
            {active === 'JSON' && (
              <JsonView
                value={
                  current
                    ? {
                        invocation: current.records,
                        checkpoint: inspection?.checkpoint_id,
                        historical: inspection ? !inspection.current : false,
                      }
                    : { phase: lane, run: order.id, state: 'planned' }
                }
                label="Selected state JSON"
              />
            )}
            {active === 'Trace' && (
              <>
                <dl>
                  <dt>Correlation ID</dt>
                  <dd>
                    <code>{current?.id ?? 'No invocation selected'}</code>
                  </dd>
                  <dt>Trace ID</dt>
                  <dd>
                    <code>{current?.event.trace_id ?? 'Not recorded'}</code>
                  </dd>
                  <dt>Span ID</dt>
                  <dd>
                    <code>{current?.event.span_id ?? 'Not recorded'}</code>
                  </dd>
                </dl>
                <p className="inspector-caption">
                  These identifiers correlate actual OpenTelemetry spans. No trace is inferred when
                  instrumentation was absent.
                </p>
              </>
            )}
            {inspection?.checkpoint_id && (
              <div className="inspector-caption">
                <p>
                  Recorded checkpoint <code>{inspection.checkpoint_id}</code>. Pages use this snapshot.
                </p>
                <button
                  className="button small"
                  type="button"
                  onClick={() => onInspect?.(inspection.role ?? undefined, inspection.agent_id ?? undefined)}
                >
                  Refresh invocation snapshot
                </button>
              </div>
            )}
            {inspection && !inspection.current && (
              <p className="notice warning">Historical invocation from an earlier plan revision.</p>
            )}
            {inspection?.has_more && (
              <button type="button" className="button small" onClick={onMore}>
                Load more recorded messages
              </button>
            )}
          </>
        )}
      </Tabs>
    </section>
  );
}

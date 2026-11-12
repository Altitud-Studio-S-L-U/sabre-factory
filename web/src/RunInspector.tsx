import { useState, type ReactNode } from 'react';
import type { Api, ProcessTopology, RunInspection, WorkOrder } from './api';
import type { ObservedSpan } from './executionProjection';
import Tabs from './components/Tabs';
import JsonView from './components/JsonView';
import Notice from './components/Notice';
import Button from './components/Button';
import Select from './components/Select';
import { Eyebrow } from './components/PageHeader';
import { Badge } from './components/ui/badge';
import BrowserReportsPanel from './BrowserReportsPanel';
import CrewAvatar from './features/crew/CrewAvatar';
import { isControlCode } from './runState';

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
const stateTones: Record<string, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  started: 'info',
  completed: 'success',
  failed: 'danger',
  interrupted: 'warning',
};

function Caption({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function RunInspector({
  api,
  currentStop = false,
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
  /** The selected step's error is the run's current stop reason (computed by the timeline). */
  currentStop?: boolean;
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
      <div className="grid gap-2">
        {items.map((record) => (
          <article
            key={`${record.sequence}-${record.id}`}
            data-kind={record.kind}
            className="grid min-w-0 gap-2 rounded-md border border-border bg-code p-3"
          >
            <header className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
              <strong className="font-medium">
                {specialistNames[record.sender] ?? record.sender} →{' '}
                {specialistNames[record.recipient] ?? record.recipient}
              </strong>
              <span className="font-mono text-muted-foreground">
                {record.tool ?? record.kind.replaceAll('_', ' ')}
              </span>
            </header>
            <pre className="max-h-72 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {record.content}
            </pre>
            {record.truncated && (
              <Caption>Preview truncated. The original remains in its recorded checkpoint.</Caption>
            )}
            {record.redacted && <Caption>Secret policy applied.</Caption>}
          </article>
        ))}
      </div>
    ) : (
      <Empty>{empty}</Empty>
    );
  const role = current?.event.kind === 'agent' ? current.event.name : (lane?.specialist ?? 'system');
  const state = current?.event.state ?? 'planned';
  return (
    <section aria-label="Execution inspector" className="grid min-w-0 content-start gap-4 p-4">
      <header className="flex min-w-0 items-center gap-3">
        <CrewAvatar role={role} size={36} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <Eyebrow>Inspector</Eyebrow>
          <h3 className="truncate text-base font-semibold">
            {current
              ? (specialistNames[current.event.name] ?? current.event.name.replaceAll('_', ' '))
              : (lane?.label ?? 'Run state')}
          </h3>
        </div>
        <Badge variant={stateTones[state] ?? 'outline'} className="capitalize">
          {current?.event.state ?? 'Planned'}
        </Badge>
      </header>
      {historicalSelection && (
        <Notice tone="warning">
          Pinned historical event. New events have moved beyond this timeline window; this selection has not
          changed.
        </Notice>
      )}
      {error && (
        <Notice tone="warning" role="alert">
          {error}
        </Notice>
      )}
      <Tabs items={tabs} value={tab} onChange={setTab} label="Execution inspection">
        {(active) => (
          <div className="grid min-w-0 gap-4 pt-4">
            {active === 'State' && (
              <>
                <Facts
                  items={[
                    [
                      'Specialist',
                      current?.event.kind === 'agent'
                        ? (specialistNames[current.event.name] ?? current.event.name)
                        : (lane?.specialist ?? 'System'),
                    ],
                    ['Status', current?.event.state ?? 'No execution recorded'],
                    [
                      'Provider',
                      current?.event.provider ??
                        (current?.event.kind === 'stage' ? 'System step' : 'Not recorded'),
                    ],
                    ['Model', current?.event.model ?? 'Not attributed'],
                    [
                      'Duration',
                      current?.event.duration_ms == null
                        ? 'Not recorded'
                        : `${(current.event.duration_ms / 1000).toFixed(2)} s`,
                    ],
                    ['Event sequence', current?.records.at(-1)?.sequence ?? 'Not recorded'],
                  ]}
                />
                {current?.event.error_code &&
                  (isControlCode(current.event.error_code) ? (
                    <Notice tone="neutral" title="Owner control">
                      <p>Stopped by an owner pause or cancellation request. This is not a failure.</p>
                    </Notice>
                  ) : currentStop ? (
                    <Notice tone="danger" title={`Current stop reason · ${current.event.error_code}`}>
                      <p>{order.summary}</p>
                    </Notice>
                  ) : (
                    <Notice
                      tone="warning"
                      title={`Historical record · ${current.event.error_code}${
                        current.records.at(-1) ? ` · event #${current.records.at(-1)!.sequence}` : ''
                      }`}
                    >
                      <p>
                        Recorded by this step. It is not the run&apos;s current state; inspect the saved logs
                        for details.
                      </p>
                    </Notice>
                  ))}
              </>
            )}
            {active === 'Messages' && (
              <>
                <Caption>
                  Invocation checkpoint snapshot; messages may include later steps/retries, not a
                  reconstruction at selected event time. Historical stage events may have no invocation
                  binding. Hidden reasoning is not collected.
                </Caption>
                {inspection?.agents.length ? (
                  <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                    Invocation
                    <Select
                      value={inspection.agent_id ?? ''}
                      onChange={(event) => onInspect?.(undefined, event.target.value)}
                    >
                      {inspection.agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {specialistNames[agent.role] ?? agent.role} · revision {agent.plan_revision} ·{' '}
                          {agent.id.slice(0, 6)}
                        </option>
                      ))}
                    </Select>
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
                <h4 className="text-sm font-semibold">Context receipt</h4>
                {inspection?.context ? (
                  <JsonView value={inspection.context} label="Recorded context use" />
                ) : (
                  <Empty>No context measurement recorded.</Empty>
                )}
              </>
            )}
            {active === 'Evals' && (
              <>
                <Caption>
                  Run-level evaluation evidence from the current snapshot; it is not a reconstruction at the
                  selected span&apos;s time.
                </Caption>
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
                    <article
                      key={evaluation.id}
                      className="grid gap-1 rounded-md border border-border bg-code p-3 text-sm"
                    >
                      <strong className="font-medium">
                        {evaluation.kind} · {evaluation.status}
                      </strong>
                      <p>{evaluation.criterion}</p>
                      {evaluation.snapshot_digest && (
                        <code className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">
                          Snapshot: {evaluation.snapshot_digest}
                        </code>
                      )}
                      {evaluation.artifact_digest && (
                        <code className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">
                          Evidence: {evaluation.artifact_digest}
                        </code>
                      )}
                    </article>
                  ))
                ) : (
                  <Empty>No recorded evaluation evidence yet. Planned checks are not results.</Empty>
                )}
              </>
            )}
            {active === 'Logs' && (
              <>
                <Caption>
                  Run-level logs from the current inspection snapshot. Entries may include later steps or
                  retries beyond the selected span.
                </Caption>
                {inspection?.logs.length ? (
                  inspection.logs.map((entry, index) => (
                    <article
                      key={String(entry.id ?? index)}
                      className="grid gap-1 rounded-md border border-border bg-code p-3 text-sm"
                    >
                      <time className="text-xs text-muted-foreground">{String(entry.timestamp ?? '')}</time>
                      <strong className="font-medium">{String(entry.kind ?? 'event')}</strong>
                      <p>{String(entry.message ?? '')}</p>
                    </article>
                  ))
                ) : (
                  <Empty>No persisted log entries available.</Empty>
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
                <Facts
                  items={[
                    [
                      'Correlation ID',
                      <code className="font-mono text-xs">{current?.id ?? 'No invocation selected'}</code>,
                    ],
                    [
                      'Trace ID',
                      <code className="font-mono text-xs">{current?.event.trace_id ?? 'Not recorded'}</code>,
                    ],
                    [
                      'Span ID',
                      <code className="font-mono text-xs">{current?.event.span_id ?? 'Not recorded'}</code>,
                    ],
                  ]}
                />
                <Caption>
                  These identifiers correlate actual OpenTelemetry spans. No trace is inferred when
                  instrumentation was absent.
                </Caption>
              </>
            )}
            {inspection?.checkpoint_id && (
              <div className="grid justify-items-start gap-2 border-t border-border pt-3">
                <Caption>
                  Invocation checkpoint snapshot <code className="font-mono">{inspection.checkpoint_id}</code>
                  . Messages may include later steps/retries. Pages use this snapshot, not a reconstruction at
                  selected event time.
                </Caption>
                <Button
                  size="sm"
                  type="button"
                  onClick={() => onInspect?.(inspection.role ?? undefined, inspection.agent_id ?? undefined)}
                >
                  Refresh invocation snapshot
                </Button>
              </div>
            )}
            {inspection && !inspection.current && (
              <Notice tone="warning">Historical invocation from an earlier plan revision.</Notice>
            )}
            {inspection?.has_more && (
              <Button type="button" size="sm" className="justify-self-start" onClick={onMore}>
                Load more recorded messages
              </Button>
            )}
          </div>
        )}
      </Tabs>
    </section>
  );
}

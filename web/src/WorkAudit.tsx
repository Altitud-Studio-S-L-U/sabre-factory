import type { ReactNode } from 'react';
import type { AuditView } from './api';
import Disclosure from './components/Disclosure';
import DescriptionList from './components/DescriptionList';
import Notice from './components/Notice';
import { SectionHeading } from './components/PageHeader';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
import CrewAvatar from './features/crew/CrewAvatar';
import { failureLabel } from './features/insights/insights';

const roles: Record<string, string> = {
  supervisor: 'Supervisor',
  analyst: 'Analyst',
  architect: 'Architect',
  developer: 'Developer',
  qa: 'Verification',
  reviewer: 'Technical reviewer',
  security: 'Security',
};
const tools: Record<string, string> = {
  list_files: 'List files',
  read_file: 'Read file',
  read_files: 'Read files',
  search_source: 'Search source',
  read_file_range: 'Read lines',
  write_file: 'Write file',
  edit_source: 'Edit source fragment',
  read_context: 'Recover historical read',
  record_note: 'Record work note',
  read_memory: 'Read verified memory',
  execute: 'Execute command',
  prepare_dependencies: 'Prepare dependencies',
  resolve_dependencies: 'Resolve dependencies',
  external_tool: 'External tool',
};
const count = (value: number) => value.toLocaleString('en-US');
const known = (value: number | null | undefined) =>
  value === null || value === undefined ? 'unknown' : count(value);

export function formatMs(value: number | null | undefined) {
  if (value === null || value === undefined) return 'unknown';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)} min ${Math.round((value % 60_000) / 1000)} s`;
}

export function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined) return 'unknown';
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

type ToolTiming = AuditView['tool_timings'][number];

/** Tool boundaries summed across agents, slowest total first. */
export function toolTotals(timings: ToolTiming[]) {
  const totals = new Map<
    string,
    {
      name: string;
      count: number;
      failed: number;
      total_ms: number;
      max_ms: number;
      output_bytes: number | null;
    }
  >();
  for (const timing of timings) {
    const entry = totals.get(timing.name) ?? {
      name: timing.name,
      count: 0,
      failed: 0,
      total_ms: 0,
      max_ms: 0,
      output_bytes: null,
    };
    entry.count += timing.count;
    entry.failed += timing.failed;
    entry.total_ms += timing.total_ms;
    entry.max_ms = Math.max(entry.max_ms, timing.max_ms);
    if (timing.output_bytes !== null) entry.output_bytes = (entry.output_bytes ?? 0) + timing.output_bytes;
    totals.set(timing.name, entry);
  }
  return [...totals.values()].sort((a, b) => b.total_ms - a.total_ms || a.name.localeCompare(b.name));
}

type ContextUsageSummary = NonNullable<AuditView['context']>;

const note = 'text-xs leading-relaxed text-muted-foreground';
const caution = 'rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning';
const row = 'grid min-w-0 gap-1 rounded-lg border border-border bg-card px-4 py-3 text-sm';

function Subsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid min-w-0 gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ContextUsage({ data }: { data: ContextUsageSummary | null | undefined }) {
  return (
    <Subsection title="Sent context">
      {!data ? (
        <p className={note}>This history has no measurements for sent context or recovered reads.</p>
      ) : (
        <>
          <p className={note}>
            Measured in {count(data.requests_with_context)} of{' '}
            {count(data.requests_with_context + data.requests_without_context)} recorded invocations.
            {data.requests_without_context > 0 &&
              ` ${count(data.requests_without_context)} have no context measurement.`}
          </p>
          <DescriptionList
            className="rounded-lg border border-border bg-card p-4"
            items={[
              ['Before compaction', `${count(data.original_bytes)} bytes`],
              ['Sent', `${count(data.sent_bytes)} bytes`],
              ['Referenced reads', count(data.compacted_results)],
              [
                'Recoveries',
                data.restored_pages === null
                  ? 'Not measured'
                  : `${count(data.restored_pages)} pages · measured in ${count(data.requests_with_restored_pages)} of ${count(data.requests_with_context)} invocations`,
              ],
            ]}
          />
          <p className={note}>
            Context measured before the CLI wrapper. Bytes are not equivalent to tokens or cost savings.
          </p>
          {data.references_truncated && (
            <p className={caution}>Reference details are bounded; totals include all referenced reads.</p>
          )}
          <Disclosure variant="plain" summary="Recorded context policies">
            <ul className="grid gap-1 text-xs">
              {data.policies.map((policy) => (
                <li key={`${policy.version}:${policy.policy}:${policy.input_limit_bytes}`}>
                  <code className="font-mono">{policy.policy}</code> · version {policy.version} · limit{' '}
                  {count(policy.input_limit_bytes)} bytes per request
                </li>
              ))}
            </ul>
          </Disclosure>
        </>
      )}
    </Subsection>
  );
}

export default function WorkAudit({
  data,
  loading = false,
  error,
}: {
  data: AuditView | null;
  loading?: boolean;
  error?: string;
}) {
  return (
    <section aria-labelledby="work-audit-title" className="grid min-w-0 gap-4">
      <SectionHeading
        id="work-audit-title"
        title="Agents and tools"
        description="Agent invocations and tools. Verification and security retain their own evidence."
      />
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {loading && !data && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading activity…
        </p>
      )}
      {data && (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <span className={row}>
              <strong className="text-lg font-semibold tabular-nums">{count(data.usage.calls)}</strong>{' '}
              recorded calls
            </span>
            <span className={row}>
              <strong className="text-lg font-semibold tabular-nums">{count(data.usage.tokens)}</strong>{' '}
              measured tokens
            </span>
            <span className={row}>
              <strong className="text-lg font-semibold tabular-nums">
                {data.usage.cost_usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
              </strong>{' '}
              recorded API cost
            </span>
          </div>
          {data.usage.unsettled_calls > 0 && (
            <p className={caution}>
              {count(data.usage.settled_calls)} calls with measured usage. {count(data.usage.unsettled_calls)}{' '}
              with unconfirmed usage: {count(data.usage.unknown_reserved_tokens)} tokens remain reserved. They
              are not attributed to an agent without evidence.
            </p>
          )}
          <p className={note}>
            API cost excludes subscription fees. Durations come from measured execution boundaries; runs
            recorded before this measurement show them as unknown.
          </p>
          <ContextUsage data={data.context} />
          {!!data.tool_timings?.length && (
            <Subsection title="Tool time">
              <ul className="grid gap-2">
                {toolTotals(data.tool_timings).map((tool) => (
                  <li key={tool.name} className={row}>
                    <strong className="font-medium">{tools[tool.name] ?? 'Tool'}</strong>
                    <span>
                      {count(tool.count)} calls · {formatMs(tool.total_ms)} total · slowest{' '}
                      {formatMs(tool.max_ms)}
                      {tool.failed > 0 ? ` · ${count(tool.failed)} failed` : ''}
                    </span>
                    <small className="text-xs text-muted-foreground">
                      Results sent to the model: {formatBytes(tool.output_bytes)}
                    </small>
                  </li>
                ))}
              </ul>
            </Subsection>
          )}
          {!!data.calls?.length && (
            <Disclosure summary={`View ${count(data.calls.length)} model calls`}>
              <p className={note}>
                Reserved tokens are held before each call; measured tokens are what the provider reported.
                Cached input, read or written, is part of input. A call that never settled keeps its
                reservation and shows why it failed when the factory recorded it.
              </p>
              <Table className="tabular-nums">
                <TableHeader>
                  <TableRow>
                    {[
                      '#',
                      'Role',
                      'Reserved',
                      'Input',
                      'Cached',
                      'Written to cache',
                      'Output',
                      'Sent',
                      'Duration',
                      'Result',
                    ].map((heading) => (
                      <TableHead key={heading} scope="col">
                        {heading}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.calls.map((call) => (
                    <TableRow key={call.sequence}>
                      <TableCell>{call.sequence}</TableCell>
                      <TableCell>{call.role ? (roles[call.role] ?? call.role) : 'Unrecorded'}</TableCell>
                      <TableCell>{count(call.reserved_tokens)}</TableCell>
                      <TableCell>{known(call.input_tokens)}</TableCell>
                      <TableCell>{known(call.cache_read_tokens)}</TableCell>
                      <TableCell>{known(call.cache_write_tokens)}</TableCell>
                      <TableCell>{known(call.output_tokens)}</TableCell>
                      <TableCell>{formatBytes(call.sent_bytes)}</TableCell>
                      <TableCell>{formatMs(call.call_ms)}</TableCell>
                      <TableCell>
                        {call.failure_class
                          ? `Failed: ${failureLabel(call.failure_class).toLowerCase()}`
                          : call.measured_tokens === null
                            ? 'No outcome recorded'
                            : 'Settled'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.calls_truncated && <p className={caution}>Only the first calls are listed.</p>}
            </Disclosure>
          )}
          {!!data.models?.length && (
            <Subsection title="Usage by model">
              <p className={note}>
                Selection recorded when each call was reserved. CLI aliases and defaults do not identify a
                resolved model version.
              </p>
              <ul className="grid gap-2">
                {data.models.map((model, index) => (
                  <li key={index} className={row}>
                    <strong className="font-medium">
                      {model.model_provider ?? 'Unrecorded provider'} ·{' '}
                      {model.model_name || 'Default or unrecorded model'}
                    </strong>
                    <span className="text-muted-foreground">
                      {model.role ? roles[model.role] : 'Unrecorded role'} · configuration{' '}
                      {model.configuration_revision ?? 'not recorded'}
                    </span>
                    <span>
                      {count(model.calls)} calls · {count(model.measured_tokens)} measured tokens ·{' '}
                      {count(model.unknown_reserved_tokens)} unconfirmed reserved tokens
                    </span>
                  </li>
                ))}
              </ul>
            </Subsection>
          )}
          {data.agents.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
              No agent activity has been recorded yet.
            </p>
          ) : (
            <ul className="grid gap-2" aria-label="Activity by agent">
              {data.agents.map((agent) => (
                <li key={agent.id} className={row}>
                  <div className="flex flex-wrap items-center gap-2">
                    <CrewAvatar role={agent.role} size={22} />
                    <strong className="font-medium">{roles[agent.role] ?? agent.role}</strong>
                    <span className="text-xs text-muted-foreground">Review {agent.plan_revision}</span>
                  </div>
                  {agent.duration_ms !== null && (
                    <small className="text-xs text-muted-foreground">
                      Active {formatMs(agent.duration_ms)}
                    </small>
                  )}
                  {agent.model_responses ? (
                    <>
                      <span>
                        {count(agent.model_responses)} responses ·{' '}
                        {count(agent.input_tokens + agent.output_tokens)} measured tokens
                      </span>
                      <small className="text-xs text-muted-foreground">
                        Input {count(agent.input_tokens)} · output {count(agent.output_tokens)} · cached input{' '}
                        {count(agent.cache_read_tokens)}
                      </small>
                      <small className="text-xs text-muted-foreground">
                        {count(agent.tool_requests)} tools requested · {count(agent.tool_responses)} responses
                        received
                        {agent.notes_recorded ? ` · ${count(agent.notes_recorded)} work notes` : ''}
                        {agent.memories_proposed
                          ? ` · ${count(agent.memories_proposed)} proposed to memory`
                          : ''}
                      </small>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No recorded model response</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {data.tools.length > 0 && (
            <Disclosure summary={`View ${count(data.tools.length)} tool requests`}>
              <p className={note}>
                Ordered within each agent. Receiving a response does not mean a check passed.
              </p>
              <ol className="grid gap-2">
                {data.tools.map((tool) => {
                  const failed =
                    tool.response === 'error' || (tool.exit_code !== null && tool.exit_code !== 0);
                  return (
                    <li key={tool.id} data-state={failed ? 'failed' : 'ok'} className={row}>
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <strong className="font-medium">{tools[tool.name] ?? 'Tool'}</strong>
                        <small className="text-xs text-muted-foreground">
                          {roles[tool.role] ?? tool.role} · revision {tool.plan_revision}
                        </small>
                      </div>
                      <span className={failed ? 'text-danger' : 'text-muted-foreground'}>
                        {tool.response === 'requested'
                          ? 'Request with no recorded response'
                          : tool.response === 'error'
                            ? 'Error response'
                            : tool.exit_code !== null
                              ? `Command finished · exit ${tool.exit_code}`
                              : 'Response received'}
                      </span>
                      {tool.output_digest && (
                        <Disclosure variant="plain" summary="Result reference" className="text-xs">
                          <code className="font-mono text-xs [overflow-wrap:anywhere]">
                            {tool.output_digest}
                          </code>
                        </Disclosure>
                      )}
                    </li>
                  );
                })}
              </ol>
            </Disclosure>
          )}
          {data.truncated && (
            <p className={caution}>
              History is bounded in this view. Usage totals cover the complete record.
            </p>
          )}
        </>
      )}
    </section>
  );
}

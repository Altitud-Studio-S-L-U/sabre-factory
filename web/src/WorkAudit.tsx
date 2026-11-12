import type { AuditView } from './api';
import './KnowledgeAudit.css';

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

function ContextUsage({ data }: { data: ContextUsageSummary | null | undefined }) {
  return (
    <section aria-label="Sent context">
      <h3>Sent context</h3>
      {!data ? (
        <p className="audit-note">This history has no measurements for sent context or recovered reads.</p>
      ) : (
        <>
          <p className="audit-note">
            Measured in {count(data.requests_with_context)} of{' '}
            {count(data.requests_with_context + data.requests_without_context)} recorded invocations.
            {data.requests_without_context > 0 &&
              ` ${count(data.requests_without_context)} have no context measurement.`}
          </p>
          <dl className="knowledge-provenance">
            <div>
              <dt>Before compaction</dt>
              <dd>{count(data.original_bytes)} bytes</dd>
            </div>
            <div>
              <dt>Sent</dt>
              <dd>{count(data.sent_bytes)} bytes</dd>
            </div>
            <div>
              <dt>Referenced reads</dt>
              <dd>{count(data.compacted_results)}</dd>
            </div>
            <div>
              <dt>Recoveries</dt>
              <dd>
                {data.restored_pages === null
                  ? 'Not measured'
                  : `${count(data.restored_pages)} pages · measured in ${count(data.requests_with_restored_pages)} of ${count(data.requests_with_context)} invocations`}
              </dd>
            </div>
          </dl>
          <p className="audit-note">
            Context measured before the CLI wrapper. Bytes are not equivalent to tokens or cost savings.
          </p>
          {data.references_truncated && (
            <p className="audit-caution">
              Reference details are bounded; totals include all referenced reads.
            </p>
          )}
          <details className="audit-reference">
            <summary>Recorded context policies</summary>
            <ul>
              {data.policies.map((policy) => (
                <li key={`${policy.version}:${policy.policy}:${policy.input_limit_bytes}`}>
                  <code>{policy.policy}</code> · version {policy.version} · limit{' '}
                  {count(policy.input_limit_bytes)} bytes per request
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
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
    <section className="work-audit" aria-labelledby="work-audit-title">
      <div className="section-heading">
        <h2 id="work-audit-title">Agents and tools</h2>
      </div>
      <p className="audit-intro">
        Agent invocations and tools. Verification and security retain their own evidence.
      </p>
      {error && (
        <p role="alert" className="audit-error">
          {error}
        </p>
      )}
      {loading && !data && <p role="status">Loading activity…</p>}
      {data && (
        <>
          <div className="audit-totals">
            <span>
              <strong>{count(data.usage.calls)}</strong> recorded calls
            </span>
            <span>
              <strong>{count(data.usage.tokens)}</strong> measured tokens
            </span>
            <span>
              <strong>
                {data.usage.cost_usd.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}
              </strong>{' '}
              recorded API cost
            </span>
          </div>
          {data.usage.unsettled_calls > 0 && (
            <p className="audit-caution">
              {count(data.usage.settled_calls)} calls with measured usage. {count(data.usage.unsettled_calls)}{' '}
              with unconfirmed usage: {count(data.usage.unknown_reserved_tokens)} tokens remain reserved. They
              are not attributed to an agent without evidence.
            </p>
          )}
          <p className="audit-note">
            API cost excludes subscription fees. Durations come from measured execution boundaries; runs
            recorded before this measurement show them as unknown.
          </p>
          <ContextUsage data={data.context} />
          {!!data.tool_timings?.length && (
            <section aria-label="Tool time">
              <h3>Tool time</h3>
              <ul className="audit-agents">
                {toolTotals(data.tool_timings).map((tool) => (
                  <li key={tool.name}>
                    <strong>{tools[tool.name] ?? 'Tool'}</strong>
                    <span>
                      {count(tool.count)} calls · {formatMs(tool.total_ms)} total · slowest{' '}
                      {formatMs(tool.max_ms)}
                      {tool.failed > 0 ? ` · ${count(tool.failed)} failed` : ''}
                    </span>
                    <small>Results sent to the model: {formatBytes(tool.output_bytes)}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!data.calls?.length && (
            <details className="audit-tools">
              <summary>View {count(data.calls.length)} model calls</summary>
              <p className="audit-note">
                Reserved tokens are held before each call; measured tokens are what the provider reported.
                Cached input is part of input.
              </p>
              <table className="audit-calls">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Role</th>
                    <th scope="col">Reserved</th>
                    <th scope="col">Input</th>
                    <th scope="col">Cached</th>
                    <th scope="col">Output</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {data.calls.map((call) => (
                    <tr key={call.sequence}>
                      <td>{call.sequence}</td>
                      <td>{call.role ? (roles[call.role] ?? call.role) : 'Unrecorded'}</td>
                      <td>{count(call.reserved_tokens)}</td>
                      <td>{known(call.input_tokens)}</td>
                      <td>{known(call.cache_read_tokens)}</td>
                      <td>{known(call.output_tokens)}</td>
                      <td>{formatBytes(call.sent_bytes)}</td>
                      <td>{formatMs(call.call_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.calls_truncated && <p className="audit-caution">Only the first calls are listed.</p>}
            </details>
          )}
          {!!data.models?.length && (
            <section aria-label="Usage by model">
              <h3>Usage by model</h3>
              <p className="audit-note">
                Selection recorded when each call was reserved. CLI aliases and defaults do not identify a
                resolved model version.
              </p>
              <ul className="audit-agents">
                {data.models.map((model, index) => (
                  <li key={index}>
                    <strong>
                      {model.model_provider ?? 'Unrecorded provider'} ·{' '}
                      {model.model_name || 'Default or unrecorded model'}
                    </strong>
                    <span>
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
            </section>
          )}
          {data.agents.length === 0 ? (
            <p className="audit-empty">No agent activity has been recorded yet.</p>
          ) : (
            <ul className="audit-agents" aria-label="Activity by agent">
              {data.agents.map((agent) => (
                <li key={agent.id}>
                  <div>
                    <strong>{roles[agent.role] ?? agent.role}</strong>
                    <span className="audit-revision">Review {agent.plan_revision}</span>
                  </div>
                  {agent.duration_ms !== null && <small>Active {formatMs(agent.duration_ms)}</small>}
                  {agent.model_responses ? (
                    <>
                      <span>
                        {count(agent.model_responses)} responses ·{' '}
                        {count(agent.input_tokens + agent.output_tokens)} measured tokens
                      </span>
                      <small>
                        Input {count(agent.input_tokens)} · output {count(agent.output_tokens)} · cached input{' '}
                        {count(agent.cache_read_tokens)}
                      </small>
                      <small>
                        {count(agent.tool_requests)} tools requested · {count(agent.tool_responses)} responses
                        received
                      </small>
                    </>
                  ) : (
                    <span>No recorded model response</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {data.tools.length > 0 && (
            <details className="audit-tools">
              <summary>View {count(data.tools.length)} tool requests</summary>
              <p className="audit-note">
                Ordered within each agent. Receiving a response does not mean a check passed.
              </p>
              <ol>
                {data.tools.map((tool) => (
                  <li key={tool.id}>
                    <div>
                      <strong>{tools[tool.name] ?? 'Tool'}</strong>
                      <small>
                        {roles[tool.role] ?? tool.role} · revision {tool.plan_revision}
                      </small>
                    </div>
                    <span
                      className={
                        tool.response === 'error' || (tool.exit_code !== null && tool.exit_code !== 0)
                          ? 'audit-result-error'
                          : 'audit-result'
                      }
                    >
                      {tool.response === 'requested'
                        ? 'Request with no recorded response'
                        : tool.response === 'error'
                          ? 'Error response'
                          : tool.exit_code !== null
                            ? `Command finished · exit ${tool.exit_code}`
                            : 'Response received'}
                    </span>
                    {tool.output_digest && (
                      <details className="audit-reference">
                        <summary>Result reference</summary>
                        <code>{tool.output_digest}</code>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {data.truncated && (
            <p className="audit-caution">
              History is bounded in this view. Usage totals cover the complete record.
            </p>
          )}
        </>
      )}
    </section>
  );
}

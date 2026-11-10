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
            API cost excludes subscription fees. Individual duration is not recorded in this history.
          </p>
          <ContextUsage data={data.context} />
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

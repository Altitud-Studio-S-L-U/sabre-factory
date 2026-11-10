import type { ProjectKnowledgeReport } from './api';
import './KnowledgeAudit.css';

const count = (value: number) => value.toLocaleString('en-US');

export default function ProjectKnowledge({
  data,
  loading = false,
  error,
}: {
  data: ProjectKnowledgeReport | null;
  loading?: boolean;
  error?: string;
}) {
  return (
    <section className="project-knowledge" aria-labelledby="project-knowledge-title">
      <div className="section-heading">
        <h2 id="project-knowledge-title">What SABRE retains</h2>
      </div>
      {error && (
        <p role="alert" className="audit-error">
          {error}
        </p>
      )}
      {loading && !data && <p role="status">Loading project context…</p>}
      {data && (
        <>
          <div className="knowledge-kinds">
            <div>
              <h3>Project knowledge</h3>
              <strong>
                {count(data.memories.active)} active · {count(data.memories.pending)} pending
              </strong>
              <p>
                {data.memories.total === 0
                  ? 'No memories yet. Delivery facts are recorded after the PR is published; lessons require review.'
                  : 'Facts and lessons with provenance. Invalidated memories no longer guide runs.'}
              </p>
            </div>
            <div>
              <h3>Resume state</h3>
              <strong>{count(data.checkpoints.count)} development checkpoints</strong>
              <p>
                Retain progress and histories for {count(data.checkpoints.threads)} development and agent
                flows. Security retains separate records.
              </p>
            </div>
            <div>
              <h3>Source navigation</h3>
              <strong>Text search by project</strong>
              <p>
                The local index supports search and bounded reads.{' '}
                {data.semantic_search
                  ? 'Vector memory search is configured.'
                  : 'Vector memory search is not configured.'}
              </p>
            </div>
          </div>
          <p className="audit-note">
            Authorized profile: {data.profile === 'node' ? 'Node.js' : 'Python'} · {data.gate_count}{' '}
            {data.gate_count === 1 ? 'configured check' : 'configured checks'}.
          </p>
          {data.context ? (
            <details className="knowledge-context">
              <summary>Recorded source context</summary>
              <p className="audit-note">
                This is an agent-recorded reference. The repository has not been checked again and the
                reference may be outdated.
              </p>
              <dl className="knowledge-provenance">
                <div>
                  <dt>Source commit</dt>
                  <dd>
                    <code>{data.context.source_commit}</code>
                  </dd>
                </div>
                <div>
                  <dt>Snapshot</dt>
                  <dd>
                    <code>{data.context.snapshot_digest}</code>
                  </dd>
                </div>
                <div>
                  <dt>Scope</dt>
                  <dd>
                    {count(data.context.total_files)} files · {count(data.context.text_files)} text ·{' '}
                    {count(data.context.omitted_files)} outside this selection
                  </dd>
                </div>
              </dl>
              <ul className="knowledge-files" aria-label="Recorded context files">
                {data.context.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    <span>
                      {file.lines !== null ? `${count(file.lines)} lines` : 'Outside the indexing limit'}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="audit-empty">
              {data.truncated
                ? 'No context is available in this bounded selection.'
                : 'No source context recorded for the current revision.'}
            </p>
          )}
          {data.truncated && (
            <p className="audit-caution">
              Context selection is limited to recent histories. Counters cover the complete record.
            </p>
          )}
        </>
      )}
    </section>
  );
}

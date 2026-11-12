import type { ReactNode } from 'react';
import type { ProjectKnowledgeReport } from './api';
import Disclosure from './components/Disclosure';
import DescriptionList from './components/DescriptionList';
import Notice from './components/Notice';
import { SectionHeading } from './components/PageHeader';

const count = (value: number) => value.toLocaleString('en-US');
const note = 'text-xs leading-relaxed text-muted-foreground';

function Kind({ title, value, children }: { title: string; value: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5 bg-card p-4">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <strong className="text-base font-semibold">{value}</strong>
      <p className={note}>{children}</p>
    </div>
  );
}

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
    <section className="@container grid min-w-0 gap-4" aria-labelledby="project-knowledge-title">
      <SectionHeading id="project-knowledge-title" title="What SABRE retains" />
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {loading && !data && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading project context…
        </p>
      )}
      {data && (
        <>
          <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border @2xl:grid-cols-3">
            <Kind
              title="Project knowledge"
              value={`${count(data.memories.active)} active · ${count(data.memories.pending)} pending`}
            >
              {data.memories.total === 0
                ? 'No memories yet. Delivery facts are recorded after the PR is published; lessons require review.'
                : 'Facts and lessons with provenance. Invalidated memories no longer guide runs.'}
            </Kind>
            <Kind title="Resume state" value={`${count(data.checkpoints.count)} development checkpoints`}>
              Retain progress and histories for {count(data.checkpoints.threads)} development and agent flows.
              Security retains separate records.
            </Kind>
            <Kind title="Source navigation" value="Text search by project">
              The local index supports search and bounded reads.{' '}
              {data.semantic_search
                ? 'Vector memory search is configured.'
                : 'Vector memory search is not configured.'}
            </Kind>
          </div>
          <p className={note}>
            Authorized profile: {data.profile === 'node' ? 'Node.js' : 'Python'} · {data.gate_count}{' '}
            {data.gate_count === 1 ? 'configured check' : 'configured checks'}.
          </p>
          {data.context ? (
            <Disclosure summary="Recorded source context">
              <p className={note}>
                This is an agent-recorded reference. The repository has not been checked again and the
                reference may be outdated.
              </p>
              <DescriptionList
                items={[
                  ['Source commit', <code className="font-mono text-xs">{data.context.source_commit}</code>],
                  ['Snapshot', <code className="font-mono text-xs">{data.context.snapshot_digest}</code>],
                  [
                    'Scope',
                    `${count(data.context.total_files)} files · ${count(data.context.text_files)} text · ${count(
                      data.context.omitted_files,
                    )} outside this selection`,
                  ],
                ]}
              />
              <ul
                className="grid divide-y divide-border border-y border-border text-sm"
                aria-label="Recorded context files"
              >
                {data.context.files.map((file) => (
                  <li key={file.path} className="flex min-w-0 items-baseline justify-between gap-3 py-2">
                    <code className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{file.path}</code>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {file.lines !== null ? `${count(file.lines)} lines` : 'Outside the indexing limit'}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : (
            <p className="text-sm text-muted-foreground">
              {data.truncated
                ? 'No context is available in this bounded selection.'
                : 'No source context recorded for the current revision.'}
            </p>
          )}
          {data.truncated && (
            <Notice tone="warning">
              Context selection is limited to recent histories. Counters cover the complete record.
            </Notice>
          )}
        </>
      )}
    </section>
  );
}

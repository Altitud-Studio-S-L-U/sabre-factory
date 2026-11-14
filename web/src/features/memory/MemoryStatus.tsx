import type { IngestionJob, IngestionReport, MemoryItem, MemoryRecallPage, MemoryReview } from '../../api';
import Button from '../../components/Button';
import Notice from '../../components/Notice';
import { Card, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { relative } from './shared';

type ReadSummary = NonNullable<IngestionJob['imported']>;

/** What one read of the repository changed; outcomes that did not happen are left out. */
export function readOutcome(summary: ReadSummary) {
  const parts = (
    [
      [summary.proposed, 'proposed'],
      [summary.replaced, 'proposed with changed text'],
      [summary.unchanged, 'unchanged'],
      [summary.declined, 'declined by you before'],
      [summary.withdrawn, 'withdrawn'],
      [summary.refused, 'refused'],
      [summary.omitted, 'left out by the limit of one read'],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  return parts.length ? parts.join(' · ') : 'it states nothing the factory recognizes';
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The state of a project's memory in one sentence, the reason when it is empty and the one action
 * that fills it. Reading the repository indexes the default branch and proposes what its
 * instruction files and manifests say; it makes no model call and approves nothing.
 */
export default function MemoryStatus({
  ingestion,
  items,
  review,
  recalls,
  now,
  loading,
  connected,
  busy,
  error,
  onRead,
  onReview,
}: {
  ingestion: IngestionReport | null;
  items: MemoryItem[];
  review: MemoryReview | null;
  recalls: MemoryRecallPage | null;
  now: number;
  loading: boolean;
  connected: boolean;
  busy: boolean;
  error: string;
  onRead: () => void;
  onReview: () => void;
}) {
  const jobs = ingestion?.jobs ?? [];
  const latestJob = jobs[0];
  const index = ingestion?.latest;
  const reading = jobs.some((job) => job.state === 'queued' || job.state === 'running');
  const lastRead = jobs.find((job) => job.state === 'completed' && job.imported);
  const approved = items.filter((item) => item.active && !item.invalidated_at).length;
  const pending =
    review?.pending.length ?? items.filter((item) => !item.active && !item.invalidated_at).length;
  const stale = review?.stale.length ?? 0;
  const lastWrite = items.reduce<string | null>(
    (latest, item) => (!latest || item.created_at > latest ? item.created_at : latest),
    null,
  );
  const lastRecall =
    recalls?.items.find((recall) => recall.outcome === 'recalled' && recall.selected.length > 0)
      ?.created_at ?? null;
  const empty = !approved && !pending && !stale;
  const sentence = loading
    ? 'Loading what the factory knows about this project…'
    : reading
      ? 'Reading the repository. Admission scanning runs before anything is kept.'
      : !index
        ? 'The repository has not been read yet, so the factory knows nothing about this project.'
        : empty
          ? lastRead
            ? 'Nothing is approved or waiting. Memory grows from what the repository says, from the repair lessons of delivered runs and from what you propose.'
            : 'The repository is indexed, but what it says has not been read into memory yet.'
          : [
              plural(approved, 'approved record', 'approved records'),
              `${pending} waiting for your review`,
              ...(stale ? [`${stale} to revalidate`] : []),
            ].join(' · ');
  return (
    <Card aria-labelledby="memory-status-title">
      <CardHeader>
        <div className="grid min-w-0 gap-1.5">
          <CardTitle id="memory-status-title">Memory status</CardTitle>
          <CardDescription>{sentence}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {pending > 0 && !loading && (
            <Button variant="primary" onClick={onReview}>
              Review {plural(pending, 'proposal', 'proposals')}
            </Button>
          )}
          <Button
            variant={pending > 0 || lastRead ? 'secondary' : 'primary'}
            disabled={!connected || busy || reading || loading}
            onClick={onRead}
          >
            {reading ? 'Reading…' : lastRead ? 'Read the repository again' : 'Read the repository'}
          </Button>
        </div>
      </CardHeader>
      {!loading && !lastRead && !reading && (
        <p className="text-sm text-muted-foreground">
          Reading indexes the default branch and proposes what its instruction files (AGENTS.md, CLAUDE.md,
          contribution guides) and manifests say, each with the line it cites. It makes no model call, and
          nothing is used by a run until you approve it.
        </p>
      )}
      {((!loading && !empty) || lastRead?.imported) && (
        <div className="grid gap-1 text-sm text-muted-foreground">
          {!loading && !empty && (
            <p>
              Last written {relative(lastWrite, now)} · last recalled by a run{' '}
              {lastRecall ? relative(lastRecall, now) : 'never'}
            </p>
          )}
          {lastRead?.imported && (
            <p>
              Last read at{' '}
              <code className="font-mono text-xs">
                {(lastRead.source_commit ?? '').slice(0, 8) || 'unknown'}
              </code>
              {lastRead.finished_at ? ` · ${relative(lastRead.finished_at, now)}` : ''}:{' '}
              {readOutcome(lastRead.imported)}.
            </p>
          )}
        </div>
      )}
      {latestJob?.error_code && (
        <Notice tone="warning" role="status">
          <span>
            <code>{latestJob.error_code}</code> · {latestJob.error_message}
          </span>
        </Notice>
      )}
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {index && (
        <p className="text-xs text-muted-foreground">
          Index v{index.index_version} · {index.files.length} file references · {index.omitted_files} omitted
          · captured {new Date(index.captured_at).toLocaleString('en-US')}. Current at capture; the repository
          may have changed.
        </p>
      )}
    </Card>
  );
}

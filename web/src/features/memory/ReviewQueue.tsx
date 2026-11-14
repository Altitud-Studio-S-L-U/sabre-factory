import { useState } from 'react';
import type { Api, MemoryReview } from '../../api';
import Button from '../../components/Button';
import EmptyState from '../../components/EmptyState';
import Notice from '../../components/Notice';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/utils';
import { message } from '../runs/shared';
import { anchor, headline, KindBadge, proposer, short } from './shared';

/**
 * Proposals waiting for the owner, each compared with the memories it overlaps, and approved
 * memories whose cited files changed. Overlap is measured, never judged: deciding whether two
 * memories conflict stays with the owner.
 */
export default function ReviewQueue({
  api,
  review,
  connected,
  onChanged,
  onInspect,
}: {
  api: Api;
  review: MemoryReview;
  connected: boolean;
  onChanged: (notice: string) => void;
  onInspect: (memoryId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = review.pending.find((entry) => entry.item.id === selectedId) ?? review.pending[0];
  const overlap = selected?.overlaps[0];
  // A proposal that already names what it replaces supersedes it on a plain approval.
  const replaces = selected?.item.supersedes ?? null;
  const act = async (run: () => Promise<unknown>, notice: string) => {
    if (busy || !connected) return;
    setBusy(true);
    setError('');
    try {
      await run();
      onChanged(notice);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!review.pending.length && !review.stale.length)
    return (
      <EmptyState as="h2" title="Nothing waiting for review">
        What the repository says, the repair lessons of delivered runs and your own proposals wait here for
        your decision, next to any memory they overlap. Approved memories whose cited files change appear here
        too.
      </EmptyState>
    );

  return (
    <div className="@container/review grid min-w-0 gap-4">
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <div className="grid min-w-0 items-start gap-4 @4xl/review:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-4">
          {review.pending.length > 0 && (
            <section
              aria-labelledby="review-proposals"
              className="overflow-hidden rounded-xl border border-border bg-card"
            >
              <h2 id="review-proposals" className="border-b border-border px-4 py-3 text-sm font-semibold">
                Proposals <span className="font-normal text-muted-foreground">· {review.pending.length}</span>
              </h2>
              <ul>
                {review.pending.map((entry) => {
                  const active = entry.item.id === selected?.item.id;
                  return (
                    <li key={entry.item.id} className="border-b border-border last:border-b-0">
                      <button
                        type="button"
                        aria-pressed={active}
                        aria-label={`Review proposal ${headline(entry.item.content, 60)}`}
                        onClick={() => setSelectedId(entry.item.id)}
                        className={cn(
                          'grid w-full cursor-pointer gap-1.5 px-4 py-3 text-left hover:bg-hover/50',
                          active && 'bg-accent/15 shadow-[inset_3px_0_0_var(--primary)]',
                        )}
                      >
                        <span className="line-clamp-2 text-sm font-medium whitespace-pre-line">
                          {entry.item.content}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {entry.item.kind === 'fact' ? 'Fact' : 'Lesson'} ·{' '}
                          {proposer(entry.item.proposed_by)}
                        </span>
                        {entry.overlaps.length > 0 ? (
                          <Badge variant="warning" className="w-fit">
                            Overlaps {short(entry.overlaps[0].memory_id)} ·{' '}
                            {Math.round(entry.overlaps[0].score * 100)}%
                          </Badge>
                        ) : (
                          <Badge variant="success" className="w-fit">
                            No overlap · provenance verified
                          </Badge>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {review.stale.length > 0 && (
            <section
              aria-labelledby="review-stale"
              className="overflow-hidden rounded-xl border border-border bg-card"
            >
              <h2 id="review-stale" className="border-b border-border px-4 py-3 text-sm font-semibold">
                Needs revalidation{' '}
                <span className="font-normal text-muted-foreground">· {review.stale.length}</span>
              </h2>
              <ul>
                {review.stale.map((entry) => (
                  <li
                    key={entry.item.id}
                    className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0"
                  >
                    <span className="line-clamp-2 text-sm font-medium">{entry.item.content}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry.changed_paths.map((path) => `${path.path} ${path.change}`).join(' · ')}
                      {entry.item.recall_count ? ` · recalled ${entry.item.recall_count} times` : ''}
                    </span>
                    <span className="flex flex-wrap gap-2">
                      {review.commit && !entry.changed_paths.every((path) => path.change === 'deleted') && (
                        <Button
                          size="sm"
                          disabled={busy || !connected}
                          onClick={() =>
                            void act(
                              () => api.carryMemoryForward(entry.item.id, review.commit!),
                              'Memory carried forward to the current commit on your authority.',
                            )
                          }
                        >
                          Carry forward
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy || !connected}
                        onClick={() =>
                          void act(
                            () => api.memoryAction(entry.item.id, 'invalidate'),
                            'Memory invalidated. It will no longer guide new context retrieval.',
                          )
                        }
                      >
                        Invalidate
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onInspect(entry.item.id)}>
                        Inspect
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {selected && (
          <section
            aria-label="Proposal comparison"
            className="grid min-w-0 content-start gap-4 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  {overlap ? 'Proposal against the memory it overlaps most' : 'Proposal'}
                </span>
                <h2 className="text-base font-semibold">{headline(selected.item.content)}</h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || !connected}
                  onClick={() =>
                    void act(
                      () => api.memoryAction(selected.item.id, 'invalidate'),
                      'Proposal rejected. It stays in history and never guides a run.',
                    )
                  }
                >
                  Reject
                </Button>
                {overlap && overlap.state === 'active' && (
                  <Button
                    size="sm"
                    disabled={busy || !connected}
                    onClick={() =>
                      void act(
                        () => api.approveMemory(selected.item.id, { related: [overlap.memory_id] }),
                        'Proposal approved and linked as related.',
                      )
                    }
                  >
                    Approve as related
                  </Button>
                )}
                {overlap && overlap.state === 'active' && overlap.memory_id !== replaces && (
                  <Button
                    size="sm"
                    disabled={busy || !connected}
                    onClick={() =>
                      void act(
                        () => api.approveMemory(selected.item.id, { supersedes: overlap.memory_id }),
                        `Proposal approved. ${short(overlap.memory_id)} is superseded and no longer recalled.`,
                      )
                    }
                  >
                    Approve and supersede {short(overlap.memory_id)}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !connected}
                  onClick={() =>
                    void act(
                      () => api.approveMemory(selected.item.id, {}),
                      replaces
                        ? `Proposal approved. ${short(replaces)} is replaced and no longer recalled.`
                        : 'Memory approved with its recorded provenance.',
                    )
                  }
                >
                  {replaces ? `Approve and replace ${short(replaces)}` : 'Approve'}
                </Button>
              </div>
            </div>
            <div className={cn('grid min-w-0 gap-3', overlap && '@3xl/review:grid-cols-2')}>
              <article className="grid content-start gap-2 rounded-lg border border-dashed border-warning-border bg-warning-bg/30 p-3">
                <span className="flex items-center justify-between gap-2">
                  <span className="flex gap-1.5">
                    <KindBadge kind={selected.item.kind} />
                    <Badge variant="warning">Proposal</Badge>
                  </span>
                  <code className="font-mono text-xs text-muted-foreground">{short(selected.item.id)}</code>
                </span>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{selected.item.content}</p>
                <span className="text-xs text-muted-foreground">
                  {proposer(selected.item.proposed_by)} · {anchor(selected.item)}
                  {selected.item.citations.length > 0 && ` · cites ${selected.item.citations.join(', ')}`}
                </span>
                {replaces && (
                  <span className="text-xs text-muted-foreground">
                    Replaces <code className="font-mono">{short(replaces)}</code> when you approve it; until
                    then the earlier record keeps guiding runs.
                  </span>
                )}
              </article>
              {overlap && (
                <article className="grid content-start gap-2 rounded-lg border border-primary/35 bg-primary/5 p-3">
                  <span className="flex items-center justify-between gap-2">
                    <Badge variant={overlap.state === 'active' ? 'success' : 'warning'}>
                      {overlap.state === 'active' ? 'Approved' : 'Also pending'}
                    </Badge>
                    <code className="font-mono text-xs text-muted-foreground">
                      {short(overlap.memory_id)}
                    </code>
                  </span>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{overlap.content}</p>
                  <button
                    type="button"
                    onClick={() => onInspect(overlap.memory_id)}
                    className="w-fit cursor-pointer text-xs text-link hover:underline"
                  >
                    Open in the map
                  </button>
                </article>
              )}
            </div>
            {overlap && (
              <div className="grid gap-2 text-sm">
                <h3 className="text-xs font-medium text-muted-foreground">What the factory measured</h3>
                <p>
                  Overlap {Math.round(overlap.score * 100)}% · wording {Math.round(overlap.lexical * 100)}%
                  {overlap.cosine == null
                    ? ' · no embeddings configured'
                    : ` · meaning ${Math.round(overlap.cosine * 100)}%`}
                </p>
                <TermRow label="Only in the proposal" terms={overlap.only_this} tone="warning" />
                <TermRow label="Only in the memory" terms={overlap.only_other} tone="primary" />
                <p className="text-xs text-muted-foreground">
                  The factory measures overlap; it does not decide whether two memories conflict. Memory
                  follows delivered code: if the code changed, approve and supersede; if not, reject.
                </p>
              </div>
            )}
            {selected.overlaps.length > 1 && (
              <p className="text-xs text-muted-foreground">
                Also overlaps{' '}
                {selected.overlaps
                  .slice(1)
                  .map((entry) => `${short(entry.memory_id)} (${Math.round(entry.score * 100)}%)`)
                  .join(', ')}
                .
              </p>
            )}
          </section>
        )}
      </div>
      {review.truncated && (
        <p className="text-xs text-muted-foreground">Showing the first 100 of each list.</p>
      )}
    </div>
  );
}

function TermRow({ label, terms, tone }: { label: string; terms: string[]; tone: 'warning' | 'primary' }) {
  if (!terms.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {terms.slice(0, 12).map((term) => (
        <code
          key={term}
          className={cn(
            'rounded px-1.5 py-0.5 text-xs',
            tone === 'warning' ? 'bg-warning-bg text-warning' : 'bg-primary/15 text-primary',
          )}
        >
          {term}
        </code>
      ))}
    </div>
  );
}

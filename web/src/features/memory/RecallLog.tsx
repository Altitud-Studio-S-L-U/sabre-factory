import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Api, MemoryRecall } from '../../api';
import Button from '../../components/Button';
import EmptyState from '../../components/EmptyState';
import { SkeletonStatus, SkeletonTable } from '../../components/Skeletons';
import Notice from '../../components/Notice';
import { message } from '../runs/shared';
import { runPath } from '../runs/RunsTable';
import { relative, short } from './shared';
import { crewLabel } from '../crew/CrewAvatar';

const rank = (value: number | null) => (value == null ? '—' : `#${value}`);

/**
 * What each station received from memory, how it ranked and how many bytes it cost, including
 * calls the factory refused because a cited memory changed. Rows come from the recall log the
 * backend writes on every retrieval; nothing is inferred from prompts.
 */
export default function RecallLog({
  api,
  projectId,
  refreshKey,
  onInspect,
  semantic = false,
}: {
  api: Api;
  projectId: string;
  refreshKey: number;
  onInspect: (memoryId: string) => void;
  /** Whether this instance ranks by meaning as well as by wording (an embedding model is configured). */
  semantic?: boolean;
}) {
  const [state, setState] = useState<{
    key: string;
    items: MemoryRecall[];
    next: string | null;
    error?: string;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${projectId}|${refreshKey}`;
  useEffect(() => {
    let live = true;
    void api
      .memoryRecalls(projectId, { limit: 50 })
      .then((page) => {
        if (!live) return;
        if (!Array.isArray(page?.items))
          setState({ key, items: [], next: null, error: 'The server returned an unexpected recall log.' });
        else setState({ key, items: page.items, next: page.next_cursor });
      })
      .catch((error: unknown) => live && setState({ key, items: [], next: null, error: message(error) }));
    return () => {
      live = false;
    };
  }, [api, projectId, key]);
  const current = state?.key === key ? state : null;
  const more = async () => {
    if (!current?.next || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.memoryRecalls(projectId, { limit: 50, cursor: current.next });
      setState({ key, items: [...current.items, ...page.items], next: page.next_cursor });
    } catch (error) {
      setState({ ...current, error: message(error) });
    } finally {
      setLoadingMore(false);
    }
  };

  if (!current)
    return (
      <SkeletonStatus label="Loading the recall log…">
        <SkeletonTable
          rows={5}
          columns={['mono', 'text', 'text', 'title', 'badge', 'mono', 'mono', 'text']}
        />
      </SkeletonStatus>
    );
  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-xs text-muted-foreground">
        {semantic
          ? 'Hybrid retrieval: wording and meaning ranks fused, at most 4 memories and 6 KiB per call.'
          : 'Retrieval by wording, at most 4 memories and 6 KiB per call. Ranking by meaning needs an embedding model, and this instance has none configured.'}{' '}
        Every cited memory is revalidated before each model call.
      </p>
      {current.error && (
        <Notice tone="danger" role="alert">
          {current.error}
        </Notice>
      )}
      {!current.items.length && !current.error ? (
        <EmptyState as="h2" title="No recalls recorded yet">
          Each time a station asks memory for context, the query, the memories it received and their ranks are
          recorded here.
        </EmptyState>
      ) : (
        current.items.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[54rem] border-collapse text-sm">
              <caption className="sr-only">Recall log</caption>
              <thead className="bg-secondary/50 text-left text-xs text-muted-foreground">
                <tr>
                  {[
                    'When',
                    'Run · station',
                    'Role',
                    'Query terms',
                    'Received',
                    'Bytes',
                    'Rank wording / meaning',
                    'Outcome',
                  ].map((head) => (
                    <th key={head} scope="col" className="px-3 py-2.5 font-medium whitespace-nowrap">
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {current.items.map((recall) => (
                  <tr key={recall.id} className="border-t border-border align-top">
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground">
                      <time dateTime={recall.created_at}>{relative(recall.created_at)}</time>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {recall.work_id ? (
                        <Link to={runPath(recall.work_id)} className="font-mono text-xs hover:underline">
                          {short(recall.work_id)}
                        </Link>
                      ) : (
                        '—'
                      )}
                      {recall.stage ? (
                        <span className="text-xs text-muted-foreground"> · {recall.stage}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5">{recall.role ? crewLabel(recall.role) : '—'}</td>
                    <td className="max-w-56 px-3 py-2.5">
                      <span className="line-clamp-2 font-mono text-xs text-muted-foreground">
                        {recall.query_terms.slice(0, 8).join(' ')}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="flex flex-wrap gap-1">
                        {(recall.outcome === 'refused'
                          ? recall.refused_memory_ids
                          : recall.selected.map((s) => s.memory_id)
                        ).map((id) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => onInspect(id)}
                            className="cursor-pointer rounded bg-primary/15 px-1.5 py-0.5 font-mono text-xs text-primary hover:bg-primary/25"
                          >
                            {short(id)}
                          </button>
                        ))}
                        {recall.outcome === 'recalled' && !recall.selected.length && (
                          <span className="text-xs text-muted-foreground">Nothing matched</span>
                        )}
                      </span>
                      {recall.omitted > 0 && (
                        <span className="text-xs text-muted-foreground">
                          +{recall.omitted} over the limit
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap">
                      {recall.bytes.toLocaleString('en-US')}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap">
                      {recall.selected
                        .slice(0, 3)
                        .map((s) => `${rank(s.lexical_rank)} / ${rank(s.vector_rank)}`)
                        .join(' · ') || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                      {recall.outcome === 'refused' ? (
                        <span className="text-danger">Refused · {recall.error_code ?? 'changed'}</span>
                      ) : (
                        <span className="text-success">Recalled · {recall.candidates} candidates</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {current.next && (
        <Button size="sm" className="w-fit" disabled={loadingMore} onClick={() => void more()}>
          {loadingMore ? 'Loading…' : 'Load older recalls'}
        </Button>
      )}
    </div>
  );
}

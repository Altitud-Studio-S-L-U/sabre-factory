import { useEffect, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { ApiError, type Api, type MemoryListItem } from '../../api';
import Button from '../../components/Button';
import EmptyState from '../../components/EmptyState';
import Input from '../../components/Input';
import Notice from '../../components/Notice';
import SegmentedControl from '../../components/SegmentedControl';
import { SkeletonStatus, SkeletonTable } from '../../components/Skeletons';
import { Badge } from '../../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { cn } from '../../lib/utils';
import { message } from '../runs/shared';
import MemoryInspector from './MemoryInspector';
import { KindBadge, StateBadge, proposer, relative, short } from './shared';

export const RECORDS_PAGE = 50;
const states = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Approved' },
  { value: 'pending', label: 'Needs review' },
  { value: 'stale', label: 'Stale' },
  { value: 'invalidated', label: 'Invalidated' },
] as const;
const kinds = [
  { value: 'all', label: 'All kinds' },
  { value: 'fact', label: 'Facts' },
  { value: 'lesson', label: 'Lessons' },
] as const;
type StateFilter = (typeof states)[number]['value'];
type KindFilter = (typeof kinds)[number]['value'];
interface Loaded {
  key: string;
  items: MemoryListItem[];
  next: string | null;
  commit: string | null;
  error?: string;
  unsupported?: boolean;
}

/** Whether a memory would be recalled at the newest indexed commit, in a few words. */
function Holds({ item }: { item: MemoryListItem }) {
  if (item.state !== 'active') return null;
  if (item.validity.state === 'stale') return <Badge variant="warning">Stale</Badge>;
  if (item.validity.state === 'valid') return <span className="text-xs text-muted-foreground">Holds</span>;
  return <span className="text-xs text-muted-foreground">Not recallable</span>;
}

/**
 * Every memory of a project, searchable and filtered by state and kind, paged by cursor.
 * Selecting one opens the inspector beside the table. Servers without the paged listing get ``fallback``.
 */
export default function MemoryRecords({
  api,
  projectId,
  connected,
  refreshKey,
  onChanged,
  fallback,
}: {
  api: Api;
  projectId: string;
  connected: boolean;
  refreshKey: number;
  onChanged: (notice: string) => void;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<StateFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [more, setMore] = useState({ busy: false, error: '' });
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const key = JSON.stringify([projectId, state, kind, query, refreshKey]);
  const filters = {
    state: state === 'all' ? undefined : state,
    kind: kind === 'all' ? undefined : kind,
    q: query || undefined,
    limit: RECORDS_PAGE,
  };
  useEffect(() => {
    let live = true;
    const empty = { key, items: [], next: null, commit: null };
    void api
      .memoryItems(projectId, {
        state: state === 'all' ? undefined : state,
        kind: kind === 'all' ? undefined : kind,
        q: query || undefined,
        limit: RECORDS_PAGE,
      })
      .then((page) => {
        if (!live) return;
        if (!page || !Array.isArray(page.items)) setLoaded({ ...empty, unsupported: true });
        else
          setLoaded({ key, items: page.items, next: page.next_cursor ?? null, commit: page.commit ?? null });
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 405))
          setLoaded({ ...empty, unsupported: true });
        else setLoaded({ ...empty, error: message(error) });
      });
    return () => {
      live = false;
    };
  }, [api, projectId, state, kind, query, key]);
  const current = loaded?.key === key ? loaded : null;
  if (loaded?.unsupported) return <>{fallback}</>;
  const loadMore = async () => {
    if (!current?.next || more.busy) return;
    setMore({ busy: true, error: '' });
    try {
      const page = await api.memoryItems(projectId, { ...filters, cursor: current.next });
      setLoaded((value) =>
        value?.key === key
          ? { ...value, items: [...value.items, ...page.items], next: page.next_cursor ?? null }
          : value,
      );
      setMore({ busy: false, error: '' });
    } catch (error) {
      setMore({ busy: false, error: message(error) });
    }
  };
  const filtered = state !== 'all' || kind !== 'all' || !!query;
  return (
    <div className={cn('grid min-w-0 items-start gap-4', selected && '@5xl:grid-cols-[minmax(0,1fr)_22rem]')}>
      <section aria-labelledby="memory-records-title" className="grid min-w-0 gap-3">
        <h2 id="memory-records-title" className="sr-only">
          Memory records
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-64">
            <span className="sr-only">Search memories</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={text}
              maxLength={200}
              placeholder="Search content"
              className="pl-8"
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <SegmentedControl label="Memory kind" value={kind} options={kinds} onChange={setKind} />
        </div>
        <SegmentedControl label="Memory state" value={state} options={states} onChange={setState} />
        {!current ? (
          <SkeletonStatus label="Loading memories…">
            <SkeletonTable rows={5} columns={['title', 'badge', 'badge', 'text', 'mono']} />
          </SkeletonStatus>
        ) : current.error ? (
          <Notice tone="danger" role="alert">
            {current.error}
          </Notice>
        ) : !current.items.length ? (
          <EmptyState as="h3" title={filtered ? 'No memories match' : 'No memories yet'}>
            {filtered
              ? 'Change the search or the filters. Only this project’s records are searched.'
              : 'A memory is recorded only when a run delivers a pull request: the run records a fact, and a run that needed repairs proposes a lesson for your review. Audits and runs that stop before delivery record nothing, so a new project starts empty.'}
          </EmptyState>
        ) : (
          <>
            <Table aria-label="Memories">
              <TableHeader>
                <TableRow>
                  <TableHead>Memory</TableHead>
                  <TableHead className="hidden @xl:table-cell">Kind</TableHead>
                  <TableHead className="hidden @xl:table-cell">State</TableHead>
                  <TableHead className="hidden @3xl:table-cell">Recalled</TableHead>
                  <TableHead className="hidden @3xl:table-cell">Provenance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {current.items.map((item) => (
                  <TableRow
                    key={item.id}
                    data-state={selected === item.id ? 'selected' : undefined}
                    className="cursor-pointer data-[state=selected]:bg-primary/[0.06] data-[state=selected]:shadow-[inset_2px_0_0_var(--primary)]"
                    onClick={() => setSelected(item.id)}
                  >
                    <TableCell className="max-w-0 min-w-0 align-top @xl:min-w-56">
                      <span className="mb-1.5 flex flex-wrap items-center gap-1.5 @xl:hidden">
                        <KindBadge kind={item.kind} />
                        <StateBadge state={item.state} />
                        <Holds item={item} />
                      </span>
                      <button
                        type="button"
                        aria-label={`Inspect memory ${short(item.id)}`}
                        aria-pressed={selected === item.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelected(item.id);
                        }}
                        className="line-clamp-2 cursor-pointer text-left text-sm whitespace-pre-line hover:underline"
                      >
                        {item.content}
                      </button>
                      <small className="mt-1 block truncate text-xs text-muted-foreground">
                        {proposer(item.proposed_by)} · {relative(item.created_at)}
                      </small>
                    </TableCell>
                    <TableCell className="hidden align-top @xl:table-cell">
                      <KindBadge kind={item.kind} />
                    </TableCell>
                    <TableCell className="hidden align-top @xl:table-cell">
                      <span className="grid justify-items-start gap-1">
                        <StateBadge state={item.state} />
                        <Holds item={item} />
                      </span>
                    </TableCell>
                    <TableCell className="hidden align-top text-xs whitespace-nowrap tabular-nums @3xl:table-cell">
                      {item.recall_count ? `${item.recall_count} ×` : 'Never'}
                      <small className="mt-1 block text-muted-foreground">
                        {item.recall_count ? relative(item.last_recalled_at) : '—'}
                      </small>
                    </TableCell>
                    <TableCell className="hidden align-top @3xl:table-cell">
                      <code className="font-mono text-xs">{item.source_commit.slice(0, 12)}</code>
                      <small className="mt-1 block text-xs text-muted-foreground">
                        {item.scope === 'project' ? 'Project scope' : 'This commit'}
                        {item.citations.length ? ` · ${item.citations.length} cited` : ''}
                      </small>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span role="status">
                {current.items.length} shown{current.next ? ' · more available' : ''}
                {current.commit ? ` · validity at ${current.commit.slice(0, 8)}` : ' · no indexed commit yet'}
              </span>
              {current.next && (
                <Button variant="secondary" size="sm" disabled={more.busy} onClick={() => void loadMore()}>
                  {more.busy ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </div>
            {more.error && (
              <Notice tone="danger" role="alert">
                {more.error}
              </Notice>
            )}
          </>
        )}
      </section>
      {selected && (
        <MemoryInspector
          key={selected}
          api={api}
          memoryId={selected}
          connected={connected}
          refreshKey={refreshKey}
          onChanged={onChanged}
          onFocus={setSelected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

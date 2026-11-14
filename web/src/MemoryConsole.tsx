import Button from './components/Button';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain } from 'lucide-react';
import {
  ApiError,
  type Api,
  type MemoryItem,
  type Project,
  type ProjectKnowledgeReport,
  type WorkOrder,
  type IngestionReport,
  type AuditView,
  type MemoryRecallPage,
  type MemoryReview,
} from './api';
import StatTile, { StatGrid } from './components/StatTile';
import {
  InspectorSkeleton,
  KnowledgeMapSkeleton,
  SkeletonStatus,
  SkeletonTable,
} from './components/Skeletons';
import MemoryLayers from './features/memory/MemoryLayers';
import CoverageMap from './features/memory/CoverageMap';
import KnowledgeMap from './features/memory/KnowledgeMap';
import MemoryInspector from './features/memory/MemoryInspector';
import ReviewQueue from './features/memory/ReviewQueue';
import RecallLog from './features/memory/RecallLog';
import MemoryRecords from './features/memory/MemoryRecords';
import MemoryStatus from './features/memory/MemoryStatus';
import { endings } from './features/memory/shared';
import ProposeMemoryDialog, { type IndexedCommit } from './features/memory/ProposeMemoryDialog';
import Dialog, { DialogActions } from './components/Dialog';
import Field from './components/FormField';
import Select from './components/Select';
import PageHeader from './components/PageHeader';
import Notice from './components/Notice';
import Disclosure from './components/Disclosure';
import DescriptionList from './components/DescriptionList';
import EmptyState from './components/EmptyState';
import Tabs from './components/Tabs';
import { Badge } from './components/ui/badge';
import { Card, CardDescription, CardTitle } from './components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';

const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'Project knowledge could not be loaded. Retry the project request.';
const validity = (item: MemoryItem) =>
  item.invalidated_at ? 'Invalidated' : item.active ? 'Approved' : 'Needs review';
const views = [
  'Repository map',
  'Knowledge map',
  'Records',
  'Review queue',
  'Recall log',
  'Sources',
  'Working memory',
  'History',
] as const;
const WEEK = 7 * 86_400_000;
type View = (typeof views)[number];

/** Secondary line under a table cell or list entry. */
function Detail({ children }: { children: ReactNode }) {
  return <small className="mt-1 block text-xs text-muted-foreground">{children}</small>;
}

/** An empty result whose title stays a level-2 heading for assistive technology. */
function EmptyPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <EmptyState as="h2" title={title}>
      {children}
    </EmptyState>
  );
}

export interface MemoryConsoleProps {
  api: Api;
  projects: Project[];
  work?: WorkOrder[];
  connected?: boolean;
  onError?: (message: string) => void;
}
export default function MemoryConsole({ api, projects, connected = true }: MemoryConsoleProps) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const effectiveProjectId = projects.some((project) => project.id === projectId)
    ? projectId
    : (projects[0]?.id ?? '');
  const [report, setReport] = useState<ProjectKnowledgeReport | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [ingestion, setIngestion] = useState<IngestionReport | null>(null);
  const [indexError, setIndexError] = useState('');
  const [sentContext, setSentContext] = useState<AuditView['context']>(null);
  const [contextError, setContextError] = useState('');
  const [contextLoading, setContextLoading] = useState(false);
  // The repository is there before any record is: the landing view never starts blank for an indexed project.
  const [tab, setTab] = useState<View>('Repository map');
  const [review, setReview] = useState<MemoryReview | null>(null);
  const [recalls, setRecalls] = useState<MemoryRecallPage | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadedAt, setLoadedAt] = useState(0);
  const [loading, setLoading] = useState(!!effectiveProjectId);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<MemoryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const generation = useRef(0);
  const reset = (projectId: string) => {
    setItems([]);
    setReport(null);
    setReview(null);
    setRecalls(null);
    setFocus(null);
    setIngestion(null);
    setIndexError('');
    setSelected(null);
    setError('');
    setNotice('');
    setLoading(!!projectId);
  };
  // A new project scope discards the previous project's records before the next render.
  const [scope, setScope] = useState({ api, projectId: effectiveProjectId });
  if (scope.api !== api || scope.projectId !== effectiveProjectId) {
    setScope({ api, projectId: effectiveProjectId });
    reset(effectiveProjectId);
  }
  const fetchKnowledge = useCallback(
    (current: () => boolean) =>
      Promise.all([
        api.knowledge(effectiveProjectId),
        api.memory(effectiveProjectId),
        api.ingestion(effectiveProjectId).catch((reason: unknown) => {
          if (current()) setIndexError(failure(reason));
          return null;
        }),
        // Review and recall data come from newer servers; their absence must not hide the rest.
        api.memoryReview(effectiveProjectId).catch(() => null),
        api.memoryRecalls(effectiveProjectId, { limit: 200 }).catch(() => null),
      ])
        .then(
          ([knowledge, memories, index, nextReview, nextRecalls]) => {
            if (!current()) return;
            setReport(knowledge);
            setItems(memories.filter((item) => item.project_id === effectiveProjectId));
            if (index?.project_id === effectiveProjectId) setIngestion(index);
            setReview(nextReview && Array.isArray(nextReview.pending) ? nextReview : null);
            setRecalls(nextRecalls && Array.isArray(nextRecalls.items) ? nextRecalls : null);
            setLoadedAt(Date.now());
          },
          (reason: unknown) => {
            if (current()) setError(failure(reason));
          },
        )
        .finally(() => {
          if (current()) setLoading(false);
        }),
    [api, effectiveProjectId],
  );
  useEffect(() => {
    if (!effectiveProjectId) return;
    let active = true;
    const requestId = ++generation.current;
    void fetchKnowledge(() => active && requestId === generation.current);
    return () => {
      active = false;
    };
  }, [fetchKnowledge, effectiveProjectId]);
  const refresh = () => {
    const requestId = ++generation.current;
    reset(effectiveProjectId);
    setRefreshKey((value) => value + 1);
    if (effectiveProjectId) void fetchKnowledge(() => requestId === generation.current);
  };
  /** After an owner decision or a finished read: keep the view, reload the records behind it. */
  const reload = useCallback(() => {
    setRefreshKey((key) => key + 1);
    const requestId = ++generation.current;
    if (effectiveProjectId) void fetchKnowledge(() => requestId === generation.current);
  }, [effectiveProjectId, fetchKnowledge]);
  const changed = (value: string) => {
    setNotice(value);
    reload();
  };
  const readRepository = () => {
    if (busy || !connected || !effectiveProjectId) return;
    setBusy(true);
    setIndexError('');
    void api
      .requestIngestion(effectiveProjectId, {
        version: 1,
        idempotency_key: `operator:${crypto.randomUUID()}`,
      })
      .then((job) =>
        setIngestion((current) => ({
          version: 1,
          project_id: effectiveProjectId,
          jobs: [job, ...(current?.jobs ?? [])],
          latest: current?.latest ?? null,
        })),
      )
      .catch((reason) => setIndexError(failure(reason)))
      .finally(() => setBusy(false));
  };
  const inspect = (memoryId: string) => {
    setFocus(memoryId);
    setTab('Knowledge map');
  };
  const pendingIndex = ingestion?.jobs.some((job) => job.state === 'queued' || job.state === 'running');
  useEffect(() => {
    if (!pendingIndex || !connected || !effectiveProjectId) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api
        .ingestion(effectiveProjectId)
        .then((value) => {
          if (active && value.project_id === effectiveProjectId) {
            setIngestion(value);
            setIndexError('');
            // A finished read may have proposed records: show them without a manual refresh.
            if (!value.jobs.some((job) => job.state === 'queued' || job.state === 'running')) reload();
          }
        })
        .catch((reason) => {
          if (active) setIndexError(failure(reason));
        });
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, pendingIndex, connected, effectiveProjectId, reload]);
  const action = async (item: MemoryItem, value: 'approve' | 'invalidate') => {
    if (busy || !connected || item.project_id !== effectiveProjectId) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.memoryAction(item.id, value);
      if (next.project_id === effectiveProjectId) {
        setItems((current) => current.map((memory) => (memory.id === next.id ? next : memory)));
        setSelected(next);
        setNotice(
          value === 'approve'
            ? 'Memory approved with its recorded provenance.'
            : 'Memory invalidated. It will no longer guide new context retrieval.',
        );
      }
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const context = report?.context;
  const contextWorkId = context?.work_id;
  // Leaving the Context view, or a different recorded run, discards the previous measurement.
  const [contextScope, setContextScope] = useState({ api, tab, workId: contextWorkId });
  if (contextScope.api !== api || contextScope.tab !== tab || contextScope.workId !== contextWorkId) {
    setContextScope({ api, tab, workId: contextWorkId });
    setSentContext(null);
    setContextError('');
    setContextLoading(tab === 'Working memory' && !!contextWorkId);
  }
  useEffect(() => {
    if (tab !== 'Working memory' || !contextWorkId) return;
    let active = true;
    void api
      .audit(contextWorkId)
      .then((value) => {
        if (active) setSentContext(value.context);
      })
      .catch((reason) => {
        if (active) setContextError(failure(reason));
      })
      .finally(() => {
        if (active) setContextLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, tab, contextWorkId]);
  const sourceIndex = ingestion?.latest;
  const sourceRecord = sourceIndex ?? context;
  // Commits a memory can be anchored to: the ones a completed read indexed, newest first.
  const indexedCommits: IndexedCommit[] = [];
  for (const job of ingestion?.jobs ?? [])
    if (
      job.state === 'completed' &&
      job.source_commit &&
      !indexedCommits.some((entry) => entry.commit === job.source_commit)
    )
      indexedCommits.push({ commit: job.source_commit, readAt: job.finished_at });
  if (sourceIndex && !indexedCommits.some((entry) => entry.commit === sourceIndex.source_commit))
    indexedCommits.push({ commit: sourceIndex.source_commit, readAt: sourceIndex.captured_at });
  const rows = items.filter((item) =>
    tab === 'History'
      ? !!item.invalidated_at
      : tab === 'Review queue'
        ? !item.active && !item.invalidated_at
        : item.active,
  );
  const approved = items.filter((item) => item.active);
  const pendingCount =
    review?.pending.length ?? items.filter((item) => !item.active && !item.invalidated_at).length;
  const overlapping = review?.pending.filter((entry) => entry.overlaps.length > 0).length ?? 0;
  const now = loadedAt;
  const recentRecalls =
    recalls?.items.filter(
      (recall) => recall.outcome === 'recalled' && now - new Date(recall.created_at).getTime() <= WEEK,
    ) ?? [];
  const sourceFiles = sourceRecord?.files.length ?? 0;
  const layers = [
    {
      id: 'working',
      name: 'Working',
      scope: 'per station',
      value: context ? `${context.files.length} files` : '—',
      description: 'Context window, archived reads and work notes of one station. Gone when it ends.',
      tone: 'var(--timeline-tool)',
    },
    {
      id: 'episodic',
      name: 'Episodic',
      scope: 'per run',
      value: report ? `${report.checkpoints.count} checkpoints` : '—',
      description: 'Events, checkpoints and delivery evidence: the record that facts cite.',
      tone: 'var(--info)',
    },
    {
      id: 'semantic',
      name: 'Semantic',
      scope: 'reviewed',
      value: `${approved.length} approved`,
      description: 'Facts and lessons you approved. Recalled into prompts as untrusted data.',
      tone: 'var(--primary)',
      highlight: true,
    },
    {
      id: 'procedural',
      name: 'Procedural',
      scope: 'factory',
      value: 'Pinned',
      description: 'Skills and policies pinned by digest on each agent definition.',
      tone: 'var(--success)',
    },
    {
      id: 'source',
      name: 'Source index',
      scope: 'per commit',
      value: `${sourceFiles} files`,
      description: 'Paths and digests per commit, so a fact can point at code that may change.',
      tone: 'var(--foreground)',
    },
  ];
  /** The plain listing, for History and for servers without the paged memory listing. */
  const classicTable = (view: View) =>
    rows.length ? (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Knowledge</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Provenance</TableHead>
            <TableHead>Validity</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((item) => (
            <TableRow key={item.id}>
              <TableCell className="min-w-56">
                {item.content}
                <Detail>{new Date(item.created_at).toLocaleString('en-US')}</Detail>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {item.kind === 'fact' ? 'Recorded fact' : 'Lesson'}
              </TableCell>
              <TableCell>
                <code className="font-mono text-xs">{item.source_commit.slice(0, 12)}</code>
                <Detail>
                  {item.source_work_id ? `Run ${item.source_work_id}` : 'Indexed commit, no run'}
                </Detail>
              </TableCell>
              <TableCell>
                <Badge variant={item.active ? 'success' : 'warning'}>{validity(item)}</Badge>
                {item.invalidated_as && <Detail>{endings[item.invalidated_as]}</Detail>}
              </TableCell>
              <TableCell>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelected(item)}
                  aria-label={`Inspect memory ${item.id}`}
                >
                  Inspect
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    ) : (
      <EmptyPanel
        title={
          view === 'History'
            ? 'No invalidated knowledge'
            : view === 'Review queue'
              ? 'No pending proposals'
              : 'No approved knowledge'
        }
      >
        {view === 'Records'
          ? 'Evidence and provenance remain attached to each memory. Proposals require review before they guide future runs.'
          : 'Only records in this project are shown.'}
      </EmptyPanel>
    );
  return (
    <div className="@container grid min-w-0 gap-6">
      <PageHeader
        icon={<Brain />}
        iconTone="memory"
        title="Memory"
        description="What the factory knows about each project, where every fact came from and when an agent recalled it. Nothing becomes memory without evidence or your approval."
        actions={
          <>
            <Button variant="secondary" disabled={loading || busy || !effectiveProjectId} onClick={refresh}>
              Refresh
            </Button>
            <Button
              variant="secondary"
              disabled={!connected || !effectiveProjectId}
              onClick={() => setCreating(true)}
            >
              Propose memory
            </Button>
          </>
        }
      />
      <Field label="Project" className="max-w-80">
        <Select
          value={effectiveProjectId}
          disabled={busy}
          onChange={(event) => {
            setProjectId(event.target.value);
            setCreating(false);
          }}
        >
          {!projects.length && <option value="">No registered projects</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
      </Field>
      {!connected && (
        <Notice tone="warning" role="status">
          Disconnected. Review the last loaded record; approval and proposal actions are unavailable.
        </Notice>
      )}
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="neutral" role="status">
          {notice}
        </Notice>
      )}
      {!projects.length ? (
        <EmptyPanel title="No project knowledge yet">
          Register a repository in Config to establish a project scope. Source context and reviewed memory
          appear here when recorded.
        </EmptyPanel>
      ) : (
        <>
          <MemoryStatus
            ingestion={ingestion}
            items={items}
            review={review}
            recalls={recalls}
            now={loadedAt}
            loading={loading}
            connected={connected}
            busy={busy}
            error={indexError}
            onRead={readRepository}
            onReview={() => setTab('Review queue')}
          />
          <StatGrid label="Knowledge summary">
            <StatTile
              label="Approved"
              value={loading ? '—' : approved.length}
              note={`${approved.filter((item) => item.kind === 'fact').length} facts · ${approved.filter((item) => item.kind === 'lesson').length} lessons`}
            />
            <StatTile
              label="Review queue"
              value={loading ? '—' : pendingCount}
              tone={pendingCount ? 'warning' : 'default'}
              note={overlapping ? `${overlapping} overlap an existing memory` : 'No overlaps detected'}
            />
            <StatTile
              label="Recalled · 7 days"
              value={recalls ? recentRecalls.length : '—'}
              note={
                recalls
                  ? `by ${new Set(recentRecalls.map((recall) => recall.role)).size} roles in ${new Set(recentRecalls.map((recall) => recall.work_id)).size} runs`
                  : 'Recall log unavailable'
              }
            />
            <StatTile
              label="Needs revalidation"
              value={review ? review.stale.length : '—'}
              tone={review?.stale.length ? 'warning' : 'default'}
              note={review?.stale.length ? 'Cited files changed since' : 'Every cited file unchanged'}
            />
            <StatTile
              label={sourceIndex ? 'Source index' : 'Recorded sources'}
              value={loading ? '—' : sourceFiles}
              note={
                sourceRecord?.source_commit
                  ? `files at ${sourceRecord.source_commit.slice(0, 8)}`
                  : 'Not recorded'
              }
            />
          </StatGrid>
          <MemoryLayers layers={layers} />
          <Tabs
            items={views.map((name) => ({ value: name, label: name }))}
            value={tab}
            onChange={setTab}
            label="Knowledge views"
            className="min-w-0 [&>[role=tabpanel]]:px-0 [&>[role=tabpanel]]:pb-0"
          >
            {(view) =>
              loading ? (
                view === 'Knowledge map' ? (
                  <SkeletonStatus
                    label="Loading this project’s knowledge and provenance…"
                    className="items-start gap-4 pt-1 @5xl:grid-cols-[minmax(0,1fr)_22rem]"
                  >
                    <KnowledgeMapSkeleton />
                    <InspectorSkeleton />
                  </SkeletonStatus>
                ) : (
                  <SkeletonStatus label="Loading this project’s knowledge and provenance…" className="pt-1">
                    <SkeletonTable rows={4} columns={['title', 'text', 'mono', 'badge', 'actions']} />
                  </SkeletonStatus>
                )
              ) : error ? null : (
                <div className="grid min-w-0 gap-4 pt-1">
                  {view === 'Repository map' && <CoverageMap index={ingestion?.latest} items={items} />}
                  {view === 'Knowledge map' && (
                    <div className="grid min-w-0 items-start gap-4 @5xl:grid-cols-[minmax(0,1fr)_22rem]">
                      <KnowledgeMap
                        api={api}
                        projectId={effectiveProjectId}
                        focus={focus}
                        refreshKey={refreshKey}
                        onFocus={setFocus}
                      />
                      {focus ? (
                        <MemoryInspector
                          key={focus}
                          api={api}
                          memoryId={focus}
                          connected={connected}
                          refreshKey={refreshKey}
                          onChanged={changed}
                          onFocus={setFocus}
                        />
                      ) : (
                        <aside className="grid content-start gap-2 rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                          <strong className="text-foreground">Select a memory</strong>
                          <p>
                            Its provenance, whether it still holds at the newest commit, who recalled it and
                            what it links to appear here.
                          </p>
                        </aside>
                      )}
                    </div>
                  )}
                  {view === 'Review queue' &&
                    (review ? (
                      <ReviewQueue
                        api={api}
                        review={review}
                        connected={connected}
                        onChanged={changed}
                        onInspect={inspect}
                      />
                    ) : (
                      <Notice tone="neutral" title="Overlap checks are not available from this server.">
                        <p>
                          Proposals are listed without comparison. Update SABRE to compare them with existing
                          memories.
                        </p>
                      </Notice>
                    ))}
                  {view === 'Recall log' && (
                    <RecallLog
                      api={api}
                      projectId={effectiveProjectId}
                      refreshKey={refreshKey}
                      onInspect={inspect}
                      semantic={!!report?.semantic_search}
                    />
                  )}
                  {view === 'Records' && (
                    <MemoryRecords
                      api={api}
                      projectId={effectiveProjectId}
                      connected={connected}
                      refreshKey={refreshKey}
                      onChanged={changed}
                      fallback={classicTable(view)}
                    />
                  )}
                  {(view === 'History' || (view === 'Review queue' && !review)) && classicTable(view)}
                  {view === 'Sources' && (
                    <Card aria-labelledby="memory-sources-title">
                      <div className="grid gap-1.5">
                        <CardTitle id="memory-sources-title">
                          {sourceIndex ? 'Indexed repository sources' : 'Recorded repository context'}
                        </CardTitle>
                        <CardDescription>
                          {sourceIndex
                            ? 'Bounded metadata from an admission-scanned repository snapshot. Raw source is not stored in this report.'
                            : 'This is the bounded source selection recorded by an agent. Currentness has not been checked.'}
                        </CardDescription>
                      </div>
                      {sourceRecord ? (
                        <>
                          <DescriptionList
                            items={[
                              [
                                'Source commit',
                                <code className="font-mono text-xs">{sourceRecord.source_commit}</code>,
                              ],
                              [
                                'Snapshot digest',
                                <code className="font-mono text-xs">{sourceRecord.snapshot_digest}</code>,
                              ],
                              [
                                'Selection',
                                `${sourceRecord.total_files} files observed · ${sourceRecord.files.length} retained · ${sourceRecord.omitted_files} omitted`,
                              ],
                              [
                                'Capture',
                                sourceRecord.captured_at
                                  ? new Date(sourceRecord.captured_at).toLocaleString('en-US')
                                  : 'Timestamp not recorded',
                              ],
                            ]}
                          />
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Source file</TableHead>
                                <TableHead>Recorded extent</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {sourceRecord.files.map((file) => (
                                <TableRow key={file.path}>
                                  <TableCell>
                                    <code className="font-mono text-xs">{file.path}</code>
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap">
                                    {file.lines === null
                                      ? 'Outside the indexing limit'
                                      : `${file.lines} lines`}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          {sourceIndex && (
                            <Disclosure
                              summary={`Changes from ${sourceIndex.previous_commit?.slice(0, 12) || 'initial capture'}`}
                            >
                              <p className="text-sm text-muted-foreground">
                                {sourceIndex.changes.added.length} added ·{' '}
                                {sourceIndex.changes.changed.length} changed ·{' '}
                                {sourceIndex.changes.deleted.length} deleted within the bounded index.
                              </p>
                              {(['added', 'changed', 'deleted'] as const).map(
                                (kind) =>
                                  sourceIndex.changes[kind].length > 0 && (
                                    <div key={kind} className="grid gap-1.5">
                                      <h3 className="text-sm font-medium capitalize">{kind}</h3>
                                      <ul className="grid list-disc gap-1 pl-5 text-sm">
                                        {sourceIndex.changes[kind].map((path) => (
                                          <li key={path} className="[overflow-wrap:anywhere]">
                                            <code className="font-mono text-xs">{path}</code>
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ),
                              )}
                            </Disclosure>
                          )}
                        </>
                      ) : (
                        <p className="text-sm">
                          No source context is recorded for this project in the available history.
                        </p>
                      )}
                    </Card>
                  )}
                  {view === 'Working memory' && (
                    <div className="grid min-w-0 items-start gap-4 @4xl:grid-cols-2">
                      <Card aria-labelledby="memory-context-title">
                        <CardTitle id="memory-context-title">Recorded specialist context</CardTitle>
                        {context ? (
                          <>
                            <p className="text-sm">
                              Source selection recorded for <strong>{context.role}</strong>, run{' '}
                              <code className="font-mono text-xs">{context.work_id}</code>.
                            </p>
                            <DescriptionList
                              items={[
                                ['Source files', `${context.files.length} references`],
                                ['Plan revision', context.plan_revision],
                                [
                                  'Commit',
                                  <code className="font-mono text-xs">{context.source_commit}</code>,
                                ],
                                ['Currentness', 'Unknown; repository not checked again'],
                              ]}
                            />
                          </>
                        ) : (
                          <p className="text-sm">No specialist context snapshot is available.</p>
                        )}
                      </Card>
                      <Card aria-labelledby="memory-proof-title">
                        <CardTitle id="memory-proof-title">What this record proves</CardTitle>
                        <p className="text-sm">
                          Source references were retained in a checkpoint. The run’s context receipts measure
                          sent bytes and compacted read references; they do not expose exact prompt excerpts
                          or task relevance scores.
                        </p>
                        {contextLoading && (
                          <p role="status" className="text-sm text-muted-foreground">
                            Loading recorded run context…
                          </p>
                        )}
                        {contextError && (
                          <Notice tone="danger" role="alert">
                            {contextError}
                          </Notice>
                        )}
                        {sentContext ? (
                          <>
                            <DescriptionList
                              items={[
                                [
                                  'Run coverage',
                                  `${sentContext.requests_with_context} measured requests · ${sentContext.requests_without_context} without measurements`,
                                ],
                                [
                                  'Before compaction',
                                  `${sentContext.original_bytes.toLocaleString('en-US')} bytes`,
                                ],
                                ['Sent context', `${sentContext.sent_bytes.toLocaleString('en-US')} bytes`],
                                ['Read references', `${sentContext.compacted_results} compacted results`],
                                [
                                  'Recovered pages',
                                  sentContext.restored_pages === null
                                    ? 'Not measured'
                                    : sentContext.restored_pages,
                                ],
                              ]}
                            />
                            {sentContext.references_truncated && (
                              <p className="text-xs text-muted-foreground">
                                Reference details are bounded; totals include all retained read references.
                              </p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              These are run-wide measurements before the CLI wrapper. Bytes do not imply
                              tokens, cost savings or improved model performance.
                            </p>
                          </>
                        ) : (
                          !contextLoading && (
                            <p className="text-sm text-muted-foreground">
                              No sent-context measurements are available for this recorded run.
                            </p>
                          )
                        )}
                        <p className="text-sm text-muted-foreground">
                          Memories are untrusted context. They cannot grant permissions or replace
                          instructions. A source change may require revalidation.
                        </p>
                      </Card>
                    </div>
                  )}
                </div>
              )
            }
          </Tabs>
          {!loading && !error && (
            <>
              {report?.truncated && (
                <Notice tone="warning">
                  The report is bounded to recent histories. Older source context may be outside this
                  selection.
                </Notice>
              )}
              <Disclosure summary="Storage, retrieval and validity">
                <p className="text-sm">
                  PostgreSQL retains memory and provenance. Source navigation uses project-scoped text search.{' '}
                  {report?.semantic_search
                    ? 'An optional semantic search provider is configured.'
                    : 'No optional semantic search provider is configured.'}{' '}
                  Approved does not mean current: compare source commits and review stale observations.
                </p>
                <p className="text-xs text-muted-foreground">
                  Context growth is not evidence of improved performance. Execution checkpoints and cached
                  state are separate from reviewed knowledge.
                </p>
              </Disclosure>
            </>
          )}
        </>
      )}
      <Dialog
        open={!!selected}
        title="Memory provenance"
        description="Review the source and evidence before changing its validity."
        onClose={() => setSelected(null)}
        busy={busy}
      >
        {selected && (
          <div className="grid gap-5">
            <p className="text-base leading-relaxed whitespace-pre-wrap">{selected.content}</p>
            <DescriptionList
              items={[
                ['State', validity(selected)],
                [
                  'Project',
                  projects.find((project) => project.id === selected.project_id)?.name ?? selected.project_id,
                ],
                ['Kind', selected.kind],
                [
                  'Source run',
                  selected.source_work_id ? (
                    <code className="font-mono text-xs">{selected.source_work_id}</code>
                  ) : (
                    'None: recorded against an indexed commit'
                  ),
                ],
                ['Source commit', <code className="font-mono text-xs">{selected.source_commit}</code>],
                [
                  'Evidence digest',
                  <code className="font-mono text-xs">{selected.evidence_digest || 'Not recorded'}</code>,
                ],
                ['Approved at', selected.approved_at || 'Not approved'],
                [
                  'Invalidated at',
                  selected.invalidated_at
                    ? `${selected.invalidated_at}${selected.invalidated_as ? ` · ${endings[selected.invalidated_as]}` : ''}`
                    : 'Not invalidated',
                ],
              ]}
            />
            {error && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            <DialogActions>
              {!selected.invalidated_at && (
                <Button
                  variant="secondary"
                  disabled={busy || !connected}
                  onClick={() => void action(selected, 'invalidate')}
                >
                  Invalidate memory
                </Button>
              )}
              {!selected.active && !selected.invalidated_at && (
                <Button
                  variant="primary"
                  disabled={busy || !connected}
                  onClick={() => void action(selected, 'approve')}
                >
                  Approve memory
                </Button>
              )}
            </DialogActions>
          </div>
        )}
      </Dialog>
      <ProposeMemoryDialog
        api={api}
        projectId={effectiveProjectId}
        commits={indexedCommits}
        open={creating}
        connected={connected}
        onClose={() => setCreating(false)}
        onProposed={(value) => {
          setCreating(false);
          if (value.project_id === effectiveProjectId)
            changed('Proposal recorded. It waits in the review queue.');
        }}
      />
    </div>
  );
}

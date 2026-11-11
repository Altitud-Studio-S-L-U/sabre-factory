import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type Api,
  type MemoryItem,
  type Project,
  type ProjectKnowledgeReport,
  type WorkOrder,
  type IngestionReport,
  type AuditView,
} from './api';
import Dialog from './components/Dialog';
import Field from './components/FormField';
import Select from './components/Select';
import './ConsoleSections.css';

const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'Project knowledge could not be loaded. Retry the project request.';
const validity = (item: MemoryItem) =>
  item.invalidated_at ? 'Invalidated' : item.active ? 'Approved' : 'Needs review';
export interface MemoryConsoleProps {
  api: Api;
  projects: Project[];
  work?: WorkOrder[];
  connected?: boolean;
  onError?: (message: string) => void;
}
export default function MemoryConsole({ api, projects, connected = true }: MemoryConsoleProps) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [report, setReport] = useState<ProjectKnowledgeReport | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [ingestion, setIngestion] = useState<IngestionReport | null>(null);
  const [indexError, setIndexError] = useState('');
  const [sentContext, setSentContext] = useState<AuditView['context']>(null);
  const [contextError, setContextError] = useState('');
  const [contextLoading, setContextLoading] = useState(false);
  const [tab, setTab] = useState('Facts');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<MemoryItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    kind: 'lesson' as 'fact' | 'lesson',
    content: '',
    source_commit: '',
    source_work_id: '',
    evidence_digest: '',
  });
  const generation = useRef(0);
  const effectiveProjectId = projects.some((project) => project.id === projectId)
    ? projectId
    : (projects[0]?.id ?? '');
  const load = useCallback(async () => {
    const requestId = ++generation.current;
    setItems([]);
    setReport(null);
    setIngestion(null);
    setIndexError('');
    setSelected(null);
    setError('');
    setNotice('');
    if (!effectiveProjectId) return;
    setLoading(true);
    try {
      const [knowledge, memories, index] = await Promise.all([
        api.knowledge(effectiveProjectId),
        api.memory(effectiveProjectId),
        api.ingestion(effectiveProjectId).catch((reason: unknown) => {
          if (requestId === generation.current) setIndexError(failure(reason));
          return null;
        }),
      ]);
      if (requestId === generation.current) {
        setReport(knowledge);
        setItems(memories.filter((item) => item.project_id === effectiveProjectId));
        if (index?.project_id === effectiveProjectId) setIngestion(index);
      }
    } catch (reason) {
      if (requestId === generation.current) setError(failure(reason));
    } finally {
      if (requestId === generation.current) setLoading(false);
    }
  }, [api, effectiveProjectId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
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
  }, [api, pendingIndex, connected, effectiveProjectId]);
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
  useEffect(() => {
    let active = true;
    setSentContext(null);
    setContextError('');
    setContextLoading(false);
    if (tab !== 'Context' || !context?.work_id) return;
    setContextLoading(true);
    void api
      .audit(context.work_id)
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
  }, [api, tab, context?.work_id]);
  const sourceIndex = ingestion?.latest;
  const latestJob = ingestion?.jobs[0];
  const sourceRecord = sourceIndex ?? context;
  const rows = items.filter((item) =>
    tab === 'Proposals'
      ? !item.active && !item.invalidated_at
      : tab === 'History'
        ? !!item.invalidated_at
        : item.active,
  );
  return (
    <div className="operator-page">
      <header className="operator-heading">
        <div>
          <span className="operator-eyebrow">Project knowledge</span>
          <h1>Memory</h1>
          <p>
            Inspect sources, reviewed knowledge and the context recorded for a specialist. Every item keeps
            its project and source provenance.
          </p>
        </div>
        <div className="operator-actions">
          <button
            className="button"
            disabled={loading || busy || !effectiveProjectId}
            onClick={() => void load()}
          >
            Refresh
          </button>
          <button
            className="button primary"
            disabled={!connected || !effectiveProjectId}
            onClick={() => {
              setDraft({
                kind: 'lesson',
                content: '',
                source_commit: context?.source_commit ?? '',
                source_work_id: context?.work_id ?? '',
                evidence_digest: '',
              });
              setCreating(true);
            }}
          >
            Propose memory
          </button>
        </div>
      </header>
      <div className="operator-filter">
        <Field label="Project">
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
      </div>
      {!connected && (
        <p className="notice warning" role="status">
          Disconnected. Review the last loaded record; approval and proposal actions are unavailable.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice neutral" role="status">
          {notice}
        </p>
      )}
      {!projects.length ? (
        <div className="operator-empty">
          <h2>No project knowledge yet</h2>
          <p>
            Register a repository in Config to establish a project scope. Source context and reviewed memory
            appear here when recorded.
          </p>
        </div>
      ) : (
        <>
          <section className="operator-panel">
            <div className="operator-heading">
              <div>
                <h2>Repository index</h2>
                <p>
                  {latestJob
                    ? latestJob.state === 'completed'
                      ? 'Source metadata captured. A new source commit requires a fresh reconciliation.'
                      : latestJob.state === 'failed'
                        ? 'Indexing stopped. Review the diagnostic and retry after correcting the cause.'
                        : `Indexing ${latestJob.state}. Source admission scanning runs before any metadata is retained.`
                    : 'No repository ingestion has been recorded.'}
                </p>
              </div>
              <button
                className="button"
                disabled={!connected || busy || !!pendingIndex}
                onClick={() => {
                  if (busy || !connected) return;
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
                }}
              >
                {pendingIndex ? 'Indexing queued' : sourceIndex ? 'Reconcile repository' : 'Index repository'}
              </button>
            </div>
            {latestJob?.error_code && (
              <p className="notice warning" role="status">
                <code>{latestJob.error_code}</code> · {latestJob.error_message}
              </p>
            )}
            {indexError && (
              <p className="notice error" role="alert">
                {indexError}
              </p>
            )}
            {sourceIndex && (
              <p className="operator-readonly">
                Index v{sourceIndex.index_version} · {sourceIndex.files.length} retained file references ·{' '}
                {sourceIndex.omitted_files} omitted · captured{' '}
                {new Date(sourceIndex.captured_at).toLocaleString('en-US')}. Current at capture; repository
                may have changed.
              </p>
            )}
          </section>
          <div className="operator-metrics">
            <div>
              <span>{sourceIndex ? 'Indexed source files' : 'Recorded source files'}</span>
              <strong>{loading ? '—' : (sourceRecord?.files.length ?? 0)}</strong>
            </div>
            <div>
              <span>Approved knowledge</span>
              <strong>{loading ? '—' : items.filter((item) => item.active).length}</strong>
            </div>
            <div>
              <span>Pending proposals</span>
              <strong>
                {loading ? '—' : items.filter((item) => !item.active && !item.invalidated_at).length}
              </strong>
            </div>
            <div>
              <span>Source commit</span>
              <strong style={{ fontSize: 14 }}>
                <code>{sourceRecord?.source_commit.slice(0, 12) || 'Not recorded'}</code>
              </strong>
            </div>
          </div>
          <div className="operator-tabs" aria-label="Knowledge views">
            {['Facts', 'Sources', 'Proposals', 'Relations', 'Context', 'History'].map((name) => (
              <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>
                {name}
              </button>
            ))}
          </div>
          {loading && (
            <div className="operator-panel" role="status">
              Loading this project’s knowledge and provenance…
            </div>
          )}
          {!loading && !error && (
            <>
              {['Facts', 'Proposals', 'History'].includes(tab) && (
                <>
                  {rows.length ? (
                    <div className="operator-table-wrap">
                      <table className="operator-table">
                        <thead>
                          <tr>
                            <th>Knowledge</th>
                            <th>Type</th>
                            <th>Provenance</th>
                            <th>Validity</th>
                            <th>Details</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((item) => (
                            <tr key={item.id}>
                              <td>
                                {item.content}
                                <small>{new Date(item.created_at).toLocaleString('en-US')}</small>
                              </td>
                              <td>{item.kind === 'fact' ? 'Recorded fact' : 'Lesson'}</td>
                              <td>
                                <code>{item.source_commit.slice(0, 12)}</code>
                                <small>Run {item.source_work_id}</small>
                              </td>
                              <td>
                                <span className={`operator-tag ${item.active ? 'good' : 'warning'}`}>
                                  {validity(item)}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="button small"
                                  onClick={() => setSelected(item)}
                                  aria-label={`Inspect memory ${item.id}`}
                                >
                                  Inspect
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="operator-empty">
                      <h2>
                        {tab === 'Proposals'
                          ? 'No pending proposals'
                          : tab === 'History'
                            ? 'No invalidated knowledge'
                            : 'No approved knowledge'}
                      </h2>
                      <p>
                        {tab === 'Facts'
                          ? 'Evidence and provenance remain attached to each memory. Proposals require review before they guide future runs.'
                          : 'Only records in this project are shown.'}
                      </p>
                    </div>
                  )}
                </>
              )}
              {tab === 'Sources' && (
                <section className="operator-panel">
                  <h2>{sourceIndex ? 'Indexed repository sources' : 'Recorded repository context'}</h2>
                  <p className="muted">
                    {sourceIndex
                      ? 'Bounded metadata from an admission-scanned repository snapshot. Raw source is not stored in this report.'
                      : 'This is the bounded source selection recorded by an agent. Currentness has not been checked.'}
                  </p>
                  {sourceRecord ? (
                    <>
                      <dl className="operator-kv">
                        <dt>Source commit</dt>
                        <dd>
                          <code>{sourceRecord.source_commit}</code>
                        </dd>
                        <dt>Snapshot digest</dt>
                        <dd>
                          <code>{sourceRecord.snapshot_digest}</code>
                        </dd>
                        <dt>Selection</dt>
                        <dd>
                          {sourceRecord.total_files} files observed · {sourceRecord.files.length} retained ·{' '}
                          {sourceRecord.omitted_files} omitted
                        </dd>
                        <dt>Capture</dt>
                        <dd>
                          {sourceRecord.captured_at
                            ? new Date(sourceRecord.captured_at).toLocaleString('en-US')
                            : 'Timestamp not recorded'}
                        </dd>
                      </dl>
                      <div className="operator-table-wrap">
                        <table className="operator-table">
                          <thead>
                            <tr>
                              <th>Source file</th>
                              <th>Recorded extent</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sourceRecord.files.map((file) => (
                              <tr key={file.path}>
                                <td>
                                  <code>{file.path}</code>
                                </td>
                                <td>
                                  {file.lines === null ? 'Outside the indexing limit' : `${file.lines} lines`}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {sourceIndex && (
                        <details className="operator-section-divider">
                          <summary>
                            Changes from {sourceIndex.previous_commit?.slice(0, 12) || 'initial capture'}
                          </summary>
                          <p>
                            {sourceIndex.changes.added.length} added · {sourceIndex.changes.changed.length}{' '}
                            changed · {sourceIndex.changes.deleted.length} deleted within the bounded index.
                          </p>
                          {(['added', 'changed', 'deleted'] as const).map(
                            (kind) =>
                              sourceIndex.changes[kind].length > 0 && (
                                <div key={kind}>
                                  <h3>{kind}</h3>
                                  <ul>
                                    {sourceIndex.changes[kind].map((path) => (
                                      <li key={path}>
                                        <code>{path}</code>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ),
                          )}
                        </details>
                      )}
                    </>
                  ) : (
                    <p>No source context is recorded for this project in the available history.</p>
                  )}
                </section>
              )}
              {tab === 'Relations' && (
                <section className="operator-panel">
                  <h2>Provenance relationships</h2>
                  <p className="muted">Links below come from stored source and run references.</p>
                  {items.length ? (
                    <ul className="operator-checks">
                      {items.map((item) => (
                        <li key={item.id}>
                          <div>
                            <button className="text-button" onClick={() => setSelected(item)}>
                              Memory {item.id}
                            </button>
                            <small>
                              {item.kind} · {validity(item)}
                            </small>
                          </div>
                          <div>
                            Run <code>{item.source_work_id}</code>
                            <small>
                              Commit <code>{item.source_commit.slice(0, 12)}</code>
                              {item.evidence_digest
                                ? ' · evidence digest retained'
                                : ' · no evidence digest recorded'}
                            </small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No memory provenance relationships recorded.</p>
                  )}
                </section>
              )}
              {tab === 'Context' && (
                <div className="operator-two">
                  <section className="operator-panel">
                    <h2>Recorded specialist context</h2>
                    {context ? (
                      <>
                        <p>
                          Source selection recorded for <strong>{context.role}</strong>, run{' '}
                          <code>{context.work_id}</code>.
                        </p>
                        <dl className="operator-kv">
                          <dt>Source files</dt>
                          <dd>{context.files.length} references</dd>
                          <dt>Plan revision</dt>
                          <dd>{context.plan_revision}</dd>
                          <dt>Commit</dt>
                          <dd>
                            <code>{context.source_commit}</code>
                          </dd>
                          <dt>Currentness</dt>
                          <dd>Unknown; repository not checked again</dd>
                        </dl>
                      </>
                    ) : (
                      <p>No specialist context snapshot is available.</p>
                    )}
                  </section>
                  <section className="operator-panel">
                    <h2>What this record proves</h2>
                    <p>
                      Source references were retained in a checkpoint. The run’s context receipts measure sent
                      bytes and compacted read references; they do not expose exact prompt excerpts or task
                      relevance scores.
                    </p>
                    {contextLoading && <p role="status">Loading recorded run context…</p>}
                    {contextError && (
                      <p className="notice error" role="alert">
                        {contextError}
                      </p>
                    )}
                    {sentContext ? (
                      <>
                        <dl className="operator-kv">
                          <dt>Run coverage</dt>
                          <dd>
                            {sentContext.requests_with_context} measured requests ·{' '}
                            {sentContext.requests_without_context} without measurements
                          </dd>
                          <dt>Before compaction</dt>
                          <dd>{sentContext.original_bytes.toLocaleString('en-US')} bytes</dd>
                          <dt>Sent context</dt>
                          <dd>{sentContext.sent_bytes.toLocaleString('en-US')} bytes</dd>
                          <dt>Read references</dt>
                          <dd>{sentContext.compacted_results} compacted results</dd>
                          <dt>Recovered pages</dt>
                          <dd>
                            {sentContext.restored_pages === null
                              ? 'Not measured'
                              : sentContext.restored_pages}
                          </dd>
                        </dl>
                        {sentContext.references_truncated && (
                          <p className="operator-readonly">
                            Reference details are bounded; totals include all retained read references.
                          </p>
                        )}
                        <p className="operator-readonly">
                          These are run-wide measurements before the CLI wrapper. Bytes do not imply tokens,
                          cost savings or improved model performance.
                        </p>
                      </>
                    ) : (
                      !contextLoading && (
                        <p className="muted">
                          No sent-context measurements are available for this recorded run.
                        </p>
                      )
                    )}
                    <p className="muted">
                      Memories are untrusted context. They cannot grant permissions or replace instructions. A
                      source change may require revalidation.
                    </p>
                  </section>
                </div>
              )}
              {report?.truncated && (
                <p className="notice warning">
                  The report is bounded to recent histories. Older source context may be outside this
                  selection.
                </p>
              )}
              <details className="operator-panel">
                <summary>Storage, retrieval and validity</summary>
                <p>
                  PostgreSQL retains memory and provenance. Source navigation uses project-scoped text search.{' '}
                  {report?.semantic_search
                    ? 'An optional semantic search provider is configured.'
                    : 'No optional semantic search provider is configured.'}{' '}
                  Approved does not mean current: compare source commits and review stale observations.
                </p>
                <p className="operator-readonly">
                  Context growth is not evidence of improved performance. Execution checkpoints and cached
                  state are separate from reviewed knowledge.
                </p>
              </details>
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
          <>
            <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{selected.content}</p>
            <dl className="operator-kv">
              <dt>State</dt>
              <dd>{validity(selected)}</dd>
              <dt>Project</dt>
              <dd>
                {projects.find((project) => project.id === selected.project_id)?.name ?? selected.project_id}
              </dd>
              <dt>Kind</dt>
              <dd>{selected.kind}</dd>
              <dt>Source run</dt>
              <dd>
                <code>{selected.source_work_id}</code>
              </dd>
              <dt>Source commit</dt>
              <dd>
                <code>{selected.source_commit}</code>
              </dd>
              <dt>Evidence digest</dt>
              <dd>
                <code>{selected.evidence_digest || 'Not recorded'}</code>
              </dd>
              <dt>Approved at</dt>
              <dd>{selected.approved_at || 'Not approved'}</dd>
              <dt>Invalidated at</dt>
              <dd>{selected.invalidated_at || 'Not invalidated'}</dd>
            </dl>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <div className="operator-actions">
              {!selected.active && !selected.invalidated_at && (
                <button
                  className="button primary"
                  disabled={busy || !connected}
                  onClick={() => void action(selected, 'approve')}
                >
                  Approve memory
                </button>
              )}
              {!selected.invalidated_at && (
                <button
                  className="button"
                  disabled={busy || !connected}
                  onClick={() => void action(selected, 'invalidate')}
                >
                  Invalidate memory
                </button>
              )}
            </div>
          </>
        )}
      </Dialog>
      <Dialog
        open={creating}
        title="Propose project memory"
        description="Retain a fact or lesson with explicit source provenance. Review is a separate action."
        onClose={() => setCreating(false)}
        busy={busy}
        dirty={!!draft.content}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !connected) return;
            setBusy(true);
            setError('');
            void api
              .createMemory({
                project_id: effectiveProjectId,
                ...draft,
                evidence_digest: draft.evidence_digest || null,
              })
              .then((value) => {
                if (value.project_id === effectiveProjectId) setItems((current) => [...current, value]);
                setCreating(false);
                setNotice('Memory proposal recorded. Review its validity before use.');
              })
              .catch((reason) => setError(failure(reason)))
              .finally(() => setBusy(false));
          }}
        >
          <Field label="Type">
            <Select
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value as 'fact' | 'lesson' })}
            >
              <option value="lesson">Lesson</option>
              <option value="fact">Fact</option>
            </Select>
          </Field>
          <Field label="Content">
            <textarea
              required
              rows={5}
              maxLength={8000}
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            />
          </Field>
          <Field label="Source commit">
            <input
              required
              value={draft.source_commit}
              maxLength={128}
              onChange={(event) => setDraft({ ...draft, source_commit: event.target.value })}
            />
          </Field>
          <Field label="Source run">
            <input
              required
              value={draft.source_work_id}
              maxLength={128}
              onChange={(event) => setDraft({ ...draft, source_work_id: event.target.value })}
            />
          </Field>
          <Field
            label="Evidence digest"
            hint="Use the recorded digest if available; do not paste secrets or evidence payloads."
          >
            <input
              value={draft.evidence_digest}
              maxLength={128}
              onChange={(event) => setDraft({ ...draft, evidence_digest: event.target.value })}
            />
          </Field>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy || !connected}>
            {busy ? 'Saving…' : 'Save proposal'}
          </button>
        </form>
      </Dialog>
    </div>
  );
}

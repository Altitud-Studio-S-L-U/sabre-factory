import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  matchPath,
  useLocation,
  useNavigate,
} from 'react-router';
import {
  ApiError,
  createApi,
  openPanelSession,
  type Api,
  type PanelSession,
  type HumanQuestion,
  type MemoryItem,
  type Project,
  type SecurityFinding,
  type SecurityException,
  type WorkOrder,
  type AuditView,
  type ProjectKnowledgeReport,
} from './api';
import About from './About';
import Integrations from './Integrations';
import WorkAudit from './WorkAudit';
import ExecutionTimeline from './ExecutionTimeline';
import FlowConfiguration from './FlowConfiguration';
import type { FlowConfiguration as FlowConfig } from './api';
import ProjectKnowledge from './ProjectKnowledge';
import WorkBoard from './WorkBoard';
import FactoryOverview from './FactoryOverview';
import Icon, { type IconName } from './Icon';
import Field from './components/FormField';
import Select from './components/Select';

type View = 'work' | 'projects' | 'security' | 'memory' | 'settings' | 'system';
const navigation: { id: View; path: string; label: string; icon: IconName }[] = [
  { id: 'work', path: '/work', label: 'Runs', icon: 'work' },
  { id: 'projects', path: '/projects', label: 'Projects', icon: 'projects' },
  { id: 'security', path: '/security', label: 'Security', icon: 'security' },
  { id: 'memory', path: '/memory', label: 'Memory', icon: 'memory' },
  { id: 'settings', path: '/integrations', label: 'Integrations', icon: 'settings' },
  { id: 'system', path: '/about', label: 'About', icon: 'info' },
];
function usesOnlyCliModels(status: Record<string, unknown>): boolean {
  const model = status.model as { provider?: unknown } | undefined;
  const roles = status.roles as Record<string, { provider?: unknown }> | undefined;
  const cli = (provider: unknown) => provider === 'codex_cli' || provider === 'claude_cli';
  return (
    cli(model?.provider) &&
    ['supervisor', 'analyst', 'architect', 'developer', 'qa', 'reviewer', 'security'].every((role) =>
      cli(roles?.[role]?.provider),
    )
  );
}

function CliProgressPolicy() {
  return (
    <>
      <p>
        Per-agent controls: 50 steps or 10 minutes per agent, 2 repair cycles. No cumulative invocation, token
        or active-time quotas.
      </p>
      <p>
        Authorized API spend: USD 0. Scanners, permission boundaries and the 120-second CLI invocation limit
        remain active. Subscriptions retain their own limits.
      </p>
    </>
  );
}
const statusLabels: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_input: 'Needs your answer',
  paused: 'Paused',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
  completed: 'Completed',
  high: 'High',
  critical: 'Critical',
  medium: 'Medium',
  low: 'Low',
  info: 'Information',
};
const phaseLabels: Record<string, string> = {
  clarification: 'Aclaraciones',
  task_clarification: 'Task clarification',
  scope_check: 'Scope check',
  scope_approval: 'Scope decision',
  qa_clarification: 'Verification clarification',
  review_clarification: 'Review clarification',
  plan_clarification: 'Plan clarification',
  design_clarification: 'Design clarification',
  architecture_approval: 'Architecture decision',
  decision: 'Evaluation',
  prepare_delivery: 'Delivery preparation',
  ready: 'Ready to deliver',
  repair: 'Repair',
  security_watch: 'Security monitoring',
  intake: 'Input',
  analysis: 'Analysis',
  analyze: 'Analysis',
  planning: 'Planning',
  plan: 'Planning',
  design: 'Design',
  architecture: 'Arquitectura',
  implement: 'Development',
  implementation: 'Development',
  verify: 'Verification',
  verification: 'Verification',
  review: 'Review',
  security: 'Security',
  delivery: 'Entrega',
  deliver: 'Entrega',
  complete: 'Completed',
  completed: 'Completed',
};
const modeLabels: Record<string, string> = {
  create: 'Create',
  maintain: 'Maintain',
  patch: 'Patch',
  audit: 'Audit',
};
const emptyPlanMessages: Record<WorkOrder['status'], string> = {
  queued: 'The run is waiting for its turn.',
  running: 'The run is in progress. Tasks appear when they are recorded.',
  waiting_input: 'The run needs an answer before continuing.',
  paused: 'The run is paused.',
  blocked: 'The run is blocked. Review the reason before resuming.',
  failed: 'Execution failed. Review the error before resuming.',
  cancelled: 'The run is cancelled.',
  completed: 'The run finished with no recorded tasks.',
};
const roleLabels: Record<string, string> = {
  analyst: 'Analyst',
  architect: 'Architect',
  developer: 'Developer',
  qa: 'Verification',
  reviewer: 'Reviewer',
};
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const integer = new Intl.NumberFormat('en-US');
function time(value: string) {
  return new Date(value).toLocaleString('en-US', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function lines(value: FormDataEntryValue | null) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
function message(error: unknown) {
  return error instanceof Error ? error.message : 'The operation could not be completed.';
}
function externalUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function Badge({ value }: { value: string }) {
  return (
    <span className={`badge badge-${value}`}>
      <span className="status-dot" aria-hidden="true" />
      {statusLabels[value] || value}
    </span>
  );
}
function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div className="notice error" role="alert">
      {children}
    </div>
  );
}
function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-mark" aria-hidden="true">
        <Icon name="empty" size={23} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function pendingQuestions(order: WorkOrder) {
  return order.questions.filter(
    (question) => question.answer === null && question.plan_revision === order.plan_revision,
  );
}

export default function App() {
  const [session, setSession] = useState<PanelSession | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [authError, setAuthError] = useState('');
  const connection = useRef<Promise<PanelSession | null> | null>(null);
  const activeSession = useRef<PanelSession | null>(null);
  useEffect(() => {
    let current = true;
    const observe = (pending: Promise<PanelSession | null>) => {
      void pending
        .then((next) => {
          if (current && connection.current === pending) {
            activeSession.current = next;
            setSession(next);
          }
        })
        .catch((error) => {
          if (current && connection.current === pending) setAuthError(message(error));
        })
        .finally(() => {
          if (current && connection.current === pending) setConnecting(false);
        });
    };
    const accessLink = () => {
      if (!new URLSearchParams(window.location.hash.slice(1)).has('ticket')) return;
      // Reuse the same parser/exchange, which removes the fragment before its first await.
      connection.current = openPanelSession();
      activeSession.current = null;
      setSession(null);
      setAuthError('');
      setConnecting(true);
      observe(connection.current);
    };
    window.addEventListener('hashchange', accessLink);
    // StrictMode repeats effects; a one-use ticket must have only one exchange.
    connection.current ??= openPanelSession();
    observe(connection.current);
    return () => {
      current = false;
      window.removeEventListener('hashchange', accessLink);
    };
  }, []);
  const disconnect = useCallback(
    (error = '') => {
      // A response from an old tab session must not disconnect a newly exchanged one.
      if (!session || activeSession.current !== session) return;
      connection.current = null;
      activeSession.current = null;
      setSession(null);
      setAuthError(error);
    },
    [session],
  );
  if (!session) return <Login error={authError} connecting={connecting} />;
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="*" element={<Session session={session} onLogout={disconnect} />} />
      </Routes>
    </BrowserRouter>
  );
}

function RootRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/work', search, hash }} replace />;
}

function Login({ error, connecting }: { error: string; connecting: boolean }) {
  return (
    <div className="login-shell">
      <section className="login-intro">
        <Brand />
        <div>
          <span className="eyebrow">Your software factory</span>
          <h1>
            Work is progressing.
            <br />
            You retain control.
          </h1>
          <p>
            Runs, decisions and evidence in one place. Connect to SABRE to see its progress and pending
            decisions.
          </p>
        </div>
        <div className="login-flow" aria-label="Workflow">
          <span>Run</span>
          <span aria-hidden="true">→</span>
          <span>Team</span>
          <span aria-hidden="true">→</span>
          <span>Verification</span>
          <span aria-hidden="true">→</span>
          <span>Reviewable PR</span>
        </div>
      </section>
      <main className="login-form">
        <div className="login-form-inner">
          <span className="eyebrow">Control room</span>
          <h2>{connecting ? 'Opening the control room' : 'Open SABRE from the CLI'}</h2>
          {connecting ? (
            <p role="status">Checking the local session…</p>
          ) : (
            <>
              <p>
                Run this command from the SABRE directory. On Windows, open the temporary link shown in your
                terminal; on Linux and macOS, the browser opens automatically.
              </p>
              <pre>
                <code>node bin/sabre.mjs open</code>
              </pre>
              <p>The link can be used once. If it expires, run the command again.</p>
            </>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <div className="privacy-note">
            <span aria-hidden="true">●</span>
            <p>Access is authorized on your device. After signing out, reopen the panel from the CLI.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        SABRE<small>Software factory</small>
      </span>
    </div>
  );
}

function Session({ session, onLogout }: { session: PanelSession; onLogout: (error?: string) => void }) {
  const api = useMemo(() => createApi(session.csrf_token, onLogout), [session.csrf_token, onLogout]);
  const location = useLocation();
  const navigate = useNavigate();
  const workMatch = matchPath('/work/:workId', location.pathname);
  const selectedId = workMatch?.params.workId ?? null;
  const view = workMatch ? 'work' : navigation.find((item) => matchPath(item.path, location.pathname))?.id;
  const routeState = location.state as { form?: 'work' | 'project'; projectId?: string } | null;
  const [formState, setFormState] = useState<{ key: string; value: 'work' | 'project' | null } | null>(null);
  const form = formState?.key === location.key ? formState.value : (routeState?.form ?? null);
  const setForm = (value: 'work' | 'project' | null) => setFormState({ key: location.key, value });
  const newWorkProjectId = routeState?.projectId ?? '';
  const [detail, setDetail] = useState<{ id: string; order?: WorkOrder; error?: string } | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [status, setStatus] = useState<Record<string, unknown>>({});
  const cliMode = usesOnlyCliModels(status);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const mainContent = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const selected =
    orders.find((order) => order.id === selectedId) ?? (detail?.id === selectedId ? detail.order : undefined);
  const detailError = detail?.id === selectedId ? detail.error : undefined;
  const detailReady = Boolean(selected || detailError);

  useEffect(() => {
    if (loading) return;
    if (!form && returnFocus.current?.isConnected) {
      returnFocus.current.focus({ preventScroll: true });
      returnFocus.current = null;
      return;
    }
    const heading = mainContent.current?.querySelector<HTMLElement>(form ? '.form-panel h2' : 'h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [view, selectedId, form, loading, detailReady]);

  const logout = async () => {
    setLoggingOut(true);
    setLogoutError('');
    try {
      await api.logout();
      onLogout();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401))
        setLogoutError('Sign-out could not be confirmed. The session remains open; retry when connected.');
    } finally {
      setLoggingOut(false);
    }
  };

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextProjects, nextOrders, nextStatus] = await Promise.all([
        api.projects(),
        api.work(),
        api.status(),
      ]);
      setProjects(nextProjects);
      setOrders(nextOrders);
      setStatus(nextStatus);
      setError('');
      setUpdated(new Date());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout(err.message);
      else setError(message(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, onLogout]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [reload]);

  useEffect(() => {
    if (!selectedId || loading || orders.some((order) => order.id === selectedId)) return;
    let current = true;
    void api
      .getWork(selectedId)
      .then((order) => {
        if (current) setDetail({ id: selectedId, order });
      })
      .catch((error) => {
        if (current)
          setDetail({
            id: selectedId,
            error:
              error instanceof ApiError && error.status === 404
                ? 'This run does not exist or is no longer available.'
                : message(error),
          });
      });
    return () => {
      current = false;
    };
  }, [api, selectedId, loading, orders, updated]);

  const pending = orders.flatMap((order) => pendingQuestions(order).map((question) => ({ order, question })));
  const blockedOrders = orders.filter(
    (order) => ['blocked', 'failed'].includes(order.status) && !pendingQuestions(order).length,
  );
  const changeView = (next: View) => {
    returnFocus.current = null;
    setForm(null);
    void navigate(navigation.find((item) => item.id === next)!.path);
  };
  const openWork = (order: WorkOrder) => {
    returnFocus.current = null;
    setForm(null);
    void navigate(`/work/${encodeURIComponent(order.id)}`);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">
          <span className="workspace-dot" />
          Personal workspace
        </div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              key={item.id}
              to={item.path}
              className={view === item.id ? 'nav-item active' : 'nav-item'}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => {
                returnFocus.current = null;
              }}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.id === 'work' && pending.length > 0 && (
                <span className="nav-count">
                  {pending.length}
                  <span className="sr-only"> pending questions</span>
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div>
            <span className="status-dot" />
            {error ? 'Connection interrupted' : loading ? 'Conectando' : 'Factory connected'}
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            SABRE <span aria-hidden="true">/</span>
            <strong>{navigation.find((item) => item.id === view)?.label || 'Page not found'}</strong>
          </div>
          <div className="topbar-right">
            <span className="last-update">
              {updated
                ? `Updated ${updated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
                : 'Sincronizando'}
            </span>
            <button
              className="icon-button"
              aria-label="Refresh data"
              title="Refresh data"
              disabled={refreshing}
              onClick={() => void reload()}
            >
              <Icon name="refresh" size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              <Icon name="logout" size={17} />
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content" ref={mainContent} tabIndex={-1}>
          {logoutError && <ErrorNotice>{logoutError}</ErrorNotice>}
          {error && (
            <div className="notice error" role="alert">
              <div>
                <strong>Data could not be refreshed.</strong>
                <p>{error} Visible data may be outdated.</p>
              </div>
              <button className="button small" onClick={() => void reload()} disabled={refreshing}>
                Retry
              </button>
            </div>
          )}
          {loading ? (
            <div className="loading-state" role="status">
              <span className="loading-spinner" />
              Connecting to the factory…
            </div>
          ) : !updated ? (
            <Empty title="The factory could not be loaded">Check the connection and retry.</Empty>
          ) : (
            <>
              {view === 'work' && !selectedId && (
                <>
                  <PageHeader
                    eyebrow="Operation"
                    title="Runs"
                    description="Factory status, pending decisions and every delivery."
                    action={
                      <button
                        className="button primary"
                        onClick={(event) => {
                          if (form !== 'work') returnFocus.current = event.currentTarget;
                          setForm(form === 'work' ? null : 'work');
                        }}
                      >
                        + New run
                      </button>
                    }
                  />
                  {form === 'work' && (
                    <CreateWork
                      api={api}
                      cliMode={cliMode}
                      projects={projects}
                      initialProjectId={newWorkProjectId}
                      onDone={async (order) => {
                        await reload();
                        openWork(order);
                      }}
                      onCancel={() => setForm(null)}
                      onCreateProject={() => {
                        returnFocus.current = null;
                        void navigate('/projects', { state: { form: 'project' } });
                      }}
                    />
                  )}
                  {(pending.length > 0 || blockedOrders.length > 0) && (
                    <section className="attention-section" aria-labelledby="attention-title">
                      <div className="section-heading">
                        <h2 id="attention-title">Needs attention</h2>
                        <span className="count-label">{pending.length + blockedOrders.length} pending</span>
                      </div>
                      <div className="attention-list">
                        {pending.map(({ order, question }) => (
                          <button className="attention-row" key={question.id} onClick={() => openWork(order)}>
                            <span className="question-mark">
                              <Icon name="work" size={16} />
                            </span>
                            <span>
                              <strong>{question.prompt}</strong>
                              <small>
                                {projects.find((project) => project.id === order.project_id)?.name ||
                                  'Project'}{' '}
                                · {modeLabels[order.mode]}
                              </small>
                            </span>
                            <span className="row-arrow">
                              <Icon name="arrow" size={17} />
                            </span>
                          </button>
                        ))}
                        {blockedOrders.map((order) => (
                          <button
                            className="attention-row attention-blocked"
                            key={order.id}
                            onClick={() => openWork(order)}
                          >
                            <span className="question-mark">
                              <Icon name="alert" size={16} />
                            </span>
                            <span>
                              <strong>{order.summary || 'Review the blocker before continuing.'}</strong>
                              <small>
                                {projects.find((project) => project.id === order.project_id)?.name ||
                                  'Project'}{' '}
                                · {statusLabels[order.status]}
                              </small>
                            </span>
                            <span className="row-arrow">
                              <Icon name="arrow" size={17} />
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                  <div className="overview-strip" aria-label="Factory overview">
                    <div>
                      <span className="overview-value">
                        {orders.filter((order) => ['queued', 'running'].includes(order.status)).length}
                      </span>
                      <span>Active runs</span>
                    </div>
                    <div>
                      <span className="overview-value attention">{pending.length}</span>
                      <span>Pending decisions</span>
                    </div>
                    <div>
                      <span className="overview-value">
                        {
                          orders.filter((order) => order.status === 'completed' && order.evidence?.pr_url)
                            .length
                        }
                      </span>
                      <span>Completed deliveries</span>
                    </div>
                    <div>
                      <span className="overview-value">{projects.length}</span>
                      <span>Registered projects</span>
                    </div>
                  </div>
                  <FactoryOverview
                    orders={orders}
                    projects={projects}
                    status={status}
                    onOpen={openWork}
                    onView={changeView}
                  />
                  <WorkList orders={orders} projects={projects} onOpen={openWork} />
                </>
              )}
              {view === 'work' && selectedId && !selected && (
                <>
                  <PageHeader
                    eyebrow="Run"
                    title={detailError ? 'Run unavailable' : 'Loading run'}
                    description={detailError || 'Reading the saved factory state.'}
                  />
                  {!detailError && <p role="status">Loading run…</p>}
                  <Link className="back-link" to="/work">
                    ← All runs
                  </Link>
                </>
              )}
              {!view && (
                <>
                  <PageHeader
                    eyebrow="Navigation"
                    title="Page not found"
                    description="This address does not match a SABRE section."
                  />
                  <Link className="button" to="/work">
                    Go to runs
                  </Link>
                </>
              )}
              {view === 'work' && selected && (
                <WorkDetail
                  key={selected.id}
                  api={api}
                  order={selected}
                  cliMode={cliMode}
                  project={projects.find((project) => project.id === selected.project_id)}
                  onBack={() => changeView('work')}
                  onChanged={reload}
                />
              )}
              {view === 'projects' && (
                <>
                  <PageHeader
                    eyebrow="Organization"
                    title="Projects"
                    description="Repositories, conventions and checks registered with the factory."
                    action={
                      <button
                        className="button primary"
                        onClick={(event) => {
                          if (form !== 'project') returnFocus.current = event.currentTarget;
                          setForm(form === 'project' ? null : 'project');
                        }}
                      >
                        + Register project
                      </button>
                    }
                  />
                  {form === 'project' && (
                    <CreateProject
                      api={api}
                      onDone={async () => {
                        setForm(null);
                        await reload();
                      }}
                      onCancel={() => setForm(null)}
                    />
                  )}
                  {projects.length === 0 ? (
                    <Empty title="Your first project starts here">
                      Register a repository and the checks its deliveries must pass.
                    </Empty>
                  ) : (
                    <div className="project-grid">
                      {projects.map((project) => (
                        <article className="project-card" key={project.id}>
                          <div className="project-monogram" aria-hidden="true">
                            {project.name.slice(0, 2).toUpperCase()}
                          </div>
                          <h2>{project.name}</h2>
                          <p className="repository">{project.repository}</p>
                          <div className="project-meta">
                            <span>{project.profile === 'python' ? 'Python' : 'JavaScript / TypeScript'}</span>
                            <code>{project.default_branch}</code>
                          </div>
                          <div className="project-checks">
                            <span>
                              {project.gate_commands.length}{' '}
                              {project.gate_commands.length === 1 ? 'configured check' : 'configured checks'}
                            </span>
                            <span>
                              {orders.filter((order) => order.project_id === project.id).length} runs
                            </span>
                          </div>
                          <button
                            className="button"
                            onClick={() => {
                              returnFocus.current = null;
                              void navigate('/work', { state: { form: 'work', projectId: project.id } });
                            }}
                          >
                            Create run <span aria-hidden="true">→</span>
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )}
              {view === 'security' && <SecurityView api={api} projects={projects} orders={orders} />}
              {view === 'memory' && <MemoryView api={api} projects={projects} />}
              {view === 'settings' && (
                <>
                  <PageHeader
                    eyebrow="Factory capabilities"
                    title="Integrations"
                    description="Connect services, inspect their tools and control when SABRE may use them."
                  />
                  <Integrations api={api} onChanged={reload} />
                </>
              )}
              {view === 'system' && (
                <>
                  <PageHeader
                    eyebrow="Instancia local"
                    title="About SABRE"
                    description="Observed status, installed versions and factory capacity."
                  />
                  <About api={api} />
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function WorkList({
  orders,
  projects,
  onOpen,
}: {
  orders: WorkOrder[];
  projects: Project[];
  onOpen: (order: WorkOrder) => void;
}) {
  const titleId = useId();
  const [filter, setFilter] = useState('all');
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [projectId, setProjectId] = useState('');
  const filtered = orders.filter(
    (order) =>
      (!projectId || order.project_id === projectId) &&
      (filter === 'all' ||
        (filter === 'active'
          ? !['completed', 'cancelled'].includes(order.status)
          : ['completed', 'cancelled'].includes(order.status))),
  );
  return (
    <section aria-labelledby={titleId}>
      <div className="section-heading">
        <h2 id={titleId}>Run history</h2>
        <div className="segmented" aria-label="Filter runs">
          {[
            ['all', 'All'],
            ['active', 'Open'],
            ['closed', 'Closed'],
          ].map(([value, label]) => (
            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="work-view-options">
        <label className="field">
          Project
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </label>
        <div className="segmented" aria-label="Run presentation">
          <button aria-pressed={layout === 'list'} onClick={() => setLayout('list')}>
            List
          </button>
          <button aria-pressed={layout === 'board'} onClick={() => setLayout('board')}>
            Board
          </button>
        </div>
      </div>
      {layout === 'board' && filtered.length > 0 && (
        <WorkBoard orders={filtered} projects={projects} onOpen={onOpen} />
      )}
      {filtered.length === 0 ? (
        <Empty title={orders.length ? 'No runs in this view' : 'Your first run starts here'}>
          {orders.length
            ? 'Try a different filter to inspect the history.'
            : 'Describe what to create, maintain or fix. The supervisor will organize the work.'}
        </Empty>
      ) : layout === 'list' ? (
        <div className="work-list">
          {filtered.map((order) => (
            <button className="work-row" key={order.id} onClick={() => onOpen(order)}>
              <div className="work-row-main">
                <span className="work-context">
                  {projects.find((project) => project.id === order.project_id)?.name || 'Project'}{' '}
                  <span aria-hidden="true">/</span> {modeLabels[order.mode]}
                </span>
                <strong>{order.objective}</strong>
                <span className="work-summary">{order.summary}</span>
              </div>
              <div className="work-row-status">
                <Badge value={order.status} />
                <span>{phaseLabels[order.phase] || order.phase}</span>
              </div>
              <div className="work-row-end">
                <time dateTime={order.updated_at}>{time(order.updated_at)}</time>
                <span aria-hidden="true">↗</span>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CreateProject({
  api,
  onDone,
  onCancel,
}: {
  api: Api;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const action = useAction();
  const [profile, setProfile] = useState<'python' | 'node'>('python');
  const [commands, setCommands] = useState('["python", "-m", "pytest"]');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      let gateCommands: string[][];
      try {
        gateCommands = lines(data.get('commands')).map((line) => {
          const command: unknown = JSON.parse(line);
          if (
            !Array.isArray(command) ||
            !command.length ||
            command.some((arg) => typeof arg !== 'string' || !arg)
          )
            throw new Error();
          return command as string[];
        });
      } catch {
        throw new Error('Each check must be a JSON argument array, for example ["python", "-m", "pytest"].');
      }
      await api.createProject({
        name: String(data.get('name')),
        repository: String(data.get('repository')),
        profile,
        default_branch: String(data.get('branch')),
        gate_commands: gateCommands,
        allowed_mcp_servers: lines(data.get('mcp')),
        approved_baseline: lines(data.get('baseline')),
      });
      await onDone();
    });
  };
  return (
    <section className="form-panel">
      <div className="section-heading">
        <h2>Register project</h2>
        <button className="text-button" onClick={onCancel}>
          Close
        </button>
      </div>
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Project name">
            <input name="name" maxLength={100} required placeholder="My project" />
          </Field>
          <Field label="Repository">
            <input name="repository" required placeholder="https://github.com/example/project" />
          </Field>
          <Field label="Ecosistema">
            <Select
              value={profile}
              onChange={(event) => {
                const next = event.target.value as 'python' | 'node';
                setProfile(next);
                setCommands(next === 'python' ? '["python", "-m", "pytest"]' : '["npm", "test"]');
              }}
            >
              <option value="python">Python</option>
              <option value="node">JavaScript / TypeScript</option>
            </Select>
          </Field>
          <Field label="Base branch">
            <input name="branch" required defaultValue="main" />
          </Field>
        </div>
        <Field
          label="Delivery checks"
          hint="One JSON argument array per line. Use the actual repository verification commands."
        >
          <textarea
            name="commands"
            required
            rows={3}
            value={commands}
            onChange={(event) => setCommands(event.target.value)}
            className="code-input"
          />
        </Field>
        <details className="advanced">
          <summary>External tools and security baseline</summary>
          <div className="form-grid">
            <Field label="Allowed MCP servers" hint="One per line; leave empty if unnecessary.">
              <textarea name="mcp" rows={3} />
            </Field>
            <Field
              label="Accepted existing findings"
              hint="Fingerprints you have reviewed, one per line. This cannot approve new secrets."
            >
              <textarea name="baseline" rows={3} />
            </Field>
          </div>
        </details>
        {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
        <div className="form-actions">
          <button type="button" className="button" onClick={onCancel} disabled={action.busy}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            {action.busy ? 'Registering…' : 'Register project'}
          </button>
        </div>
      </form>
    </section>
  );
}

function CreateWork({
  api,
  cliMode,
  projects,
  initialProjectId,
  onDone,
  onCancel,
  onCreateProject,
}: {
  api: Api;
  cliMode: boolean;
  projects: Project[];
  initialProjectId: string;
  onDone: (order: WorkOrder) => Promise<void>;
  onCancel: () => void;
  onCreateProject: () => void;
}) {
  const action = useAction();
  const [mode, setMode] = useState<'create' | 'maintain' | 'patch' | 'audit'>('patch');
  const [flowConfig, setFlowConfig] = useState<FlowConfig>({ version: 1, repair_cycles: 2 });
  const [limits, setLimits] = useState<'agent' | 'budget'>('budget');
  const perAgent = cliMode && limits === 'agent';
  const [key] = useState(() => crypto.randomUUID());
  if (!projects.length)
    return (
      <section className="form-panel">
        <Empty title="Register a project to get started">
          Register the repository SABRE is authorized to work on.
          <button className="button primary" onClick={onCreateProject}>
            Register project
          </button>
        </Empty>
      </section>
    );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      const order = await api.createWork({
        project_id: String(data.get('project')),
        mode,
        flow_config: flowConfig,
        objective: String(data.get('objective')),
        acceptance: lines(data.get('acceptance')),
        constraints: lines(data.get('constraints')),
        budget: perAgent
          ? {
              max_cost_usd: 0,
              max_calls: null,
              max_tokens: null,
              active_seconds: null,
            }
          : {
              max_cost_usd: Number(data.get('cost')),
              max_calls: Number(data.get('calls')),
              max_tokens: Number(data.get('tokens')),
              active_seconds: Number(data.get('minutes')) * 60,
            },
        idempotency_key: key,
        channel: 'web',
        channel_thread: null,
      });
      await onDone(order);
    });
  };
  return (
    <section className="form-panel">
      <div className="section-heading">
        <h2>New run</h2>
        <button className="text-button" onClick={onCancel}>
          Close
        </button>
      </div>
      <form onSubmit={submit}>
        <fieldset className="mode-picker">
          <legend>Work type</legend>
          {(['create', 'maintain', 'patch', 'audit'] as const).map((item) => (
            <label key={item} className={mode === item ? 'mode-option selected' : 'mode-option'}>
              <input
                type="radio"
                name="mode"
                value={item}
                checked={mode === item}
                onChange={() => setMode(item)}
              />
              <strong>{modeLabels[item]}</strong>
              <span>
                {item === 'create'
                  ? 'Design and build something new'
                  : item === 'maintain'
                    ? 'Improve an existing project'
                    : 'patch' === item
                      ? 'Fix a specific defect'
                      : 'Inspect without modifying project files'}
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Project">
          <Select name="project" defaultValue={initialProjectId || projects[0].id} required>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What do you need?" hint="Describe the outcome and the context the team needs.">
          <textarea
            name="objective"
            required
            minLength={5}
            maxLength={12000}
            rows={3}
            placeholder="I need…"
          />
        </Field>
        <div className="form-grid">
          <Field label="Acceptance criteria" hint="One verifiable outcome per line.">
            <textarea
              name="acceptance"
              required
              rows={4}
              placeholder="After completion, it must be possible to…"
            />
          </Field>
          <Field label="Constraints" hint="One per line, if needed.">
            <textarea name="constraints" rows={4} placeholder="Compatibility, scope, conventions…" />
          </Field>
        </div>
        <FlowConfiguration api={api} mode={mode} value={flowConfig} onChange={setFlowConfig} />
        <fieldset className="budget-fields">
          <legend>Run limits</legend>
          {cliMode && (
            <Field label="Run controls">
              <Select
                value={limits}
                onChange={(event) => setLimits(event.target.value as 'agent' | 'budget')}
              >
                <option value="agent">Per-agent controls (CLI)</option>
                <option value="budget">Cumulative budget</option>
              </Select>
            </Field>
          )}
          {perAgent ? (
            <CliProgressPolicy />
          ) : (
            <>
              <div className="form-grid four">
                <Field
                  label="Maximum budget · USD"
                  hint={
                    cliMode
                      ? 'CLI subscription calls do not record API charges. Zero does not authorize API spending with other providers.'
                      : undefined
                  }
                >
                  <input name="cost" type="number" min="0" max="1000" step="0.01" required defaultValue="0" />
                </Field>
                <Field label="Model invocations">
                  <input name="calls" type="number" min="1" max="500" defaultValue="40" required />
                </Field>
                <Field label="Tokens">
                  <input name="tokens" type="number" min="1" max="10000000" defaultValue="100000" required />
                </Field>
                <Field label="Active time · minutes">
                  <input name="minutes" type="number" min="1" max="1440" defaultValue="60" required />
                </Field>
              </div>
              <p>Time waiting for your decisions does not count as active execution time.</p>
              {cliMode && (
                <p>
                  A CLI invocation can contain several internal requests. Invocation count, duration and
                  concurrency are controlled; token usage is recorded afterward and an overrun blocks the next
                  step.
                </p>
              )}
            </>
          )}
        </fieldset>
        {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
        <div className="form-actions">
          <button className="button" type="button" onClick={onCancel} disabled={action.busy}>
            Cancel
          </button>
          <button className="button primary" disabled={action.busy}>
            {action.busy ? 'Sending…' : 'Launch flow'}
          </button>
        </div>
      </form>
    </section>
  );
}

function WorkDetail({
  api,
  order,
  cliMode,
  project,
  onBack,
  onChanged,
}: {
  api: Api;
  order: WorkOrder;
  cliMode: boolean;
  project?: Project;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [eventsError, setEventsError] = useState('');
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [auditError, setAuditError] = useState('');
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditRefresh, setAuditRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    void api
      .audit(order.id)
      .then((value) => {
        if (live) {
          setAudit(value);
          setAuditError('');
        }
      })
      .catch((error) => {
        if (live) setAuditError(message(error));
      })
      .finally(() => {
        if (live) setAuditLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, order.id, order.calls_used, order.phase, order.status, auditRefresh]);
  useEffect(() => {
    let live = true;
    void api
      .events(order.id)
      .then((data) => {
        if (live) {
          setEvents(data);
          setEventsError('');
        }
      })
      .catch((err) => {
        if (live) setEventsError(message(err));
      });
    return () => {
      live = false;
    };
  }, [api, order.id, order.updated_at]);
  const control = (next: 'pause' | 'resume' | 'cancel') =>
    void action.run(async () => {
      await api.control(order.id, next);
      setConfirmCancel(false);
      await onChanged();
    });
  const pending = pendingQuestions(order);
  const terminal = ['completed', 'cancelled'].includes(order.status) || order.phase === 'security_watch';
  const pr = externalUrl(order.evidence?.pr_url);
  const perAgent =
    order.budget.max_calls === null &&
    order.budget.max_tokens === null &&
    order.budget.active_seconds === null;
  const canChangeLimits =
    cliMode &&
    !perAgent &&
    !terminal &&
    ['paused', 'blocked'].includes(order.status) &&
    order.control !== 'cancel' &&
    order.budget.max_cost_usd === 0;
  return (
    <>
      <button className="back-link" onClick={onBack}>
        ← All runs
      </button>
      <div className="detail-header">
        <div>
          <div className="work-context">
            {project?.name || 'Project'} <span aria-hidden="true">/</span> {modeLabels[order.mode]}{' '}
            <span aria-hidden="true">/</span> Review {order.plan_revision}
          </div>
          <h1 tabIndex={-1}>
            {order.phase === 'security_watch' ? 'Monitoring' : modeLabels[order.mode]}{' '}
            {project?.name || 'project'}
          </h1>
          {!order.error_code && <p>{order.summary}</p>}
        </div>
        <Badge value={order.status} />
      </div>
      <div className="detail-toolbar">
        <span className="phase-tag">{phaseLabels[order.phase] || order.phase}</span>
        <span>Updated {time(order.updated_at)}</span>
        <div className="toolbar-actions">
          {!terminal && ['running', 'queued', 'waiting_input', 'failed'].includes(order.status) && (
            <button
              className="button small"
              disabled={action.busy || order.control === 'pause'}
              onClick={() => control('pause')}
            >
              Pause
            </button>
          )}
          {!terminal && ['paused', 'blocked', 'failed'].includes(order.status) && (
            <button className="button small" disabled={action.busy} onClick={() => control('resume')}>
              Resume
            </button>
          )}
          {!terminal && (
            <button
              className="button small danger-quiet"
              disabled={action.busy}
              onClick={() => setConfirmCancel(!confirmCancel)}
            >
              Cancel run
            </button>
          )}
          {pr && (
            <a className="button primary small" href={pr} target="_blank" rel="noreferrer">
              Review PR ↗
            </a>
          )}
        </div>
      </div>
      {order.control && !terminal && ['running', 'queued'].includes(order.status) && (
        <div className="notice neutral" role="status">
          <strong>{order.control === 'pause' ? 'Pause requested.' : 'Cancellation requested.'}</strong>
          <p>Work will stop at the next safe checkpoint. You can continue inspecting its status.</p>
        </div>
      )}
      {confirmCancel && (
        <div className="notice warning">
          <div>
            <strong>Cancel this run?</strong>
            <p>Pending work will stop. Saved evidence remains available.</p>
          </div>
          <button className="button danger" disabled={action.busy} onClick={() => control('cancel')}>
            Confirm cancellation
          </button>
          <button className="text-button" onClick={() => setConfirmCancel(false)}>
            Back
          </button>
        </div>
      )}
      {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
      {order.error_code && (
        <div className="notice warning">
          <strong>{order.error_code}</strong>
          <p>{order.summary}</p>
        </div>
      )}
      {pending.length > 0 && (
        <section className="questions-section">
          <div className="section-heading">
            <h2>Your decision unlocks the next step</h2>
            <span className="count-label">{pending.length} pending</span>
          </div>
          {pending.map((question) => (
            <QuestionForm
              key={question.id}
              api={api}
              order={order}
              question={question}
              onChanged={onChanged}
            />
          ))}
        </section>
      )}
      <details className="work-objective" aria-label="Run objective">
        <summary>Full objective</summary>
        <p>{order.objective}</p>
      </details>
      <div className="detail-grid">
        <div className="detail-primary">
          <ExecutionTimeline
            key={order.id}
            api={api}
            workId={order.id}
            active={['running', 'queued'].includes(order.status)}
          />
          {order.evidence && (
            <section className="delivery-evidence">
              <div className="section-heading">
                <h2>Delivery evidence</h2>
                <span className="count-label">{order.evidence.gates.length} recorded checks</span>
              </div>
              <p>{order.evidence.review}</p>
              {order.evidence.gates.some(
                (gate) => !gate.snapshot_digest || gate.snapshot_digest !== order.evidence?.snapshot_digest,
              ) && (
                <ErrorNotice>
                  Some check snapshots do not match the delivery and cannot validate this evidence.
                </ErrorNotice>
              )}
              {order.evidence.gates.length ? (
                <ul className="gate-list" aria-label="Delivery checks">
                  {order.evidence.gates.map((gate, index) => {
                    const matches = Boolean(
                      gate.snapshot_digest && gate.snapshot_digest === order.evidence?.snapshot_digest,
                    );
                    const passed = gate.exit_code === 0 && matches;
                    return (
                      <li key={index} className={passed ? 'passed' : 'failed'}>
                        <div>
                          <code>{gate.command.join(' ')}</code>
                          <p>
                            Salida {gate.exit_code} ·{' '}
                            {matches ? 'Delivery snapshot' : 'Snapshot differs from delivery'}
                          </p>
                        </div>
                        <strong>{!matches ? 'Evidencia ajena' : passed ? 'Superada' : 'Fallida'}</strong>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="quiet-state">This evidence has no recorded checks.</div>
              )}
              <details className="technical-details">
                <summary>Technical references</summary>
                <dl className="evidence-list">
                  <dt>Commit</dt>
                  <dd>
                    <code>{order.evidence.commit}</code>
                  </dd>
                  <dt>Snapshot</dt>
                  <dd>
                    <code>{order.evidence.snapshot_digest}</code>
                  </dd>
                  <dt>Verification profile</dt>
                  <dd>
                    <code>{order.evidence.profile_digest}</code>
                  </dd>
                  <dt>Security rules</dt>
                  <dd>{order.evidence.rules_version}</dd>
                  {order.evidence.branch && (
                    <>
                      <dt>Branch</dt>
                      <dd>
                        <code>{order.evidence.branch}</code>
                      </dd>
                    </>
                  )}
                  {order.evidence.gates.map((gate, index) => (
                    <Fragment key={index}>
                      <dt>Check {index + 1} · output</dt>
                      <dd>
                        <code>{gate.output_digest}</code>
                      </dd>
                      <dt>Check {index + 1} · snapshot</dt>
                      <dd>
                        <code>{gate.snapshot_digest}</code>
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              </details>
            </section>
          )}
          <section>
            <div className="section-heading">
              <h2>{order.phase === 'security_watch' ? 'Remediation proposals' : 'Work plan'}</h2>
              <span className="count-label">
                {order.tasks.filter((task) => task.status === 'completed').length} / {order.tasks.length}{' '}
                tasks
              </span>
            </div>
            {!order.tasks.length ? (
              <Empty
                title={order.phase === 'security_watch' ? 'No remediation proposals' : 'No recorded tasks'}
              >
                {order.phase === 'security_watch'
                  ? 'Monitoring recorded no remediation proposals.'
                  : emptyPlanMessages[order.status]}
              </Empty>
            ) : (
              <ol className="task-list">
                {order.tasks.map((task) => (
                  <li key={task.id}>
                    <span className={`task-step ${task.status}`} aria-hidden="true">
                      {task.status === 'completed' ? (
                        <Icon name="check" size={15} />
                      ) : (
                        <span className="task-status-dot" />
                      )}
                    </span>
                    <div>
                      <div className="task-title">
                        <h3>{task.title}</h3>
                        <Badge value={task.status} />
                      </div>
                      <p>
                        {roleLabels[task.role] || task.role}
                        {task.specialty && task.specialty !== 'general'
                          ? ` · ${{ infrastructure: 'Infrastructure', frontend: 'Frontend', backend: 'Backend', documentation: 'Documentation' }[task.specialty]}`
                          : ''}{' '}
                        · {task.attempts} {task.attempts === 1 ? 'intento' : 'intentos'}
                      </p>
                      {task.depends_on.length > 0 && (
                        <p className="dependency">
                          Depends on:{' '}
                          {task.depends_on
                            .map((id) => order.tasks.find((candidate) => candidate.id === id)?.title || id)
                            .join(' · ')}
                        </p>
                      )}
                      {task.result && <p className="task-result">{task.result}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section>
            <div className="section-heading">
              <h2>Security pipeline</h2>
              <span className="count-label">{order.findings.length} findings</span>
            </div>
            {order.findings.length ? (
              <Findings findings={order.findings} />
            ) : (
              <div className="quiet-state">
                {order.evidence
                  ? 'The review recorded no findings.'
                  : 'The security pipeline has not produced a result for this delivery.'}
              </div>
            )}
            {order.security_snapshot_digest && (
              <SecurityExceptions api={api} order={order} onChanged={onChanged} />
            )}
          </section>
          <section>
            <div className="section-heading">
              <h2>Activity</h2>
              <button
                className="button small"
                onClick={() => {
                  setAuditLoading(true);
                  setAuditRefresh((value) => value + 1);
                }}
                disabled={auditLoading}
              >
                Refresh audit
              </button>
            </div>
            <WorkAudit data={audit} loading={auditLoading} error={auditError} />
            {eventsError ? (
              <ErrorNotice>{eventsError}</ErrorNotice>
            ) : !events.length ? (
              <div className="quiet-state">No recorded events yet.</div>
            ) : (
              <ol className="activity-list">
                {events.map((event, index) => (
                  <li key={String(event.id || index)}>
                    <span className="activity-dot" aria-hidden="true" />
                    <div>
                      <p>{String(event.message || event.kind || 'Recorded event')}</p>
                      {typeof event.created_at === 'string' && (
                        <time dateTime={event.created_at}>{time(event.created_at)}</time>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
        <aside className="detail-aside">
          <section className="aside-section" aria-labelledby="usage-title">
            <h2 id="usage-title">Usage and limits</h2>
            <Usage label="Model calls" value={order.calls_used} max={order.budget.max_calls} />
            <Usage label="Tokens" value={order.tokens_used} max={order.budget.max_tokens} />
            <Usage
              label="Recorded API cost"
              value={order.cost_usd}
              max={order.budget.max_cost_usd}
              currency
            />
            <Usage
              label="Active time · min"
              value={Math.round(order.active_seconds_used / 60)}
              max={order.budget.active_seconds === null ? null : Math.round(order.budget.active_seconds / 60)}
            />
            {perAgent && <CliProgressPolicy />}
            {canChangeLimits && (
              <>
                <p>
                  You can replace cumulative quotas with per-agent controls. Recorded usage and checks remain
                  available; the run stays stopped until resumed.
                </p>
                <details>
                  <summary>How per-agent controls work</summary>
                  <CliProgressPolicy />
                </details>
                <button
                  className="button small"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await api.useCliProgressLimits(order.id, {
                        expected_revision: order.plan_revision,
                        expected_budget: order.budget,
                      });
                      await onChanged();
                    })
                  }
                >
                  Use per-agent controls
                </button>
              </>
            )}
          </section>
          <section className="aside-section">
            <h2>Acceptance criteria</h2>
            <ul className="criteria-list">
              {order.acceptance.map((criterion, index) => (
                <li key={index}>{criterion}</li>
              ))}
            </ul>
            {order.constraints.length > 0 && (
              <>
                <h3>Constraints</h3>
                <ul className="criteria-list">
                  {order.constraints.map((constraint, index) => (
                    <li key={index}>{constraint}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {!terminal && <ScopeForm api={api} order={order} onChanged={onChanged} />}
          <p className="run-reference">
            Run <code>{order.id}</code>
            <br />
            Created {time(order.created_at)}
          </p>
        </aside>
      </div>
    </>
  );
}

function Usage({
  label,
  value,
  max,
  currency = false,
}: {
  label: string;
  value: number;
  max: number | null;
  currency?: boolean;
}) {
  return (
    <div className="usage">
      <div>
        <span>{label}</span>
        <strong>
          {currency ? money.format(value) : integer.format(value)}{' '}
          {max !== null && <small>/ {currency ? money.format(max) : integer.format(max)}</small>}
        </strong>
      </div>
      {max !== null && max > 0 && <meter min={0} max={max} value={Math.min(value, max)} aria-label={label} />}
    </div>
  );
}

function SecurityExceptions({
  api,
  order,
  onChanged,
}: {
  api: Api;
  order: WorkOrder;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const [items, setItems] = useState<SecurityException[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const load = useCallback(async () => {
    try {
      setItems(await api.securityExceptions(order.id));
      setError('');
    } catch (err) {
      setError(message(err));
    }
  }, [api, order.id]);
  useEffect(() => {
    void load();
  }, [load, order.updated_at]);
  const allowed =
    order.phase !== 'security_watch' &&
    ['paused', 'blocked'].includes(order.status) &&
    Boolean(order.security_snapshot_digest && order.security_rules_version);
  const eligible = order.findings.filter(
    (finding) =>
      !['secret', 'scanner_error'].includes(finding.category) &&
      ['high', 'critical'].includes(finding.severity) &&
      !finding.baseline,
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      await api.approveSecurityException(order.id, {
        fingerprint: String(data.get('finding')),
        justification: String(data.get('justification')),
        expires_at: new Date(String(data.get('expiry'))).toISOString(),
        snapshot_digest: order.security_snapshot_digest!,
        rules_version: order.security_rules_version!,
        plan_revision: order.plan_revision,
      });
      setShowForm(false);
      await load();
      await onChanged();
    });
  };
  return (
    <div className="security-exceptions">
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
      {items.map((item) => (
        <article className="finding" key={item.id}>
          <h3>Owner-approved exception · revision {item.plan_revision}</h3>
          <p>{item.justification}</p>
          <p>{item.revoked_at ? `Revocada ${time(item.revoked_at)}` : `Caduca ${time(item.expires_at)}`}</p>
          {!item.revoked_at && (
            <button
              className="text-button danger-quiet"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api.revokeSecurityException(order.id, item.id);
                  await load();
                  await onChanged();
                })
              }
            >
              Revoke exception
            </button>
          )}
        </article>
      ))}
      {allowed && eligible.length > 0 && (
        <>
          <button className="button small" onClick={() => setShowForm(!showForm)}>
            Temporary security exception
          </button>
          {showForm && (
            <form className="form-panel" onSubmit={submit}>
              <h3>Accept a specific risk</h3>
              <p>
                Your approval applies to this source snapshot and revision. Resume the run to verify it again.
              </p>
              <Field label="Finding">
                <Select name="finding" required defaultValue="">
                  <option value="" disabled>
                    Select the risk
                  </option>
                  {eligible.map((finding) => (
                    <option key={finding.fingerprint} value={finding.fingerprint}>
                      {finding.title}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Exception justification">
                <textarea name="justification" required minLength={10} maxLength={4000} rows={3} />
              </Field>
              <Field label="Caducidad · hora local" hint="Choose a future date within 30 days.">
                <input name="expiry" type="datetime-local" required />
              </Field>
              <button className="button primary" disabled={action.busy}>
                {action.busy ? 'Saving…' : 'Temporarily approve this risk'}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function QuestionForm({
  api,
  order,
  question,
  onChanged,
}: {
  api: Api;
  order: WorkOrder;
  question: HumanQuestion;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const [answer, setAnswer] = useState('');
  return (
    <article className="question-card">
      <div className="question-card-heading">
        <span className="question-mark" aria-hidden="true">
          ?
        </span>
        <div>
          <span className="eyebrow">Pending decision · revision {question.plan_revision}</span>
          <h3>{question.prompt}</h3>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await api.answer(order.id, {
              question_id: question.id,
              plan_revision: question.plan_revision,
              answer,
            });
            await onChanged();
          });
        }}
      >
        {question.options.length > 0 && (
          <div className="answer-options">
            {question.options.map((option) => (
              <button
                key={option}
                type="button"
                className={answer === option ? 'answer-option selected' : 'answer-option'}
                aria-pressed={answer === option}
                onClick={() => setAnswer(option)}
              >
                {option}
              </button>
            ))}
          </div>
        )}
        <Field label="Your answer">
          <textarea
            required
            rows={2}
            maxLength={12000}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Describe how the team should continue…"
          />
        </Field>
        {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
        <div className="form-actions">
          <span>Your answer will be bound to this decision.</span>
          <button className="button primary" disabled={action.busy}>
            {action.busy ? 'Sending…' : 'Answer and continue'}
          </button>
        </div>
      </form>
    </article>
  );
}

function ScopeForm({
  api,
  order,
  onChanged,
}: {
  api: Api;
  order: WorkOrder;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const canChange = ['paused', 'blocked'].includes(order.status);
  return (
    <details className="scope-change aside-section">
      <summary>Change request</summary>
      <p>
        Updating scope creates a new plan revision. Previous decisions must be revalidated.{' '}
        {!canChange && <strong>Pause the run before applying this change.</strong>}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void action.run(async () => {
            await api.scope(order.id, {
              expected_revision: order.plan_revision,
              objective: String(data.get('objective')),
              acceptance: lines(data.get('acceptance')),
            });
            await onChanged();
          });
        }}
      >
        <Field label="New objective">
          <textarea name="objective" required minLength={5} defaultValue={order.objective} rows={3} />
        </Field>
        <Field label="Updated criteria">
          <textarea name="acceptance" required defaultValue={order.acceptance.join('\n')} rows={3} />
        </Field>
        {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
        <button className="button" disabled={action.busy || !canChange}>
          {action.busy ? 'Updating…' : 'Update scope'}
        </button>
      </form>
    </details>
  );
}

function Findings({ findings }: { findings: SecurityFinding[] }) {
  return (
    <div className="findings-list">
      {findings.map((finding, index) => (
        <article key={`${finding.fingerprint}-${index}`} className="finding">
          <div className="finding-heading">
            <Badge value={finding.severity} />
            <span className="scanner-name">{finding.scanner}</span>
            {finding.baseline && <span className="baseline-label">Accepted baseline</span>}
            {finding.exception_id && <span className="baseline-label">Temporary exception</span>}
          </div>
          <h3>{finding.title}</h3>
          {finding.path && (
            <code>
              {finding.path}
              {finding.line ? `:${finding.line}` : ''}
            </code>
          )}
          {finding.remediation && <p>{finding.remediation}</p>}
          <div className="finding-footer">
            <span>
              {
                (
                  {
                    secret: 'Secret',
                    vulnerability: 'Vulnerability',
                    code: 'Code analysis',
                    configuration: 'Configuration',
                    scanner_error: 'Incomplete check',
                  } as Record<string, string>
                )[finding.category]
              }
            </span>
            {externalUrl(finding.reference) ? (
              <a href={externalUrl(finding.reference)!} target="_blank" rel="noreferrer">
                View reference ↗
              </a>
            ) : (
              finding.reference && <span>{finding.reference}</span>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function SecurityView({ api, projects, orders }: { api: Api; projects: Project[]; orders: WorkOrder[] }) {
  const [projectId, setProjectId] = useState('');
  const [findings, setFindings] = useState<SecurityFinding[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFindings(await api.security(projectId || undefined));
      setError('');
    } catch (err) {
      setFindings([]);
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [load]);
  const scoped = orders.filter((order) => !projectId || order.project_id === projectId);
  return (
    <>
      <PageHeader
        eyebrow="Independent review"
        title="Security"
        description="Security findings and blockers, independent from the development team."
        action={
          <button className="button" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        }
      />
      <div className="filter-row">
        <Field label="Project">
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
        <p>
          {scoped.filter((order) => order.status === 'blocked').length} blocked runs ·{' '}
          {
            findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high')
              .length
          }{' '}
          high or critical findings
        </p>
      </div>
      <div className="notice neutral">
        <strong>Monitoring proposes; you decide.</strong>
        <p>Recommendations do not start patches automatically. Request work after reviewing its impact.</p>
      </div>
      {error ? (
        <ErrorNotice>{error}</ErrorNotice>
      ) : loading && !findings.length ? (
        <div className="loading-state" role="status">
          Loading security pipeline…
        </div>
      ) : findings.length ? (
        <Findings findings={findings} />
      ) : (
        <Empty title="No recorded findings">
          Results appear after verification. An absence of findings does not replace a complete review.
        </Empty>
      )}
    </>
  );
}

function MemoryView({ api, projects }: { api: Api; projects: Project[] }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [knowledge, setKnowledge] = useState<ProjectKnowledgeReport | null>(null);
  const [knowledgeError, setKnowledgeError] = useState('');
  const loadGeneration = useRef(0);
  const action = useAction();
  const load = useCallback(async () => {
    if (!projectId) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setKnowledge(null);
    const [memories, report] = await Promise.allSettled([api.memory(projectId), api.knowledge(projectId)]);
    if (generation !== loadGeneration.current) return;
    setItems(memories.status === 'fulfilled' ? memories.value : []);
    setError(memories.status === 'rejected' ? message(memories.reason) : '');
    setKnowledge(report.status === 'fulfilled' ? report.value : null);
    setKnowledgeError(report.status === 'rejected' ? message(report.reason) : '');
    setLoading(false);
  }, [api, projectId]);
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [load]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      await api.createMemory({
        project_id: projectId,
        kind: String(data.get('kind')) as 'fact' | 'lesson',
        content: String(data.get('content')),
        source_commit: String(data.get('commit')),
        source_work_id: String(data.get('work')),
        evidence_digest: String(data.get('evidence')) || null,
      });
      setShowForm(false);
      await load();
    });
  };
  return (
    <>
      <PageHeader
        eyebrow="Context with provenance"
        title="Memory"
        description="Source context, resumable executions and approved knowledge, with provenance."
        action={
          <button className="button primary" disabled={!projectId} onClick={() => setShowForm(!showForm)}>
            + Propose memory
          </button>
        }
      />
      {!projects.length ? (
        <Empty title="Register a project to save knowledge">
          Each memory belongs to a project and retains its source.
        </Empty>
      ) : (
        <>
          <div className="filter-row">
            <Field label="Project">
              <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </Field>
            <p>
              {items.filter((item) => item.active).length} active memories ·{' '}
              {items.filter((item) => !item.active && !item.invalidated_at).length} pending
            </p>
          </div>
          {showForm && (
            <section className="form-panel">
              <div className="section-heading">
                <h2>Propose knowledge</h2>
                <button className="text-button" onClick={() => setShowForm(false)}>
                  Close
                </button>
              </div>
              <form onSubmit={submit}>
                <Field label="Content">
                  <textarea name="content" required rows={3} maxLength={8000} />
                </Field>
                <div className="form-grid">
                  <Field label="Type">
                    <Select name="kind">
                      <option value="lesson">Proposed lesson</option>
                      <option value="fact">Verifiable fact</option>
                    </Select>
                  </Field>
                  <Field label="Source run">
                    <input name="work" required />
                  </Field>
                  <Field label="Reference commit">
                    <input name="commit" required />
                  </Field>
                  <Field label="Evidence digest">
                    <input name="evidence" />
                  </Field>
                </div>
                {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
                <div className="form-actions">
                  <button className="button primary" disabled={action.busy}>
                    {action.busy ? 'Saving…' : 'Save proposal'}
                  </button>
                </div>
              </form>
            </section>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {!showForm && action.error && <ErrorNotice>{action.error}</ErrorNotice>}
          <ProjectKnowledge data={knowledge} loading={loading} error={knowledgeError} />
          {loading ? (
            <div className="loading-state" role="status">
              Loading memory…
            </div>
          ) : !items.length ? (
            <Empty title="No approved delivery memories">
              Memories are recorded after delivery. Earlier context and checkpoints are shown above; saving
              them does not make them approved facts.
            </Empty>
          ) : (
            <div className="memory-list">
              {items.map((item) => (
                <article
                  className={item.invalidated_at ? 'memory-item invalidated' : 'memory-item'}
                  key={item.id}
                >
                  <div className="memory-header">
                    <span className="eyebrow">{item.kind === 'fact' ? 'Verifiable fact' : 'Lesson'}</span>
                    <span className={`memory-status ${item.active ? 'active' : ''}`}>
                      {item.invalidated_at ? 'Invalidated' : item.active ? 'Active' : 'Awaiting approval'}
                    </span>
                  </div>
                  <p>{item.content}</p>
                  <div className="memory-source">
                    <span>
                      Commit <code>{item.source_commit}</code>
                    </span>
                    <span>
                      Run <code>{item.source_work_id}</code>
                    </span>
                    <time dateTime={item.created_at}>{time(item.created_at)}</time>
                  </div>
                  {!item.invalidated_at && (
                    <div className="memory-actions">
                      {!item.active && (
                        <button
                          className="button small"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              await api.memoryAction(item.id, 'approve');
                              await load();
                            })
                          }
                        >
                          Approve memory
                        </button>
                      )}
                      <button
                        className="text-button danger-quiet"
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(async () => {
                            await api.memoryAction(item.id, 'invalidate');
                            await load();
                          })
                        }
                      >
                        Invalidate
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

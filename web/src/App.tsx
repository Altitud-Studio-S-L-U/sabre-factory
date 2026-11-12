import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type PanelSession,
  type Project,
  type WorkOrder,
} from './api';
import Button from './components/Button';
import Notice from './components/Notice';
import EmptyState from './components/EmptyState';
import LoadingState from './components/LoadingState';
import PageHeader from './components/PageHeader';
import Dialog from './components/Dialog';
import { buttonVariants } from './components/ui/button';
import SupervisorConsole from './SupervisorConsole';
import { pendingQuestions } from './runState';
import { legacyNavigation, navigation, redirects, type View } from './navigation';
import AppShell from './app/AppShell';
import type { PaletteCommand } from './app/CommandPalette';
import Login from './app/Login';
import RunDetail from './features/runs/RunDetail';
import RunsTable, { runPath } from './features/runs/RunsTable';
import CreateRunWizard from './features/runs/CreateRunWizard';
import ProjectsView from './features/projects/ProjectsView';
import SecurityView from './features/security/SecurityView';
import { ErrorNotice, message, statusLabels, usesOnlyCliModels } from './features/runs/shared';

// Sections load on first visit; Runs stays in the main bundle.
const sections = {
  agentsConsole: () => import('./AgentsConsole'),
  toolsConsole: () => import('./ToolsConsole'),
  memoryConsole: () => import('./MemoryConsole'),
  configConsole: () => import('./ConfigConsole'),
  integrations: () => import('./Integrations'),
  about: () => import('./About'),
};

/** Fetch section code once the console is idle so the first visit does not wait on the network. */
function usePrefetchSections() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const load of Object.values(sections)) void load();
    }, 300);
    return () => window.clearTimeout(timer);
  }, []);
}
const AgentsConsole = lazy(sections.agentsConsole);
const ToolsConsole = lazy(sections.toolsConsole);
const MemoryConsole = lazy(sections.memoryConsole);
const ConfigConsole = lazy(sections.configConsole);
const Integrations = lazy(sections.integrations);
const About = lazy(sections.about);

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
    // A browser paired from another tab (or by sabre open) shares the cookie: re-check on return.
    let probing: Promise<PanelSession | null> | null = null;
    const recheck = () => {
      if (activeSession.current || document.visibilityState === 'hidden') return;
      if (probing && connection.current === probing) return;
      if (new URLSearchParams(window.location.hash.slice(1)).has('ticket')) return;
      probing = openPanelSession();
      connection.current = probing;
      observe(probing);
      void probing
        .finally(() => {
          probing = null;
        })
        .catch(() => undefined);
    };
    window.addEventListener('hashchange', accessLink);
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    // StrictMode repeats effects; a one-use ticket must have only one exchange.
    connection.current ??= openPanelSession();
    observe(connection.current);
    return () => {
      current = false;
      window.removeEventListener('hashchange', accessLink);
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
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
        {redirects.map((item) => (
          <Route
            key={item.from}
            path={`${item.from}/*`}
            element={<MovedRedirect from={item.from} to={item.to} />}
          />
        ))}
        <Route path="*" element={<Session session={session} onLogout={disconnect} />} />
      </Routes>
    </BrowserRouter>
  );
}

function RootRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/runs', search, hash }} replace />;
}

/** Keep an earlier address working: /work/abc opens /runs/abc with the same query and fragment. */
function MovedRedirect({ from, to }: { from: string; to: string }) {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={{ pathname: to + pathname.slice(from.length), search, hash }} replace />;
}

function Session({ session, onLogout }: { session: PanelSession; onLogout: (error?: string) => void }) {
  const api = useMemo(() => createApi(session.csrf_token, onLogout), [session.csrf_token, onLogout]);
  usePrefetchSections();
  const location = useLocation();
  const navigate = useNavigate();
  const workMatch = matchPath('/runs/:workId', location.pathname);
  const selectedId = workMatch?.params.workId ?? null;
  const view = workMatch
    ? 'work'
    : [...navigation, ...legacyNavigation].find((item) => matchPath(item.path, location.pathname))?.id;
  const routeState = location.state as { form?: 'work' | 'project'; projectId?: string } | null;
  const [formState, setFormState] = useState<{ key: string; value: 'work' | 'project' | null } | null>(null);
  const form = formState?.key === location.key ? formState.value : (routeState?.form ?? null);
  const setForm = (value: 'work' | 'project' | null) => setFormState({ key: location.key, value });
  const newWorkProjectId = routeState?.projectId ?? '';
  const [draftState, setDraftState] = useState({ busy: false, dirty: false });
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
  const previousForm = useRef({ key: location.key, form });
  const selected =
    orders.find((order) => order.id === selectedId) ?? (detail?.id === selectedId ? detail.order : undefined);
  const detailError = detail?.id === selectedId ? detail.error : undefined;
  const detailReady = Boolean(selected || detailError);
  const hasSelection = Boolean(selected);

  useEffect(() => {
    const prior = previousForm.current;
    previousForm.current = { key: location.key, form };
    if (loading) return;
    if (!form && returnFocus.current?.isConnected) {
      returnFocus.current.focus({ preventScroll: true });
      returnFocus.current = null;
      return;
    }
    if (!form && prior.form && prior.key === location.key) return;
    const heading = mainContent.current?.querySelector<HTMLElement>(
      form ? 'dialog[open] h2' : selectedId && hasSelection ? '[data-focus-heading]' : 'h1',
    );
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [view, selectedId, form, loading, detailReady, hasSelection, location.key]);

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

  // Reads first and sets state after the response, so the mount effect does not set state synchronously.
  const fetchAll = useCallback(
    () =>
      Promise.all([api.projects(), api.work(), api.status()])
        .then(([nextProjects, nextOrders, nextStatus]) => {
          setProjects(nextProjects);
          setOrders(nextOrders);
          setStatus(nextStatus);
          setError('');
          setUpdated(new Date());
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) onLogout(err.message);
          else setError(message(err));
        })
        .finally(() => {
          setLoading(false);
          setRefreshing(false);
        }),
    [api, onLogout],
  );
  const reload = useCallback(() => {
    setRefreshing(true);
    return fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);
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
  const changeView = (next: View) => {
    returnFocus.current = null;
    setForm(null);
    void navigate([...navigation, ...legacyNavigation].find((item) => item.id === next)!.path);
  };
  const openWork = (order: WorkOrder) => {
    returnFocus.current = null;
    setForm(null);
    void navigate(runPath(order.id));
  };

  const sectionTitle =
    [...navigation, ...legacyNavigation].find((item) => item.id === view)?.label || 'Page not found';
  const paletteCommands: PaletteCommand[] = [
    ...navigation.map((item) => ({
      id: `go-${item.id}`,
      group: 'Go to' as const,
      label: item.label,
      icon: item.icon,
      run: () => changeView(item.id),
    })),
    ...orders.slice(0, 30).map((order) => ({
      id: `run-${order.id}`,
      group: 'Runs' as const,
      label: order.objective,
      hint: statusLabels[order.status] ?? order.status,
      icon: 'work' as const,
      run: () => openWork(order),
    })),
    {
      id: 'new-run',
      group: 'Actions' as const,
      label: 'New run',
      icon: 'plus' as const,
      run: () => void navigate('/runs', { state: { form: 'work' } }),
    },
    {
      id: 'refresh',
      group: 'Actions' as const,
      label: 'Refresh data',
      icon: 'refresh' as const,
      run: () => void reload(),
    },
    {
      id: 'sign-out',
      group: 'Actions' as const,
      label: 'Sign out',
      icon: 'logout' as const,
      run: () => void logout(),
    },
  ];

  return (
    <>
      <AppShell
        items={navigation}
        current={view}
        title={sectionTitle}
        pending={pending.length}
        connection={error ? 'interrupted' : loading ? 'connecting' : 'connected'}
        updated={updated}
        refreshing={refreshing}
        onRefresh={() => void reload()}
        loggingOut={loggingOut}
        onLogout={() => void logout()}
        onNavigate={() => {
          returnFocus.current = null;
        }}
        commands={paletteCommands}
        mainRef={mainContent}
      >
        <Suspense fallback={<LoadingState label="Loading section…" />}>
          {logoutError && (
            <div className="mb-5">
              <ErrorNotice>{logoutError}</ErrorNotice>
            </div>
          )}
          {error && (
            <Notice
              tone="danger"
              role="alert"
              className="mb-5"
              title="Data could not be refreshed."
              actions={
                <Button type="button" size="sm" onClick={() => void reload()} disabled={refreshing}>
                  Retry
                </Button>
              }
            >
              <p>{error} Visible data may be outdated.</p>
            </Notice>
          )}
          {loading ? (
            <LoadingState label="Connecting to the factory…" />
          ) : !updated ? (
            <EmptyState title="The factory could not be loaded">Check the connection and retry.</EmptyState>
          ) : (
            <>
              {view === 'work' && (!selectedId || selected) && (
                <>
                  {selected ? (
                    <section className="@container/run min-w-0" aria-label="Selected run">
                      <RunDetail
                        connected={!error}
                        key={selected.id}
                        api={api}
                        order={selected}
                        project={projects.find((project) => project.id === selected.project_id)}
                        cliMode={cliMode}
                        onChanged={reload}
                      />
                    </section>
                  ) : (
                    <RunsTable
                      api={api}
                      orders={orders}
                      projects={projects}
                      connected={!error}
                      onNew={() => setForm('work')}
                      onChanged={reload}
                    />
                  )}
                  <Dialog
                    open={form === 'work'}
                    onClose={() => setForm(null)}
                    title="New run"
                    busy={draftState.busy}
                    dirty={draftState.dirty}
                    description="Choose a registered flow, model bindings, acceptance checks and run limits. No work starts until you submit."
                  >
                    {form === 'work' && (
                      <CreateRunWizard
                        connected={!error}
                        onState={setDraftState}
                        api={api}
                        projects={projects}
                        initialProjectId={newWorkProjectId}
                        onDone={async (order) => {
                          setForm(null);
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
                  </Dialog>
                </>
              )}
              {view === 'work' && selectedId && !selected && (
                <>
                  <div className="grid justify-items-start gap-4">
                    <PageHeader
                      eyebrow="Run"
                      title={detailError ? 'Run unavailable' : 'Loading run'}
                      description={detailError || 'Reading the saved factory state.'}
                    />
                    {!detailError && <LoadingState label="Loading run…" />}
                    <Link className={buttonVariants({ variant: 'link', className: 'px-0' })} to="/runs">
                      ← All runs
                    </Link>
                  </div>
                </>
              )}
              {!view && (
                <>
                  <div className="grid justify-items-start gap-4">
                    <PageHeader
                      eyebrow="Navigation"
                      title="Page not found"
                      description="This address does not match a SABRE section."
                    />
                    <Link className={buttonVariants({ variant: 'secondary' })} to="/runs">
                      Go to runs
                    </Link>
                  </div>
                </>
              )}
              {view === 'projects' && (
                <ProjectsView
                  api={api}
                  projects={projects}
                  orders={orders}
                  connected={!error}
                  open={form === 'project'}
                  onOpenChange={(open, trigger) => {
                    if (open && trigger) returnFocus.current = trigger;
                    setForm(open ? 'project' : null);
                  }}
                  draftState={draftState}
                  onDraftState={setDraftState}
                  onRegistered={reload}
                  onCreateRun={(project) => {
                    returnFocus.current = null;
                    void navigate('/runs', { state: { form: 'work', projectId: project.id } });
                  }}
                />
              )}
              {view === 'security' && <SecurityView api={api} projects={projects} orders={orders} />}
              {view === 'memory' && <MemoryConsole api={api} projects={projects} connected={!error} />}
              {view === 'agents' && (
                <div className="grid gap-6">
                  <PageHeader
                    eyebrow="Specialists"
                    title="Agents"
                    description="Published specialists, versioned procedures and reviewed external agents."
                  />
                  <AgentsConsole api={api} projects={projects} connected={!error} />
                </div>
              )}
              {view === 'config' && (
                <ConfigConsole
                  key={location.search}
                  api={api}
                  projects={projects}
                  connected={!error}
                  onRefresh={reload}
                />
              )}
              {(view === 'settings' || view === 'tools') && (
                <div className="grid gap-6">
                  {view === 'settings' && (
                    <PageHeader
                      eyebrow="Factory capabilities"
                      title="Integrations"
                      description="Connect services, inspect their tools and control when SABRE may use them."
                    />
                  )}
                  {view === 'tools' ? (
                    <ToolsConsole
                      key={location.search}
                      api={api}
                      projects={projects}
                      connected={!error}
                      onRefresh={reload}
                    />
                  ) : (
                    <Integrations api={api} onChanged={reload} />
                  )}
                </div>
              )}
              {view === 'system' && (
                <div className="grid gap-6">
                  <PageHeader
                    eyebrow="Local instance"
                    title="About SABRE"
                    description="Observed status, installed versions and factory capacity."
                  />
                  <About api={api} />
                </div>
              )}
            </>
          )}
        </Suspense>
      </AppShell>
      <SupervisorConsole api={api} orders={orders} selectedId={selectedId} disconnected={Boolean(error)} />
    </>
  );
}

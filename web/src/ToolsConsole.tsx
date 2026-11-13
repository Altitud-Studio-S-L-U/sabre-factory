import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  type Api,
  type BuiltinToolCatalog,
  type IntegrationInfo,
  type MCPConnectionInfo,
  type MCPDiscovery,
  type Project,
  type ProjectToolsPolicy,
} from './api';
import Credentials from './Credentials';
import MCPConnections from './MCPConnections';
import Deliveries from './Deliveries';
import RepoCreations from './RepoCreations';
import GitHubRepositories from './features/tools/GitHubRepositories';
import Button from './components/Button';
import CheckField from './components/CheckField';
import DescriptionList from './components/DescriptionList';
import Dialog, { DialogActions } from './components/Dialog';
import EmptyState from './components/EmptyState';
import Field from './components/FormField';
import { SkeletonStatus, SkeletonTable } from './components/Skeletons';
import Notice from './components/Notice';
import PageHeader, { Eyebrow } from './components/PageHeader';
import Select from './components/Select';
import Tabs from './components/Tabs';
import { Badge } from './components/ui/badge';
import { cn } from './lib/utils';

const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'The connection could not be confirmed. Refresh before retrying.';
const family = (item: IntegrationInfo) =>
  item.kind === 'github'
    ? 'Registered API adapter'
    : item.kind === 'mcp'
      ? 'Outbound MCP'
      : item.kind === 'model'
        ? 'Model provider'
        : 'Notifications';
const categories = [
  ['all', 'All connections'],
  ['builtin', 'Built-in tools'],
  ['github', 'Repository & delivery'],
  ['mcp', 'MCP'],
  ['slack', 'Notifications'],
] as const;
const inspectorTabs = ['Overview', 'Access', 'Credentials', 'Diagnostics'] as const;
type InspectorTab = (typeof inspectorTabs)[number];
const deepLinks = ['github.read', 'github.publish'];
/** Term and value side by side once the inspector is wider than a phone. */
const inspectorList = '@xs:[&>div]:grid-cols-[var(--term-width)_minmax(0,1fr)] @xs:[&>div]:gap-4';

/** A row of the connection catalog: selectable card with a status badge on the right. */
function CatalogRow({
  eyebrow,
  title,
  details,
  badge,
  pressed,
  onClick,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  details: ReactNode[];
  badge: ReactNode;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'grid w-full min-w-0 cursor-pointer touch-manipulation grid-cols-[minmax(0,1fr)_auto] items-start gap-4 rounded-lg border border-border bg-card px-4 py-3.5 text-left transition-colors',
        'hover:bg-hover/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'aria-pressed:border-primary/60 aria-pressed:bg-accent',
      )}
    >
      <span className="grid min-w-0 gap-1">
        <Eyebrow>{eyebrow}</Eyebrow>
        <strong className="text-base font-semibold [overflow-wrap:anywhere]">{title}</strong>
        {details.map((detail, index) => (
          <span
            key={index}
            className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
          >
            {detail}
          </span>
        ))}
      </span>
      {badge}
    </button>
  );
}

export interface ToolsConsoleProps {
  api: Api;
  projects: Project[];
  connected?: boolean;
  onRefresh?: () => Promise<void>;
  onError?: (message: string) => void;
}

export default function ToolsConsole({ api, projects, connected = true, onRefresh }: ToolsConsoleProps) {
  const [requestedConnection] = useState(() => new URLSearchParams(window.location.search).get('connection'));
  const connectionOpened = useRef(false);
  const [items, setItems] = useState<IntegrationInfo[]>([]);
  const [servers, setServers] = useState<MCPConnectionInfo[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinToolCatalog['items']>([]);
  const [selectedBuiltin, setSelectedBuiltin] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState<InspectorTab>('Overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ name: string | null } | null>(() =>
    new URLSearchParams(window.location.search).get('setup') === 'mcp' ? { name: null } : null,
  );
  const [projectDialog, setProjectDialog] = useState(false);
  const [repositories, setRepositories] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [policy, setPolicy] = useState<ProjectToolsPolicy | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [diagnostic, setDiagnostic] = useState<MCPDiscovery | null>(null);
  const policyRequest = useRef(0);
  // State is applied in promise callbacks, so the mount effect never sets state synchronously.
  const fetchCatalog = useCallback(
    () =>
      Promise.all([api.integrations(), api.mcpConnections(), api.toolsCatalog()])
        .then(
          ([connections, mcp, catalog]) => {
            const visible = connections.filter((item) => item.kind !== 'model');
            setItems(visible);
            setServers(mcp);
            setBuiltins(catalog.items);
            // A deep link opens its connection once, after the catalog confirms it exists.
            if (
              !connectionOpened.current &&
              requestedConnection &&
              deepLinks.includes(requestedConnection) &&
              visible.some((item) => item.id === requestedConnection)
            ) {
              connectionOpened.current = true;
              setSelectedId(requestedConnection);
              setFilter('github');
              setTab('Credentials');
              setNotice(
                'Configure this connection in its credential dialog. Opening this page does not save credentials or grant execution permissions.',
              );
            }
          },
          (reason: unknown) => setError(failure(reason)),
        )
        .finally(() => setLoading(false)),
    [api, requestedConnection],
  );
  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);
  const load = async () => {
    setLoading(true);
    setError('');
    await fetchCatalog();
  };
  const chooseProject = (id: string) => {
    const request = ++policyRequest.current;
    setProjectId(id);
    setPolicy(null);
    if (!id) return;
    void api
      .projectTools(id)
      .then((value) => {
        if (policyRequest.current !== request) return;
        setPolicy(value);
        setAllowed(value.servers);
      })
      .catch((reason) => {
        if (policyRequest.current === request) setError(failure(reason));
      });
  };
  const filtered = items.filter((item) => filter === 'all' || item.kind === filter);
  const selected = items.find((item) => item.id === selectedId) ?? filtered[0];
  const builtin =
    builtins.find((item) => item.name === selectedBuiltin) ??
    (filter === 'builtin' ? builtins[0] : undefined);
  const server =
    selected?.kind === 'mcp'
      ? servers.find(
          (value) =>
            selected.credential_ids.includes(value.credential_id) || selected.id === `mcp.${value.name}`,
        )
      : undefined;
  const changed = async () => {
    await load();
    await onRefresh?.();
  };
  const toggle = async () => {
    if (!selected || busy || !connected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.setIntegrationState(selected.id, {
        enabled: !selected.enabled,
        expected_revision: selected.revision,
      });
      setItems((current) => current.map((item) => (item.id === next.id ? next : item)));
      setNotice(
        `${next.title}: ${next.enabled ? 'enabled for authorized calls' : 'new calls blocked; calls in progress may finish'}.`,
      );
      await onRefresh?.();
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const diagnose = async () => {
    if (!server || !connected || busy) return;
    setBusy(true);
    setError('');
    setDiagnostic(null);
    try {
      setDiagnostic(await api.discoverMCPTools(server.name, server.revision));
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const footnote = 'text-xs leading-relaxed text-muted-foreground';
  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        eyebrow="Capabilities & access"
        title="Tools"
        description="Inspect connections, credentials and scoped permissions. A connection alone never grants execution access."
        actions={
          <>
            <Button type="button" variant="secondary" disabled={loading || busy} onClick={() => void load()}>
              Refresh
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!connected}
              onClick={() => setEditor({ name: null })}
            >
              Add MCP connection
            </Button>
          </>
        }
      />
      {(!connected || error || notice) && (
        <div className="grid gap-2">
          {!connected && (
            <Notice tone="warning" role="status">
              Disconnected. Showing the last loaded state; connection changes are unavailable.
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
        </div>
      )}
      <div
        role="group"
        aria-label="Connection categories"
        className="flex w-full max-w-full gap-0.5 justify-self-start overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-secondary p-1 [scrollbar-width:thin] sm:w-auto"
      >
        {categories.map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={filter === id}
            onClick={() => {
              setFilter(id);
              setSelectedId('');
              setSelectedBuiltin('');
              setDiagnostic(null);
            }}
            className="min-h-8 shrink-0 cursor-pointer touch-manipulation rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {label}
          </button>
        ))}
      </div>
      {loading && !items.length && (
        <SkeletonStatus label="Loading registered connections…">
          <SkeletonTable rows={4} columns={['title', 'badge', 'text', 'mono']} />
        </SkeletonStatus>
      )}
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,1fr)]">
        <div role="group" aria-label="Connection catalog" className="grid min-w-0 gap-2">
          {filtered.map((item) => (
            <CatalogRow
              key={item.id}
              pressed={!builtin && selected?.id === item.id}
              onClick={() => {
                setSelectedId(item.id);
                setSelectedBuiltin('');
                setTab('Overview');
                setDiagnostic(null);
              }}
              eyebrow={family(item)}
              title={item.title}
              details={[
                item.description,
                `${item.tools.length} registered tools · ${
                  item.credential_ids.length
                    ? item.credential_configured
                      ? 'Credential present'
                      : 'Credential missing'
                    : 'No stored credential required'
                }`,
              ]}
              badge={
                <Badge variant={item.enabled ? 'success' : 'warning'}>
                  {item.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              }
            />
          ))}
          {filter === 'all' && builtins.length > 0 && (
            <CatalogRow
              onClick={() => {
                setFilter('builtin');
                setSelectedBuiltin(builtins[0].name);
              }}
              eyebrow="Factory capabilities"
              title="Built-in tools"
              details={[
                `${builtins.length} registered tools with specialist and run restrictions. Inspect their contracts and role bindings.`,
              ]}
              badge={<Badge variant="outline">Inspect</Badge>}
            />
          )}
          {filter === 'builtin' &&
            builtins.map((item) => (
              <CatalogRow
                key={item.name}
                pressed={builtin?.name === item.name}
                onClick={() => {
                  setSelectedBuiltin(item.name);
                  setTab('Overview');
                }}
                eyebrow={`Built-in · ${item.scope}`}
                title={item.name}
                details={[item.description, item.roles.join(' · ')]}
                badge={<Badge variant="outline">{item.effect.replaceAll('_', ' ')}</Badge>}
              />
            ))}
          {!loading && !filtered.length && !(['all', 'builtin'].includes(filter) && builtins.length) && (
            <EmptyState as="h2" title="No connections in this category">
              Add an MCP endpoint to review an external tool manifest. Direct APIs use adapters registered by
              the factory.
            </EmptyState>
          )}
          <p className={cn(footnote, 'mt-1')}>
            Built-in repository tools are governed by specialist and run permissions. Model connections are
            managed in Config.
          </p>
        </div>
        <aside
          aria-label="Connection inspector"
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 rounded-lg border border-border bg-card p-5 lg:sticky lg:top-4"
        >
          {builtin ? (
            <>
              <Eyebrow>Built-in capability</Eyebrow>
              <div className="grid gap-1.5">
                <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{builtin.name}</h2>
                <p className="text-sm text-muted-foreground">{builtin.description}</p>
              </div>
              <DescriptionList
                termWidth="7rem"
                className={inspectorList}
                items={[
                  ['Source', 'Registered factory tool'],
                  ['Effect', builtin.effect.replaceAll('_', ' ')],
                  ['Scope', builtin.scope],
                  ['Specialists', builtin.roles.join(' · ')],
                  ['Credential', 'No external credential binding'],
                ]}
              />
              <p className={footnote}>
                The active run resolves effective access against specialist, project and run policy. Built-in
                tools are not granted globally by this view.
              </p>
            </>
          ) : selected ? (
            <>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <Eyebrow>Connection inspector</Eyebrow>
                <Badge variant="outline">Revision {selected.revision}</Badge>
              </div>
              <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{selected.title}</h2>
              <Tabs
                className="min-w-0 [&>[role=tabpanel]]:px-0 [&>[role=tabpanel]]:pb-0"
                label="Connection details"
                items={inspectorTabs.map((value) => ({ value, label: value }))}
                value={tab}
                onChange={setTab}
              >
                {(current) => (
                  <div className="grid min-w-0 gap-4 pt-1">
                    {current === 'Overview' && (
                      <>
                        <p className="text-sm">{selected.description}</p>
                        <DescriptionList
                          termWidth="7rem"
                          className={inspectorList}
                          items={[
                            ['Adapter', family(selected)],
                            [
                              'Availability',
                              selected.enabled
                                ? 'Enabled; reachability not checked'
                                : 'Disabled for new calls',
                            ],
                            [
                              'Credential',
                              selected.credential_ids.length
                                ? selected.credential_configured
                                  ? 'Configured · value never retrieved'
                                  : 'Not configured'
                                : 'Managed by the instance',
                            ],
                            server && [
                              'Endpoint',
                              <code key="endpoint" className="font-mono text-xs">
                                {server.endpoint}
                              </code>,
                            ],
                            server && [
                              'Contracts',
                              `${Object.keys(server.tool_digests).length} reviewed manifests`,
                            ],
                            ['Scope', selected.access],
                          ]}
                        />
                        {(selected.toggleable ||
                          server?.source === 'dynamic' ||
                          selected.kind === 'github') && (
                          <div className="flex flex-wrap gap-2">
                            {selected.toggleable && (
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={busy || !connected}
                                onClick={() => void toggle()}
                              >
                                {busy
                                  ? 'Saving…'
                                  : selected.enabled
                                    ? 'Disable connection'
                                    : 'Enable connection'}
                              </Button>
                            )}
                            {server?.source === 'dynamic' && (
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={!connected}
                                onClick={() => setEditor({ name: server.name })}
                              >
                                Edit connection
                              </Button>
                            )}
                            {selected.kind === 'github' && (
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => setRepositories(true)}
                                disabled={!connected}
                              >
                                Browse repositories
                              </Button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                    {current === 'Access' && (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Effective access requires an enabled connection, its required credential, a reviewed
                          contract and matching specialist, project and run permissions.
                        </p>
                        {selected.tools.length ? (
                          <ul className="divide-y divide-border rounded-lg border border-border">
                            {selected.tools.map((tool) => (
                              <li
                                key={tool.name}
                                className="flex min-w-0 items-start justify-between gap-4 px-3.5 py-3"
                              >
                                <div className="grid min-w-0 gap-0.5">
                                  <code className="font-mono text-xs [overflow-wrap:anywhere]">
                                    {tool.name}
                                  </code>
                                  <small className="text-xs text-muted-foreground">
                                    {tool.roles.length ? tool.roles.join(' · ') : 'No role grant listed'}
                                  </small>
                                </div>
                                <Badge variant="outline">{tool.effect.replaceAll('_', ' ')}</Badge>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No authorized tools are registered for this connection.
                          </p>
                        )}
                        {server && (
                          <Button
                            type="button"
                            variant="secondary"
                            className="justify-self-start"
                            disabled={!connected}
                            onClick={() => setProjectDialog(true)}
                          >
                            Review project access
                          </Button>
                        )}
                        <p className={footnote}>
                          Enabling a connection does not expand any project or run grant.
                        </p>
                      </>
                    )}
                    {current === 'Credentials' &&
                      (selected.credential_ids.length ? (
                        <Credentials
                          key={selected.id}
                          api={api}
                          onChanged={changed}
                          targetIds={selected.credential_ids}
                          connected={connected}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          This connection has no credential destination registered in the panel.
                        </p>
                      ))}
                    {current === 'Diagnostics' && (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Diagnostics inspect connection metadata and catalogs. They do not execute business
                          tools or prove effective authorization.
                        </p>
                        {server ? (
                          <>
                            <Button
                              type="button"
                              variant="secondary"
                              className="justify-self-start"
                              disabled={busy || !connected}
                              onClick={() => void diagnose()}
                            >
                              {busy ? 'Checking catalog…' : 'Inspect remote manifest'}
                            </Button>
                            {diagnostic && (
                              <div className="grid gap-3 border-t border-border pt-4">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="success">Catalog received</Badge>
                                  <p className="text-sm">
                                    Revision {diagnostic.connection_revision} · {diagnostic.tools.length}{' '}
                                    advertised tools
                                    {diagnostic.truncated ? ' · bounded result truncated' : ''}.
                                  </p>
                                </div>
                                {diagnostic.tools.map((tool) => (
                                  <div
                                    key={tool.name}
                                    className="grid gap-1 rounded-lg border border-border px-3.5 py-3"
                                  >
                                    <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">
                                      {tool.name}
                                    </h3>
                                    <p className="text-sm text-muted-foreground">{tool.description}</p>
                                    <p className={footnote}>
                                      {server.tool_digests[tool.name] === tool.manifest_digest
                                        ? 'Matches the reviewed manifest.'
                                        : 'Not approved or manifest changed. Review before access.'}
                                    </p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <DescriptionList
                              termWidth="9rem"
                              className={inspectorList}
                              items={[
                                ['Enabled', selected.enabled ? 'Yes' : 'No'],
                                [
                                  'Credential present',
                                  selected.credential_configured ? 'Yes; validity not tested' : 'No',
                                ],
                                ['Registered tools', selected.tools.length],
                              ]}
                            />
                            <p className="text-sm text-muted-foreground">
                              This registered adapter has no non-mutating remote diagnostic in the panel.
                            </p>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </Tabs>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a connection to inspect its access and provenance.
            </p>
          )}
        </aside>
      </div>
      {/* Outbound work that uses these connections: new repositories and owner notifications. */}
      <div className="grid min-w-0 gap-4 border-t border-border pt-8">
        <RepoCreations api={api} />
      </div>
      <div className="grid min-w-0 gap-4 border-t border-border pt-8">
        <Deliveries api={api} />
      </div>
      {editor && (
        <MCPConnections
          api={api}
          onChanged={changed}
          compact
          initialConnection={editor.name}
          onEditorClose={() => setEditor(null)}
          connected={connected}
        />
      )}
      <Dialog
        open={projectDialog}
        title="Project tool access"
        description="Select only the projects that need this connection. Changes use the current policy revision."
        busy={busy}
        dirty={!!policy && JSON.stringify(allowed) !== JSON.stringify(policy.servers)}
        onClose={() => setProjectDialog(false)}
      >
        <div className="grid gap-5">
          <Field label="Project">
            <Select value={projectId} onChange={(event) => chooseProject(event.target.value)} disabled={busy}>
              <option value="">Choose a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
          {policy && (
            <form
              className="grid gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!connected || busy) return;
                setBusy(true);
                setError('');
                void api
                  .setProjectTools(policy.project_id, {
                    expected_revision: policy.revision,
                    servers: allowed,
                  })
                  .then((value) => {
                    setPolicy(value);
                    setAllowed(value.servers);
                    setNotice('Project tool permissions saved. Connection activation remains separate.');
                  })
                  .catch((reason) => setError(failure(reason)))
                  .finally(() => setBusy(false));
              }}
            >
              <fieldset disabled={busy || !connected} className="grid min-w-0 gap-2.5">
                <legend className="mb-2.5 text-sm font-medium">Allowed MCP servers</legend>
                {servers.map((item) => (
                  <CheckField
                    key={item.name}
                    label={item.name}
                    checked={allowed.includes(item.name)}
                    onChange={(event) =>
                      setAllowed((current) =>
                        event.target.checked
                          ? [...current, item.name]
                          : current.filter((name) => name !== item.name),
                      )
                    }
                  />
                ))}
              </fieldset>
              <DialogActions>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || !connected || JSON.stringify(allowed) === JSON.stringify(policy.servers)}
                >
                  Save project access
                </Button>
              </DialogActions>
            </form>
          )}
        </div>
      </Dialog>
      <Dialog
        open={repositories}
        title="GitHub repositories"
        description="Repository access is independent of model provider authentication."
        onClose={() => setRepositories(false)}
      >
        <GitHubRepositories
          api={api}
          enabled={connected && !!items.find((item) => item.id === 'github.read')?.enabled}
          onChanged={async () => {
            await onRefresh?.();
          }}
        />
      </Dialog>
    </div>
  );
}

import Button from './components/Button';
import Input from './components/Input';
import { useCallback, useEffect, useState } from 'react';
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
import { GitHubRepositories } from './Integrations';
import Dialog from './components/Dialog';
import Field from './components/FormField';
import Select from './components/Select';
import './ConsoleSections.css';

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
export interface ToolsConsoleProps {
  api: Api;
  projects: Project[];
  connected?: boolean;
  onRefresh?: () => Promise<void>;
  onError?: (message: string) => void;
}

export default function ToolsConsole({ api, projects, connected = true, onRefresh }: ToolsConsoleProps) {
  const [requestedConnection] = useState(() => new URLSearchParams(window.location.search).get('connection'));
  const [connectionOpened, setConnectionOpened] = useState(false);
  const [items, setItems] = useState<IntegrationInfo[]>([]);
  const [servers, setServers] = useState<MCPConnectionInfo[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinToolCatalog['items']>([]);
  const [selectedBuiltin, setSelectedBuiltin] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('Overview');
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
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [connections, mcp, catalog] = await Promise.all([
        api.integrations(),
        api.mcpConnections(),
        api.toolsCatalog(),
      ]);
      setItems(connections.filter((item) => item.kind !== 'model'));
      setServers(mcp);
      setBuiltins(catalog.items);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (
      connectionOpened ||
      !requestedConnection ||
      !['github.read', 'github.publish'].includes(requestedConnection)
    )
      return;
    if (!items.some((item) => item.id === requestedConnection)) return;
    setSelectedId(requestedConnection);
    setFilter('github');
    setTab('Credentials');
    setNotice(
      'Configure this connection in its credential dialog. Opening this page does not save credentials or grant execution permissions.',
    );
    setConnectionOpened(true);
  }, [connectionOpened, requestedConnection, items]);
  useEffect(() => {
    let active = true;
    setPolicy(null);
    if (projectId)
      void api
        .projectTools(projectId)
        .then((value) => {
          if (active) {
            setPolicy(value);
            setAllowed(value.servers);
          }
        })
        .catch((reason) => {
          if (active) setError(failure(reason));
        });
    return () => {
      active = false;
    };
  }, [api, projectId]);
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
  return (
    <div className="operator-page">
      <header className="operator-heading">
        <div>
          <span className="operator-eyebrow">Capabilities & access</span>
          <h1>Tools</h1>
          <p>
            Inspect connections, credentials and scoped permissions. A connection alone never grants execution
            access.
          </p>
        </div>
        <div className="operator-actions">
          <Button className="button" disabled={loading || busy} onClick={() => void load()}>
            Refresh
          </Button>
          <Button className="button primary" disabled={!connected} onClick={() => setEditor({ name: null })}>
            Add MCP connection
          </Button>
        </div>
      </header>
      {!connected && (
        <p className="notice warning" role="status">
          Disconnected. Showing the last loaded state; connection changes are unavailable.
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
      <div className="operator-tabs" aria-label="Connection categories">
        {[
          ['all', 'All connections'],
          ['builtin', 'Built-in tools'],
          ['github', 'Repository & delivery'],
          ['mcp', 'MCP'],
          ['slack', 'Notifications'],
        ].map(([id, label]) => (
          <Button
            key={id}
            aria-pressed={filter === id}
            onClick={() => {
              setFilter(id);
              setSelectedId('');
              setSelectedBuiltin('');
              setDiagnostic(null);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {loading && !items.length && (
        <div className="operator-panel" role="status">
          Loading registered connections…
        </div>
      )}
      <div className="operator-split">
        <div className="operator-catalog" aria-label="Connection catalog">
          {filtered.map((item) => (
            <Button
              className="operator-catalog-row"
              key={item.id}
              aria-pressed={!builtin && selected?.id === item.id}
              onClick={() => {
                setSelectedId(item.id);
                setSelectedBuiltin('');
                setTab('Overview');
                setDiagnostic(null);
              }}
            >
              <div>
                <span className="operator-eyebrow">{family(item)}</span>
                <strong style={{ display: 'block', marginTop: 6 }}>{item.title}</strong>
                <small>{item.description}</small>
                <small>
                  {item.tools.length} registered tools ·{' '}
                  {item.credential_ids.length
                    ? item.credential_configured
                      ? 'Credential present'
                      : 'Credential missing'
                    : 'No stored credential required'}
                </small>
              </div>
              <span className={`operator-tag ${item.enabled ? 'good' : 'warning'}`}>
                {item.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </Button>
          ))}
          {filter === 'all' && builtins.length > 0 && (
            <Button
              className="operator-catalog-row"
              onClick={() => {
                setFilter('builtin');
                setSelectedBuiltin(builtins[0].name);
              }}
            >
              <div>
                <span className="operator-eyebrow">Factory capabilities</span>
                <strong style={{ display: 'block', marginTop: 6 }}>Built-in tools</strong>
                <small>
                  {builtins.length} registered tools with specialist and run restrictions. Inspect their
                  contracts and role bindings.
                </small>
              </div>
              <span className="operator-tag">Inspect</span>
            </Button>
          )}
          {filter === 'builtin' &&
            builtins.map((item) => (
              <Button
                className="operator-catalog-row"
                key={item.name}
                aria-pressed={builtin?.name === item.name}
                onClick={() => {
                  setSelectedBuiltin(item.name);
                  setTab('Overview');
                }}
              >
                <div>
                  <span className="operator-eyebrow">Built-in · {item.scope}</span>
                  <strong style={{ display: 'block', marginTop: 6 }}>{item.name}</strong>
                  <small>{item.description}</small>
                  <small>{item.roles.join(' · ')}</small>
                </div>
                <span className="operator-tag">{item.effect.replaceAll('_', ' ')}</span>
              </Button>
            ))}
          {!loading && !filtered.length && !(['all', 'builtin'].includes(filter) && builtins.length) && (
            <div className="operator-empty">
              <h2>No connections in this category</h2>
              <p>
                Add an MCP endpoint to review an external tool manifest. Direct APIs use adapters registered
                by the factory.
              </p>
            </div>
          )}
          <p className="operator-readonly">
            Built-in repository tools are governed by specialist and run permissions. Model connections are
            managed in Config.
          </p>
        </div>
        <aside className="operator-panel operator-sticky" aria-label="Connection inspector">
          {builtin ? (
            <>
              <span className="operator-eyebrow">Built-in capability</span>
              <h2 style={{ marginTop: 16 }}>{builtin.name}</h2>
              <p>{builtin.description}</p>
              <dl className="operator-kv">
                <dt>Source</dt>
                <dd>Registered factory tool</dd>
                <dt>Effect</dt>
                <dd>{builtin.effect.replaceAll('_', ' ')}</dd>
                <dt>Scope</dt>
                <dd>{builtin.scope}</dd>
                <dt>Specialists</dt>
                <dd>{builtin.roles.join(' · ')}</dd>
                <dt>Credential</dt>
                <dd>No external credential binding</dd>
              </dl>
              <p className="operator-readonly">
                The active run resolves effective access against specialist, project and run policy. Built-in
                tools are not granted globally by this view.
              </p>
            </>
          ) : selected ? (
            <>
              <div className="operator-actions" style={{ justifyContent: 'space-between' }}>
                <span className="operator-eyebrow">Connection inspector</span>
                <span className="operator-tag">Revision {selected.revision}</span>
              </div>
              <h2 style={{ marginTop: 16 }}>{selected.title}</h2>
              <div className="operator-tabs" aria-label="Connection details">
                {['Overview', 'Access', 'Credentials', 'Diagnostics'].map((name) => (
                  <Button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>
                    {name}
                  </Button>
                ))}
              </div>
              {tab === 'Overview' && (
                <>
                  <p>{selected.description}</p>
                  <dl className="operator-kv">
                    <dt>Adapter</dt>
                    <dd>{family(selected)}</dd>
                    <dt>Availability</dt>
                    <dd>
                      {selected.enabled ? 'Enabled; reachability not checked' : 'Disabled for new calls'}
                    </dd>
                    <dt>Credential</dt>
                    <dd>
                      {selected.credential_ids.length
                        ? selected.credential_configured
                          ? 'Configured · value never retrieved'
                          : 'Not configured'
                        : 'Managed by the instance'}
                    </dd>
                    {server && (
                      <>
                        <dt>Endpoint</dt>
                        <dd>
                          <code>{server.endpoint}</code>
                        </dd>
                        <dt>Contracts</dt>
                        <dd>{Object.keys(server.tool_digests).length} reviewed manifests</dd>
                      </>
                    )}
                    <dt>Scope</dt>
                    <dd>{selected.access}</dd>
                  </dl>
                  <div className="operator-actions">
                    {selected.toggleable && (
                      <Button className="button" disabled={busy || !connected} onClick={() => void toggle()}>
                        {busy ? 'Saving…' : selected.enabled ? 'Disable connection' : 'Enable connection'}
                      </Button>
                    )}
                    {server?.source === 'dynamic' && (
                      <Button
                        className="button"
                        disabled={!connected}
                        onClick={() => setEditor({ name: server.name })}
                      >
                        Edit connection
                      </Button>
                    )}
                    {selected.kind === 'github' && (
                      <Button className="button" onClick={() => setRepositories(true)} disabled={!connected}>
                        Browse repositories
                      </Button>
                    )}
                  </div>
                </>
              )}
              {tab === 'Access' && (
                <>
                  <p>
                    Effective access requires an enabled connection, its required credential, a reviewed
                    contract and matching specialist, project and run permissions.
                  </p>
                  <ul className="operator-checks">
                    {selected.tools.map((tool) => (
                      <li key={tool.name}>
                        <div>
                          <code>{tool.name}</code>
                          <small>{tool.roles.length ? tool.roles.join(' · ') : 'No role grant listed'}</small>
                        </div>
                        <span className="operator-tag">{tool.effect.replaceAll('_', ' ')}</span>
                      </li>
                    ))}
                  </ul>
                  {!selected.tools.length && (
                    <p className="muted">No authorized tools are registered for this connection.</p>
                  )}
                  {server && (
                    <Button
                      className="button"
                      style={{ marginTop: 18 }}
                      disabled={!connected}
                      onClick={() => setProjectDialog(true)}
                    >
                      Review project access
                    </Button>
                  )}
                  <p className="operator-readonly">
                    Enabling a connection does not expand any project or run grant.
                  </p>
                </>
              )}
              {tab === 'Credentials' &&
                (selected.credential_ids.length ? (
                  <Credentials
                    key={selected.id}
                    api={api}
                    onChanged={changed}
                    targetIds={selected.credential_ids}
                    connected={connected}
                  />
                ) : (
                  <p>This connection has no credential destination registered in the panel.</p>
                ))}
              {tab === 'Diagnostics' && (
                <>
                  <p>
                    Diagnostics inspect connection metadata and catalogs. They do not execute business tools
                    or prove effective authorization.
                  </p>
                  {server ? (
                    <>
                      <Button
                        className="button"
                        disabled={busy || !connected}
                        onClick={() => void diagnose()}
                      >
                        {busy ? 'Checking catalog…' : 'Inspect remote manifest'}
                      </Button>
                      {diagnostic && (
                        <div className="operator-section-divider">
                          <span className="operator-tag good">Catalog received</span>
                          <p>
                            Revision {diagnostic.connection_revision} · {diagnostic.tools.length} advertised
                            tools{diagnostic.truncated ? ' · bounded result truncated' : ''}.
                          </p>
                          {diagnostic.tools.map((tool) => (
                            <div key={tool.name}>
                              <h3>{tool.name}</h3>
                              <p>{tool.description}</p>
                              <p className="operator-readonly">
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
                      <dl className="operator-kv">
                        <dt>Enabled</dt>
                        <dd>{selected.enabled ? 'Yes' : 'No'}</dd>
                        <dt>Credential present</dt>
                        <dd>{selected.credential_configured ? 'Yes; validity not tested' : 'No'}</dd>
                        <dt>Registered tools</dt>
                        <dd>{selected.tools.length}</dd>
                      </dl>
                      <p className="muted">
                        This registered adapter has no non-mutating remote diagnostic in the panel.
                      </p>
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <p>Select a connection to inspect its access and provenance.</p>
          )}
        </aside>
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
        <Field label="Project">
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={busy}>
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
            onSubmit={(event) => {
              event.preventDefault();
              if (!connected || busy) return;
              setBusy(true);
              setError('');
              void api
                .setProjectTools(policy.project_id, { expected_revision: policy.revision, servers: allowed })
                .then((value) => {
                  setPolicy(value);
                  setAllowed(value.servers);
                  setNotice('Project tool permissions saved. Connection activation remains separate.');
                })
                .catch((reason) => setError(failure(reason)))
                .finally(() => setBusy(false));
            }}
          >
            <fieldset disabled={busy || !connected}>
              <legend>Allowed MCP servers</legend>
              {servers.map((item) => (
                <label className="check-line" key={item.name}>
                  <Input
                    type="checkbox"
                    checked={allowed.includes(item.name)}
                    onChange={(event) =>
                      setAllowed((current) =>
                        event.target.checked
                          ? [...current, item.name]
                          : current.filter((name) => name !== item.name),
                      )
                    }
                  />
                  {item.name}
                </label>
              ))}
            </fieldset>
            <Button
              className="button primary"
              disabled={busy || !connected || JSON.stringify(allowed) === JSON.stringify(policy.servers)}
            >
              Save project access
            </Button>
          </form>
        )}
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

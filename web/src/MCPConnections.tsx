import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  type Api,
  type MCPConnectionInfo,
  type MCPDiscovery,
  type MCPToolSettings,
  type Project,
  type ProjectToolsPolicy,
} from './api';
import Field from './components/FormField';
import Select from './components/Select';
import Dialog from './components/Dialog';

const roles = {
  supervisor: 'Supervisor',
  analyst: 'Analyst',
  architect: 'Architecture',
  developer: 'Development',
  qa: 'Verification',
  reviewer: 'Review',
  security: 'Security',
} as const;
type Role = keyof typeof roles;
const failure = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : 'The operation could not be confirmed. Refresh the connection before continuing.';

export default function MCPConnections({
  api,
  onChanged,
  compact = false,
  initialConnection,
  onEditorClose,
  connected = true,
}: {
  api: Api;
  onChanged: () => Promise<void>;
  compact?: boolean;
  initialConnection?: string | null;
  onEditorClose?: () => void;
  connected?: boolean;
}) {
  const [items, setItems] = useState<MCPConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState<MCPConnectionInfo | null>(null);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [discovery, setDiscovery] = useState<MCPDiscovery | null>(null);
  const [policies, setPolicies] = useState<Record<string, MCPToolSettings>>({});
  const [digests, setDigests] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.mcpConnections());
      setError('');
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
    if (!compact || loading) return;
    const item = items.find((value) => value.name === initialConnection) ?? null;
    setCurrent(item);
    setName(item?.name || '');
    setEndpoint(item?.endpoint || '');
    setPolicies(item?.tools || {});
    setDigests(item?.tool_digests || {});
    setDiscovery(null);
    setEditing(true);
  }, [compact, initialConnection, loading, items]);
  const choose = (item: MCPConnectionInfo | null) => {
    setCurrent(item);
    setName(item?.name || '');
    setEndpoint(item?.endpoint || '');
    setPolicies(item?.tools || {});
    setDigests(item?.tool_digests || {});
    setDiscovery(null);
    setError('');
    setNotice('');
    setEditing(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !connected) return;
    setBusy(true);
    setError('');
    setNotice('');
    const changedEndpoint = !!current && endpoint !== current.endpoint;
    try {
      const next = await api.saveMCPConnection(name, {
        endpoint,
        expected_revision: current?.revision || 0,
        tools: changedEndpoint ? {} : policies,
        tool_digests: changedEndpoint ? {} : digests,
      });
      setCurrent(next);
      setEndpoint(next.endpoint);
      setPolicies(next.tools);
      setDigests(next.tool_digests);
      setDiscovery(null);
      setNotice('Connection saved and disabled. Review tools and project access before enabling it.');
      await load();
      await onChanged();
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const discover = async () => {
    if (busy || !current || !connected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.discoverMCPTools(current.name, current.revision);
      setDiscovery(result);
      const valid = result.tools.filter((tool) => current.tool_digests[tool.name] === tool.manifest_digest);
      setPolicies(
        Object.fromEntries(
          valid
            .filter((tool) => current.tools[tool.name])
            .map((tool) => [tool.name, current.tools[tool.name]]),
        ),
      );
      setDigests(
        Object.fromEntries(
          valid.filter((tool) => current.tools[tool.name]).map((tool) => [tool.name, tool.manifest_digest]),
        ),
      );
    } catch (reason) {
      setDiscovery(null);
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const setRole = (tool: string, digest: string, role: Role, checked: boolean) => {
    const previous = policies[tool]?.roles || [];
    const selected = checked ? [...new Set([...previous, role])] : previous.filter((value) => value !== role);
    setPolicies((old) => {
      const next = { ...old };
      if (selected.length)
        next[tool] = { roles: selected, effect: 'read', timeout_s: old[tool]?.timeout_s || 60 };
      else delete next[tool];
      return next;
    });
    setDigests((old) => {
      const next = { ...old };
      if (selected.length) next[tool] = digest;
      else delete next[tool];
      return next;
    });
  };
  return (
    <section className="integration-section" aria-labelledby="mcp-connections-title">
      {!compact && (
        <>
          <div className="section-heading">
            <div>
              <h2 id="mcp-connections-title">MCP servers</h2>
              <p className="muted">
                Connect external tools and choose which roles and projects may use them.
              </p>
            </div>
            <div className="integration-actions">
              <button className="button small" disabled={loading || busy} onClick={() => void load()}>
                Refresh servers
              </button>
              <button className="button primary" disabled={busy} onClick={() => choose(null)}>
                Add MCP server
              </button>
            </div>
          </div>
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
          {loading && !items.length && <p role="status">Loading servers…</p>}
          {!loading && !items.length && <p className="muted">No MCP servers registered yet.</p>}
          <ul className="repository-list">
            {items.map((item) => (
              <li key={item.name}>
                <div>
                  <strong>{item.name}</strong>
                  <span className="muted connection-endpoint">{item.endpoint}</span>
                  <span className="muted">
                    {Object.keys(item.tools).length} authorized tools ·{' '}
                    {item.source === 'static' ? 'Instance configuration' : `Review ${item.revision}`}
                  </span>
                </div>
                {item.source === 'dynamic' && (
                  <button
                    className="button small"
                    disabled={busy}
                    onClick={() => choose(item)}
                    aria-label={`Configure MCP ${item.name}`}
                  >
                    Configure
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <Dialog
        open={editing}
        title={current ? `Configure ${current.name}` : 'Add MCP server'}
        description="Review the endpoint and tool contracts before granting scoped access."
        busy={busy}
        dirty={
          endpoint !== (current?.endpoint || '') ||
          name !== (current?.name || '') ||
          JSON.stringify(policies) !== JSON.stringify(current?.tools || {})
        }
        onClose={() => {
          setEditing(false);
          onEditorClose?.();
        }}
      >
        {error && compact && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {notice && compact && (
          <p className="notice neutral" role="status">
            {notice}
          </p>
        )}
        {!connected && (
          <p className="notice warning" role="status">
            Disconnected. Reconnect before changing this connection.
          </p>
        )}
        {editing && (
          <form
            className="connection-form"
            onSubmit={(event) => void save(event)}
            aria-label="Configure MCP server"
          >
            <div className="form-grid">
              <Field
                label="Connection name"
                hint="Stable identifier: letters, numbers, hyphens and underscores."
              >
                <input
                  value={name}
                  required
                  maxLength={40}
                  pattern={'[A-Za-z0-9_\\-]+'}
                  disabled={busy || !!current}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field
                label="Endpoint MCP"
                hint="Public HTTPS, port 443 and an exact path. Local destinations require instance configuration."
              >
                <input
                  type="url"
                  value={endpoint}
                  required
                  maxLength={2048}
                  disabled={busy}
                  placeholder="https://tools.example.com/mcp"
                  onChange={(event) => {
                    setEndpoint(event.target.value);
                    setDiscovery(null);
                  }}
                />
              </Field>
            </div>
            <p className="muted">
              Credentials are encrypted through the connection card. Do not include them in URLs. Changing
              destinations clears selected tools and creates a distinct credential target.
            </p>
            {current && (
              <div>
                <button
                  className="button small"
                  type="button"
                  disabled={busy || endpoint !== current.endpoint}
                  onClick={() => void discover()}
                >
                  {busy ? 'Loading…' : 'Discover tools'}
                </button>
                <p className="muted">
                  Discovery reads the remote catalog without executing tools. Saved connections start
                  disabled.
                </p>
              </div>
            )}
            {discovery && (
              <div className="mcp-tool-list">
                <h3>Tools and roles</h3>
                <p className="muted">
                  Inspect each contract. External tools are read-only in this release; also grant read-only
                  permissions at the remote service. Tool descriptions do not prove behavior.
                </p>
                {discovery.tools.map((tool) => (
                  <fieldset className="mcp-tool" key={tool.name} disabled={busy}>
                    <legend>{tool.name}</legend>
                    <p>{tool.description}</p>
                    <details>
                      <summary>View input contract</summary>
                      <pre className="schema-preview">{JSON.stringify(tool.input_schema, null, 2)}</pre>
                    </details>
                    <div className="role-options">
                      {(Object.keys(roles) as Role[]).map((role) => (
                        <label className="check-line" key={role}>
                          <input
                            type="checkbox"
                            checked={policies[tool.name]?.roles.includes(role) || false}
                            onChange={(event) =>
                              setRole(tool.name, tool.manifest_digest, role, event.target.checked)
                            }
                          />
                          {roles[role]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
                {!discovery.tools.length && <p className="muted">The server advertises no tools.</p>}
              </div>
            )}
            {!!current && !discovery && !!Object.keys(policies).length && (
              <p className="muted">
                Retaining {Object.keys(policies).length} reviewed contracts if the endpoint is unchanged.
                Discover the catalog to change role assignments.
              </p>
            )}
            <div className="integration-actions">
              <button className="button primary" disabled={busy || !connected}>
                {busy ? 'Saving…' : 'Save disabled connection'}
              </button>
            </div>
          </form>
        )}
      </Dialog>
      {!compact && !!items.length && (
        <details>
          <summary>Project access</summary>
          <ProjectToolAccess api={api} connections={items} />
        </details>
      )}
    </section>
  );
}

function ProjectToolAccess({ api, connections }: { api: Api; connections: MCPConnectionInfo[] }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [policy, setPolicy] = useState<ProjectToolsPolicy | null>(null);
  const [servers, setServers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    void api
      .projects()
      .then((value) => {
        if (active) setProjects(value);
      })
      .catch((reason) => {
        if (active) setError(failure(reason));
      });
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    let active = true;
    setPolicy(null);
    setError('');
    setNotice('');
    if (projectId)
      void api
        .projectTools(projectId)
        .then((value) => {
          if (active) {
            setPolicy(value);
            setServers(value.servers);
          }
        })
        .catch((reason) => {
          if (active) setError(failure(reason));
        });
    return () => {
      active = false;
    };
  }, [api, projectId]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!policy || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.setProjectTools(policy.project_id, {
        expected_revision: policy.revision,
        servers,
      });
      setPolicy(next);
      setServers(next.servers);
      setNotice('Project permissions saved. Server activation is controlled separately.');
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="connection-form"
      aria-label="MCP access by project"
      onSubmit={(event) => void save(event)}
    >
      <h3>Project access</h3>
      <p className="muted">
        Stop active project work before changing permissions. Selecting a server does not enable it.
      </p>
      <Field label="Project tool permissions">
        <Select value={projectId} disabled={busy} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Choose a project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
      </Field>
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
      {policy && (
        <>
          <fieldset disabled={busy} className="server-options">
            <legend>Allowed servers</legend>
            {connections.map((connection) => (
              <label className="check-line" key={connection.name}>
                <input
                  type="checkbox"
                  checked={servers.includes(connection.name)}
                  onChange={(event) =>
                    setServers((current) =>
                      event.target.checked
                        ? [...new Set([...current, connection.name])]
                        : current.filter((name) => name !== connection.name),
                    )
                  }
                />
                {connection.name}
              </label>
            ))}
          </fieldset>
          <button className="button primary" disabled={busy}>
            Save project permissions
          </button>
        </>
      )}
    </form>
  );
}

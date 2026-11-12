import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  type Api,
  type MCPConnectionInfo,
  type MCPDiscovery,
  type MCPToolSettings,
  type Project,
  type ProjectToolsPolicy,
} from './api';
import Button from './components/Button';
import CheckField from './components/CheckField';
import CodeBlock from './components/CodeBlock';
import Dialog, { DialogActions } from './components/Dialog';
import Disclosure from './components/Disclosure';
import Field from './components/FormField';
import Input from './components/Input';
import Notice from './components/Notice';
import { SectionHeading } from './components/PageHeader';
import Select from './components/Select';

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
  const fill = useCallback((item: MCPConnectionInfo | null) => {
    setCurrent(item);
    setName(item?.name || '');
    setEndpoint(item?.endpoint || '');
    setPolicies(item?.tools || {});
    setDigests(item?.tool_digests || {});
    setDiscovery(null);
    setEditing(true);
  }, []);
  // State is applied in promise callbacks, so the mount effect never sets state synchronously.
  const fetchConnections = useCallback(
    () =>
      api
        .mcpConnections()
        .then(
          (next) => {
            setItems(next);
            setError('');
            // The compact editor (opened from Tools) follows the loaded connection it was asked for.
            if (compact) fill(next.find((value) => value.name === initialConnection) ?? null);
          },
          (reason: unknown) => {
            setError(failure(reason));
            // Without a catalog the compact editor still opens, keeping the values it already holds.
            if (compact) setEditing(true);
          },
        )
        .finally(() => setLoading(false)),
    [api, compact, initialConnection, fill],
  );
  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);
  const load = async () => {
    setLoading(true);
    await fetchConnections();
  };
  const choose = (item: MCPConnectionInfo | null) => {
    fill(item);
    setError('');
    setNotice('');
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
    <section className="grid min-w-0 gap-4" aria-labelledby="mcp-connections-title">
      {!compact && (
        <>
          <SectionHeading
            id="mcp-connections-title"
            title="MCP servers"
            description="Connect external tools and choose which roles and projects may use them."
            actions={
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={loading || busy}
                  onClick={() => void load()}
                >
                  Refresh servers
                </Button>
                <Button type="button" variant="primary" disabled={busy} onClick={() => choose(null)}>
                  Add MCP server
                </Button>
              </>
            }
          />
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
          {loading && !items.length && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading servers…
            </p>
          )}
          {!loading && !items.length && (
            <p className="text-sm text-muted-foreground">No MCP servers registered yet.</p>
          )}
          {!!items.length && (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {items.map((item) => (
                <li
                  key={item.name}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <strong className="text-sm font-semibold">{item.name}</strong>
                    <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {item.endpoint}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {Object.keys(item.tools).length} authorized tools ·{' '}
                      {item.source === 'static' ? 'Instance configuration' : `Review ${item.revision}`}
                    </span>
                  </div>
                  {item.source === 'dynamic' && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => choose(item)}
                      aria-label={`Configure MCP ${item.name}`}
                    >
                      Configure
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
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
        <div className="grid gap-4">
          {error && compact && (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          )}
          {notice && compact && (
            <Notice tone="neutral" role="status">
              {notice}
            </Notice>
          )}
          {!connected && (
            <Notice tone="warning" role="status">
              Disconnected. Reconnect before changing this connection.
            </Notice>
          )}
          {editing && (
            <form
              className="grid min-w-0 gap-5"
              onSubmit={(event) => void save(event)}
              aria-label="Configure MCP server"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Connection name"
                  hint="Stable identifier: letters, numbers, hyphens and underscores."
                >
                  <Input
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
                  <Input
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
              <p className="text-sm text-muted-foreground">
                Credentials are encrypted through the connection card. Do not include them in URLs. Changing
                destinations clears selected tools and creates a distinct credential target.
              </p>
              {current && (
                <div className="grid justify-items-start gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={busy || endpoint !== current.endpoint}
                    onClick={() => void discover()}
                  >
                    {busy ? 'Loading…' : 'Discover tools'}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Discovery reads the remote catalog without executing tools. Saved connections start
                    disabled.
                  </p>
                </div>
              )}
              {discovery && (
                <div className="grid gap-4">
                  <div className="grid gap-1">
                    <h3 className="text-base font-semibold">Tools and roles</h3>
                    <p className="text-sm text-muted-foreground">
                      Inspect each contract. External tools are read-only in this release; also grant
                      read-only permissions at the remote service. Tool descriptions do not prove behavior.
                    </p>
                  </div>
                  {discovery.tools.map((tool) => (
                    <fieldset
                      className="grid min-w-0 gap-3 rounded-lg border border-border p-4"
                      key={tool.name}
                      disabled={busy}
                    >
                      <legend className="px-1.5 text-sm font-semibold [overflow-wrap:anywhere]">
                        {tool.name}
                      </legend>
                      <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {tool.description}
                      </p>
                      <Disclosure variant="plain" summary="View input contract">
                        <CodeBlock className="max-h-56">
                          {JSON.stringify(tool.input_schema, null, 2)}
                        </CodeBlock>
                      </Disclosure>
                      <div className="flex flex-wrap gap-x-6 gap-y-3">
                        {(Object.keys(roles) as Role[]).map((role) => (
                          <CheckField
                            key={role}
                            label={roles[role]}
                            checked={policies[tool.name]?.roles.includes(role) || false}
                            onChange={(event) =>
                              setRole(tool.name, tool.manifest_digest, role, event.target.checked)
                            }
                          />
                        ))}
                      </div>
                    </fieldset>
                  ))}
                  {!discovery.tools.length && (
                    <p className="text-sm text-muted-foreground">The server advertises no tools.</p>
                  )}
                </div>
              )}
              {!!current && !discovery && !!Object.keys(policies).length && (
                <p className="text-sm text-muted-foreground">
                  Retaining {Object.keys(policies).length} reviewed contracts if the endpoint is unchanged.
                  Discover the catalog to change role assignments.
                </p>
              )}
              <DialogActions>
                <Button type="submit" variant="primary" disabled={busy || !connected}>
                  {busy ? 'Saving…' : 'Save disabled connection'}
                </Button>
              </DialogActions>
            </form>
          )}
        </div>
      </Dialog>
      {!compact && !!items.length && (
        <Disclosure summary="Project access">
          <ProjectToolAccess api={api} connections={items} />
        </Disclosure>
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
  const policyRequest = useRef(0);
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
  const chooseProject = (id: string) => {
    const request = ++policyRequest.current;
    setProjectId(id);
    setPolicy(null);
    setError('');
    setNotice('');
    if (!id) return;
    void api
      .projectTools(id)
      .then((value) => {
        if (policyRequest.current !== request) return;
        setPolicy(value);
        setServers(value.servers);
      })
      .catch((reason) => {
        if (policyRequest.current === request) setError(failure(reason));
      });
  };
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
      className="grid min-w-0 gap-4"
      aria-label="MCP access by project"
      onSubmit={(event) => void save(event)}
    >
      <div className="grid gap-1">
        <h3 className="text-base font-semibold">Project access</h3>
        <p className="text-sm text-muted-foreground">
          Stop active project work before changing permissions. Selecting a server does not enable it.
        </p>
      </div>
      <Field label="Project tool permissions">
        <Select value={projectId} disabled={busy} onChange={(event) => chooseProject(event.target.value)}>
          <option value="">Choose a project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
      </Field>
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
      {policy && (
        <>
          <fieldset disabled={busy} className="grid min-w-0 gap-2.5">
            <legend className="mb-2.5 text-sm font-medium">Allowed servers</legend>
            {connections.map((connection) => (
              <CheckField
                key={connection.name}
                label={connection.name}
                checked={servers.includes(connection.name)}
                onChange={(event) =>
                  setServers((current) =>
                    event.target.checked
                      ? [...new Set([...current, connection.name])]
                      : current.filter((name) => name !== connection.name),
                  )
                }
              />
            ))}
          </fieldset>
          <Button type="submit" variant="primary" className="justify-self-start" disabled={busy}>
            Save project permissions
          </Button>
        </>
      )}
    </form>
  );
}

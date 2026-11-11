import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  ApiError,
  type Api,
  type A2AAgentInfo,
  type AgentCardDiscovery,
  type Project,
  type MCPConnectionInfo,
} from './api';
import Credentials from './Credentials';
import Dialog from './components/Dialog';
import Field from './components/FormField';
import './ConsoleSections.css';

const roles = [
  'supervisor',
  'analyst',
  'architect',
  'developer',
  'qa',
  'reviewer',
  'security',
  'designer',
  'devops',
];
const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'The external agent request could not be confirmed. Your review is retained.';
function advertisedSkills(card: Record<string, unknown>) {
  return Array.isArray(card.skills)
    ? card.skills.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string') return [];
        return [
          {
            id: item.id,
            name: 'name' in item && typeof item.name === 'string' ? item.name : item.id,
            description:
              'description' in item && typeof item.description === 'string' ? item.description : '',
          },
        ];
      })
    : [];
}
function cardText(card: Record<string, unknown>, key: string) {
  return typeof card[key] === 'string' ? card[key] : '';
}
function cardAddress(endpoint: string) {
  try {
    return new URL('/.well-known/agent-card.json', endpoint).href;
  } catch {
    return '';
  }
}

export default function RemoteAgentsPanel({
  api,
  projects,
  connected = true,
  onRefresh,
}: {
  api: Api;
  projects: Project[];
  connected?: boolean;
  onRefresh?: () => Promise<void>;
}) {
  const [agents, setAgents] = useState<A2AAgentInfo[]>([]);
  const [mcp, setMCP] = useState<MCPConnectionInfo[]>([]);
  const [selectedName, setSelectedName] = useState('');
  const [view, setView] = useState('A2A agents');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState<A2AAgentInfo | null>(null);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [cardEndpoint, setCardEndpoint] = useState('');
  const [discovered, setDiscovered] = useState<AgentCardDiscovery | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [next, servers] = await Promise.all([api.a2aAgents(), api.mcpConnections()]);
      setAgents(next);
      setMCP(servers);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  const selected = agents.find((item) => item.name === selectedName) ?? agents[0];
  const choose = (item: A2AAgentInfo | null) => {
    setCurrent(item);
    setName(item?.name ?? '');
    setEndpoint(item?.endpoint ?? '');
    setCardEndpoint(item ? cardAddress(item.endpoint) : '');
    setDiscovered(
      item
        ? {
            card: item.card,
            reviewed_digest: item.digest,
            endpoint: item.endpoint,
            execution_authorized: false,
          }
        : null,
    );
    setReviewed(false);
    setEnabled(item?.enabled ?? false);
    setProjectIds(item?.projects ?? []);
    setRoleIds(item?.roles ?? []);
    setSkillIds(item?.skills ?? []);
    setError('');
    setNotice('');
    setEditing(true);
  };
  const dirty =
    name !== (current?.name ?? '') ||
    endpoint !== (current?.endpoint ?? '') ||
    enabled !== (current?.enabled ?? false) ||
    JSON.stringify(projectIds) !== JSON.stringify(current?.projects ?? []) ||
    JSON.stringify(roleIds) !== JSON.stringify(current?.roles ?? []) ||
    JSON.stringify(skillIds) !== JSON.stringify(current?.skills ?? []) ||
    (!!discovered && discovered.reviewed_digest !== current?.digest);
  const discover = async () => {
    if (busy || !connected || !name.trim() || !endpoint || !cardEndpoint) return;
    setBusy(true);
    setError('');
    setReviewed(false);
    try {
      const result = await api.discoverA2AAgent(name, { endpoint, card_endpoint: cardEndpoint });
      setDiscovered(result);
      setSkillIds((ids) =>
        ids.filter((id) => advertisedSkills(result.card).some((skill) => skill.id === id)),
      );
      if (current && result.reviewed_digest !== current.digest) setEnabled(false);
    } catch (reason) {
      setError(failure(reason));
      setDiscovered(null);
    } finally {
      setBusy(false);
    }
  };
  const toggleChoice = (values: string[], id: string, checked: boolean) =>
    checked ? [...new Set([...values, id])] : values.filter((value) => value !== id);
  const save = async () => {
    if (
      !connected ||
      busy ||
      !discovered ||
      !reviewed ||
      !projectIds.length ||
      (enabled && (!roleIds.length || !skillIds.length))
    )
      return;
    setBusy(true);
    setError('');
    try {
      const next = await api.saveA2AAgent(name, {
        expected_revision: current?.revision ?? 0,
        endpoint: discovered.endpoint,
        card: discovered.card,
        reviewed_digest: discovered.reviewed_digest,
        enabled,
        projects: projectIds,
        roles: roleIds,
        skills: skillIds,
      });
      setAgents((items) =>
        [...items.filter((item) => item.name !== next.name), next].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setSelectedName(next.name);
      setEditing(false);
      setNotice('External agent registration saved. Remote availability and costs remain unverified.');
      try {
        await onRefresh?.();
      } catch {
        setError(
          'The registration was saved. Overall status could not be refreshed; refresh external registrations before delegating.',
        );
      }
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
          <h2>External specialists</h2>
          <p>
            A2A agents and MCP tool bindings keep their own manifests and scoped grants. Discovery never
            authorizes a task.
          </p>
        </div>
        <div className="operator-actions">
          <button className="button" disabled={loading || busy} onClick={() => void load()}>
            Refresh external agents
          </button>
          <button className="button primary" disabled={!connected} onClick={() => choose(null)}>
            Register A2A agent
          </button>
        </div>
      </header>
      {!connected && (
        <p className="notice warning" role="status">
          Disconnected. Remote connection changes are unavailable.
        </p>
      )}
      {error && !editing && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice neutral" role="status">
          {notice}
        </p>
      )}
      <div className="operator-tabs" aria-label="External specialist protocols">
        {['A2A agents', 'MCP bindings'].map((tab) => (
          <button key={tab} aria-pressed={tab === view} onClick={() => setView(tab)}>
            {tab}
          </button>
        ))}
      </div>
      {loading && <p role="status">Loading external registrations…</p>}
      {view === 'A2A agents' && (
        <div className="operator-split">
          <div className="operator-catalog">
            {agents.map((item) => (
              <button
                className="operator-catalog-row"
                key={item.name}
                aria-pressed={selected?.name === item.name}
                onClick={() => setSelectedName(item.name)}
              >
                <div>
                  <span className="operator-eyebrow">A2A 1.0 · JSON-RPC</span>
                  <strong style={{ display: 'block', marginTop: 6 }}>
                    {cardText(item.card, 'name') || item.name}
                  </strong>
                  <small>
                    {item.name} · {item.projects.length} project grants · {item.roles.length} roles ·{' '}
                    {item.skills.length} skills
                  </small>
                </div>
                <span className={`operator-tag ${item.enabled ? 'good' : 'warning'}`}>
                  {item.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </button>
            ))}
            {!loading && !agents.length && (
              <div className="operator-empty">
                <h3>No external A2A agents registered</h3>
                <p>
                  Discover an official Agent Card, review its contract and select the projects, roles and
                  skills it may serve.
                </p>
              </div>
            )}
          </div>
          <aside className="operator-panel" aria-label="External agent inspector">
            {selected ? (
              <>
                <span className="operator-eyebrow">Registered Agent Card · revision {selected.revision}</span>
                <h3 style={{ marginTop: 12 }}>{cardText(selected.card, 'name') || selected.name}</h3>
                <p>{cardText(selected.card, 'description')}</p>
                <dl className="operator-kv">
                  <dt>Endpoint</dt>
                  <dd>
                    <code>{selected.endpoint}</code>
                  </dd>
                  <dt>Availability</dt>
                  <dd>
                    {selected.enabled
                      ? 'Enabled; remote reachability not checked'
                      : 'Disabled for new delegations'}
                  </dd>
                  <dt>Projects</dt>
                  <dd>
                    {selected.projects
                      .map((id) => projects.find((project) => project.id === id)?.name ?? id)
                      .join(' · ')}
                  </dd>
                  <dt>Specialists</dt>
                  <dd>{selected.roles.join(' · ') || 'No role grant'}</dd>
                  <dt>Skills</dt>
                  <dd>{selected.skills.join(' · ') || 'No skill grant'}</dd>
                  <dt>Remote cost</dt>
                  <dd>Unknown · reported separately from local usage</dd>
                  <dt>Card digest</dt>
                  <dd>
                    <code>{selected.digest}</code>
                  </dd>
                </dl>
                <div className="operator-actions">
                  <button className="button" disabled={!connected} onClick={() => choose(selected)}>
                    Review registration
                  </button>
                  <button
                    className="button"
                    disabled={!connected}
                    onClick={() => setCredentialId(selected.credential_id)}
                  >
                    Manage scoped credential
                  </button>
                </div>
                <details className="operator-section-divider">
                  <summary>Reviewed Agent Card</summary>
                  <pre className="operator-code">{JSON.stringify(selected.card, null, 2)}</pre>
                </details>
                <p className="operator-readonly">
                  Delegation requires the intersection of the registered project, local role and advertised
                  skill. A card or a saved credential does not expand a run’s budget or permission.
                </p>
              </>
            ) : (
              <p>Select an external registration to inspect its contract.</p>
            )}
          </aside>
        </div>
      )}
      {view === 'MCP bindings' && (
        <section className="operator-panel">
          <h3>Registered MCP tool bindings</h3>
          <p className="muted">
            MCP servers can expose specialist capabilities as reviewed tools. This catalog shows the actual
            tool and role grants; it does not infer that a tool is an agent.
          </p>
          {mcp.length ? (
            <div className="operator-table-wrap">
              <table className="operator-table">
                <thead>
                  <tr>
                    <th>Server / tool</th>
                    <th>Local roles</th>
                    <th>Reviewed manifest</th>
                  </tr>
                </thead>
                <tbody>
                  {mcp.flatMap((server) =>
                    Object.entries(server.tools).map(([tool, policy]) => (
                      <tr key={`${server.name}:${tool}`}>
                        <td>
                          {server.name}
                          <small>
                            <code>{tool}</code>
                          </small>
                        </td>
                        <td>{policy.roles.join(' · ')}</td>
                        <td>
                          {server.tool_digests[tool] ? (
                            <code>{server.tool_digests[tool].slice(0, 16)}…</code>
                          ) : (
                            'No reviewed digest'
                          )}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No MCP servers are registered.</p>
          )}
          <p className="operator-readonly">
            Connection activation, write-only credentials and project access are managed in Tools. Tool
            discovery does not execute the tool.
          </p>
          <Link className="button" to="/tools">
            Review Tools access
          </Link>
        </section>
      )}
      <Dialog
        open={editing}
        title={current ? `Review ${current.name}` : 'Register external A2A agent'}
        description="Discover a safe Agent Card, review the manifest, then authorize exact project, role and skill bindings."
        busy={busy}
        dirty={dirty}
        onClose={() => setEditing(false)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy || !connected}>
            <Field
              label="Connection name"
              hint="Stable identifier: letters, numbers, hyphens and underscores."
            >
              <input
                required
                pattern={'[A-Za-z0-9_\\-]+'}
                maxLength={40}
                disabled={!!current || busy}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label="A2A endpoint"
              hint="Public HTTPS on port 443. Exact endpoint; no credentials in the URL."
            >
              <input
                required
                type="url"
                maxLength={2048}
                value={endpoint}
                onChange={(event) => {
                  setEndpoint(event.target.value);
                  setCardEndpoint(cardAddress(event.target.value));
                  setDiscovered(null);
                  setReviewed(false);
                  setEnabled(false);
                  setSkillIds([]);
                }}
              />
            </Field>
            <Field label="Agent Card URL" hint="The card must come from the same reviewed origin.">
              <input
                required
                type="url"
                maxLength={2048}
                value={cardEndpoint}
                onChange={(event) => {
                  setCardEndpoint(event.target.value);
                  setDiscovered(null);
                  setReviewed(false);
                  setEnabled(false);
                }}
              />
            </Field>
            <button
              className="button"
              type="button"
              disabled={busy || !connected || !name || !endpoint || !cardEndpoint}
              onClick={() => void discover()}
            >
              {busy ? 'Inspecting…' : 'Discover Agent Card'}
            </button>
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            {discovered && (
              <div className="operator-section-divider">
                <span className="operator-tag">Discovery grants no execution access</span>
                <h3 style={{ marginTop: 15 }}>{cardText(discovered.card, 'name')}</h3>
                <p>{cardText(discovered.card, 'description')}</p>
                <details>
                  <summary>Inspect full Agent Card and digest</summary>
                  <pre className="operator-code">{JSON.stringify(discovered.card, null, 2)}</pre>
                  <p className="operator-readonly">
                    <code>{discovered.reviewed_digest}</code>
                  </p>
                </details>
                <fieldset>
                  <legend>Allowed projects</legend>
                  {projects.map((project) => (
                    <label className="check-line" key={project.id}>
                      <input
                        type="checkbox"
                        checked={projectIds.includes(project.id)}
                        onChange={(event) => {
                          setProjectIds(toggleChoice(projectIds, project.id, event.target.checked));
                          setReviewed(false);
                        }}
                      />
                      {project.name}
                    </label>
                  ))}
                  {!projects.length && <p>Register a project before granting external access.</p>}
                </fieldset>
                <details style={{ marginTop: 18 }} open={!!current}>
                  <summary>Role and skill bindings</summary>
                  <fieldset>
                    <legend>Allowed local specialist roles</legend>
                    {roles.map((id) => (
                      <label className="check-line" key={id}>
                        <input
                          type="checkbox"
                          checked={roleIds.includes(id)}
                          onChange={(event) => {
                            setRoleIds(toggleChoice(roleIds, id, event.target.checked));
                            setReviewed(false);
                          }}
                        />
                        {id}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend>Advertised remote skills</legend>
                    {advertisedSkills(discovered.card).map((skill) => (
                      <label className="check-line" key={skill.id}>
                        <input
                          type="checkbox"
                          checked={skillIds.includes(skill.id)}
                          onChange={(event) => {
                            setSkillIds(toggleChoice(skillIds, skill.id, event.target.checked));
                            setReviewed(false);
                          }}
                        />
                        <span>
                          {skill.name}
                          <small style={{ display: 'block', color: 'var(--muted)' }}>
                            {skill.description}
                          </small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </details>
                <label className="check-line" style={{ marginTop: 18 }}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => {
                      setEnabled(event.target.checked);
                      setReviewed(false);
                    }}
                  />
                  Enable this registration for its selected bindings
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(event) => setReviewed(event.target.checked)}
                  />
                  I reviewed this Agent Card, destination and exact access bindings.
                </label>
                <p className="operator-readonly">
                  Remote content is untrusted context. Its credentials are destination scoped and never
                  exported. Remote costs remain unknown until reported.
                </p>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !connected ||
                    !reviewed ||
                    !projectIds.length ||
                    (enabled && (!roleIds.length || !skillIds.length))
                  }
                >
                  {busy ? 'Saving…' : enabled ? 'Save enabled registration' : 'Save disabled registration'}
                </button>
              </div>
            )}
          </fieldset>
        </form>
      </Dialog>
      <Dialog open={!!credentialId} title="External agent credential" onClose={() => setCredentialId(null)}>
        {credentialId && (
          <Credentials
            api={api}
            targetIds={[credentialId]}
            connected={connected}
            onChanged={async () => {
              await onRefresh?.();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

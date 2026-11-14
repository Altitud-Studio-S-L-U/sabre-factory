import { useEffect, useState, type ReactNode } from 'react';
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
import Button from './components/Button';
import CheckField from './components/CheckField';
import CodeBlock from './components/CodeBlock';
import DescriptionList from './components/DescriptionList';
import Dialog from './components/Dialog';
import Disclosure from './components/Disclosure';
import EmptyState from './components/EmptyState';
import Field from './components/FormField';
import Input from './components/Input';
import LoadingState from './components/LoadingState';
import Notice from './components/Notice';
import { Eyebrow, SectionHeading } from './components/PageHeader';
import Experimental from './components/Experimental';
import Tabs from './components/Tabs';
import { Badge } from './components/ui/badge';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from './components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';

type Protocol = 'a2a' | 'mcp';
// Tab values become element ids, so they carry no spaces.
const protocols: { value: Protocol; label: string }[] = [
  { value: 'a2a', label: 'A2A agents' },
  { value: 'mcp', label: 'MCP bindings' },
];
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

/** A bordered group of related controls with a small legend. */
function FieldGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-lg border border-border px-4 pt-2 pb-4">
      <legend className="px-1.5 text-xs font-medium text-muted-foreground">{legend}</legend>
      {children}
    </fieldset>
  );
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
  const [view, setView] = useState<Protocol>('a2a');
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
  const load = async () => {
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
  };
  useEffect(() => {
    let live = true;
    Promise.all([api.a2aAgents(), api.mcpConnections()])
      .then(([next, servers]) => {
        if (!live) return;
        setAgents(next);
        setMCP(servers);
      })
      .catch((reason) => {
        if (live) setError(failure(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api]);
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
    <div className="grid min-w-0 gap-5">
      <SectionHeading
        className="items-start [&>:first-child]:flex-1 [&>:first-child]:basis-72"
        title="External specialists"
        badge={<Experimental />}
        description="A2A agents and MCP tool bindings keep their own manifests and scoped grants. Discovery never authorizes a task."
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={loading || busy}
              onClick={() => void load()}
            >
              Refresh external agents
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!connected}
              onClick={() => choose(null)}
            >
              Register A2A agent
            </Button>
          </>
        }
      />
      {!connected && (
        <Notice tone="warning" role="status">
          Disconnected. Remote connection changes are unavailable.
        </Notice>
      )}
      {error && !editing && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="neutral" role="status">
          {notice}
        </Notice>
      )}
      <Tabs
        items={protocols}
        value={view}
        onChange={setView}
        label="External specialist protocols"
        className="[&>[role=tabpanel]]:p-0"
      >
        {(active) => (
          <div className="grid min-w-0 gap-4 pt-4">
            {loading && <LoadingState label="Loading external registrations…" />}
            {active === 'a2a' && (
              <div className="@container min-w-0">
                <div className="grid min-w-0 items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                  <div className="grid min-w-0 gap-2">
                    {agents.map((item) => (
                      <Button
                        type="button"
                        key={item.name}
                        aria-pressed={selected?.name === item.name}
                        className="flex w-full min-w-0 items-start justify-between gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-hover aria-pressed:border-primary aria-pressed:bg-accent"
                        onClick={() => setSelectedName(item.name)}
                      >
                        <span className="grid min-w-0 gap-1">
                          <Eyebrow>A2A 1.0 · JSON-RPC</Eyebrow>
                          <strong className="text-sm font-semibold [overflow-wrap:anywhere]">
                            {cardText(item.card, 'name') || item.name}
                          </strong>
                          <small className="text-xs text-muted-foreground">
                            {item.name} · {item.projects.length} project grants · {item.roles.length} roles ·{' '}
                            {item.skills.length} skills
                          </small>
                        </span>
                        <Badge variant={item.enabled ? 'success' : 'warning'}>
                          {item.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </Button>
                    ))}
                    {!loading && !agents.length && (
                      <EmptyState title="No external A2A agents registered">
                        Discover an official Agent Card, review its contract and select the projects, roles
                        and skills it may serve.
                      </EmptyState>
                    )}
                  </div>
                  <aside
                    className="grid min-w-0 gap-4 rounded-lg border border-border bg-card p-5"
                    aria-label="External agent inspector"
                  >
                    {selected ? (
                      <>
                        <div className="grid min-w-0 gap-1.5">
                          <Eyebrow>Registered Agent Card · revision {selected.revision}</Eyebrow>
                          <h3 className="text-lg font-semibold [overflow-wrap:anywhere]">
                            {cardText(selected.card, 'name') || selected.name}
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            {cardText(selected.card, 'description')}
                          </p>
                        </div>
                        <DescriptionList
                          items={[
                            ['Endpoint', <code className="font-mono text-xs">{selected.endpoint}</code>],
                            [
                              'Availability',
                              selected.enabled
                                ? 'Enabled; remote reachability not checked'
                                : 'Disabled for new delegations',
                            ],
                            [
                              'Projects',
                              selected.projects
                                .map((id) => projects.find((project) => project.id === id)?.name ?? id)
                                .join(' · '),
                            ],
                            ['Specialists', selected.roles.join(' · ') || 'No role grant'],
                            ['Skills', selected.skills.join(' · ') || 'No skill grant'],
                            ['Remote cost', 'Unknown · reported separately from local usage'],
                            ['Card digest', <code className="font-mono text-xs">{selected.digest}</code>],
                          ]}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={!connected}
                            onClick={() => choose(selected)}
                          >
                            Review registration
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={!connected}
                            onClick={() => setCredentialId(selected.credential_id)}
                          >
                            Manage scoped credential
                          </Button>
                        </div>
                        <Disclosure summary="Reviewed Agent Card">
                          <CodeBlock>{JSON.stringify(selected.card, null, 2)}</CodeBlock>
                        </Disclosure>
                        <p className="text-xs text-muted-foreground">
                          Delegation requires the intersection of the registered project, local role and
                          advertised skill. A card or a saved credential does not expand a run’s budget or
                          permission.
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Select an external registration to inspect its contract.
                      </p>
                    )}
                  </aside>
                </div>
              </div>
            )}
            {active === 'mcp' && (
              <Card>
                <CardHeader>
                  <div className="grid min-w-0 gap-1">
                    <CardTitle as="h3" className="text-base">
                      Registered MCP tool bindings
                    </CardTitle>
                    <CardDescription>
                      MCP servers can expose specialist capabilities as reviewed tools. This catalog shows the
                      actual tool and role grants; it does not infer that a tool is an agent.
                    </CardDescription>
                  </div>
                </CardHeader>
                {mcp.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Server / tool</TableHead>
                        <TableHead>Local roles</TableHead>
                        <TableHead>Reviewed manifest</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {mcp.flatMap((server) =>
                        Object.entries(server.tools).map(([tool, policy]) => (
                          <TableRow key={`${server.name}:${tool}`}>
                            <TableCell>
                              {server.name}
                              <small className="block">
                                <code className="font-mono text-xs text-muted-foreground">{tool}</code>
                              </small>
                            </TableCell>
                            <TableCell>{policy.roles.join(' · ')}</TableCell>
                            <TableCell>
                              {server.tool_digests[tool] ? (
                                <code className="font-mono text-xs">
                                  {server.tool_digests[tool].slice(0, 16)}…
                                </code>
                              ) : (
                                'No reviewed digest'
                              )}
                            </TableCell>
                          </TableRow>
                        )),
                      )}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState title="No MCP servers are registered." />
                )}
                <CardFooter className="justify-between gap-3">
                  <p className="max-w-[60ch] text-xs text-muted-foreground">
                    Connection activation, write-only credentials and project access are managed in Tools.
                    Tool discovery does not execute the tool.
                  </p>
                  <Button asChild variant="secondary" size="sm">
                    <Link to="/tools">Review Tools access</Link>
                  </Button>
                </CardFooter>
              </Card>
            )}
          </div>
        )}
      </Tabs>
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
          <fieldset disabled={busy || !connected} className="grid min-w-0 gap-4">
            <Field
              label="Connection name"
              hint="Stable identifier: letters, numbers, hyphens and underscores."
            >
              <Input
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
              <Input
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
              <Input
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
            <div>
              <Button
                variant="secondary"
                type="button"
                disabled={busy || !connected || !name || !endpoint || !cardEndpoint}
                onClick={() => void discover()}
              >
                {busy ? 'Inspecting…' : 'Discover Agent Card'}
              </Button>
            </div>
            {error && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            {discovered && (
              <div className="grid min-w-0 gap-4 border-t border-border pt-5">
                <div className="grid min-w-0 justify-items-start gap-2">
                  <Badge variant="info">Discovery grants no execution access</Badge>
                  <h3 className="text-lg font-semibold [overflow-wrap:anywhere]">
                    {cardText(discovered.card, 'name')}
                  </h3>
                  <p className="text-sm text-muted-foreground">{cardText(discovered.card, 'description')}</p>
                </div>
                <Disclosure summary="Inspect full Agent Card and digest">
                  <CodeBlock>{JSON.stringify(discovered.card, null, 2)}</CodeBlock>
                  <p className="text-xs text-muted-foreground">
                    <code className="font-mono [overflow-wrap:anywhere]">{discovered.reviewed_digest}</code>
                  </p>
                </Disclosure>
                <FieldGroup legend="Allowed projects">
                  {projects.map((project) => (
                    <CheckField
                      key={project.id}
                      label={project.name}
                      checked={projectIds.includes(project.id)}
                      onChange={(event) => {
                        setProjectIds(toggleChoice(projectIds, project.id, event.target.checked));
                        setReviewed(false);
                      }}
                    />
                  ))}
                  {!projects.length && (
                    <p className="text-sm text-muted-foreground">
                      Register a project before granting external access.
                    </p>
                  )}
                </FieldGroup>
                <Disclosure summary="Role and skill bindings" open={!!current}>
                  <FieldGroup legend="Allowed local specialist roles">
                    <div className="@container">
                      <div className="grid gap-3 @sm:grid-cols-2 @lg:grid-cols-3">
                        {roles.map((id) => (
                          <CheckField
                            key={id}
                            label={id}
                            checked={roleIds.includes(id)}
                            onChange={(event) => {
                              setRoleIds(toggleChoice(roleIds, id, event.target.checked));
                              setReviewed(false);
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </FieldGroup>
                  <FieldGroup legend="Advertised remote skills">
                    {advertisedSkills(discovered.card).map((skill) => (
                      <CheckField
                        key={skill.id}
                        label={skill.name}
                        hint={skill.description}
                        checked={skillIds.includes(skill.id)}
                        onChange={(event) => {
                          setSkillIds(toggleChoice(skillIds, skill.id, event.target.checked));
                          setReviewed(false);
                        }}
                      />
                    ))}
                  </FieldGroup>
                </Disclosure>
                <CheckField
                  label="Enable this registration for its selected bindings"
                  checked={enabled}
                  onChange={(event) => {
                    setEnabled(event.target.checked);
                    setReviewed(false);
                  }}
                />
                <CheckField
                  label="I reviewed this Agent Card, destination and exact access bindings."
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                <p className="text-xs text-muted-foreground">
                  Remote content is untrusted context. Its credentials are destination scoped and never
                  exported. Remote costs remain unknown until reported.
                </p>
                <div className="flex justify-end">
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={
                      busy ||
                      !connected ||
                      !reviewed ||
                      !projectIds.length ||
                      (enabled && (!roleIds.length || !skillIds.length))
                    }
                  >
                    {busy ? 'Saving…' : enabled ? 'Save enabled registration' : 'Save disabled registration'}
                  </Button>
                </div>
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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type Api,
  type BuiltinToolCatalog,
  type IntegrationInfo,
  type MCPConnectionInfo,
  type MCPDiscovery,
  type Project,
  type ProjectToolsPolicy,
  type GitHubConnectionView,
} from './api';
import Credentials from './Credentials';
import MCPConnections from './MCPConnections';
import Deliveries from './Deliveries';
import BuiltinTools from './features/tools/BuiltinTools';
import ConnectionRow from './features/tools/ConnectionRow';
import GitHubConnection from './features/tools/GitHubConnection';
import Button from './components/Button';
import CheckField from './components/CheckField';
import Dialog, { DialogActions } from './components/Dialog';
import EmptyState from './components/EmptyState';
import Experimental from './components/Experimental';
import Field from './components/FormField';
import { SkeletonList, SkeletonStatus, SkeletonTabs } from './components/Skeletons';
import Notice from './components/Notice';
import RoutedLink from './components/RoutedLink';
import PageHeader, { SectionHeading } from './components/PageHeader';
import Select from './components/Select';
import Tabs from './components/Tabs';
import { Badge } from './components/ui/badge';
import { buttonVariants } from './components/ui/button';

const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'The connection could not be confirmed. Refresh before retrying.';

const tabs = ['github', 'mcp', 'notifications', 'builtin'] as const;
type ToolsTab = (typeof tabs)[number];
const tabLabels: Record<ToolsTab, string> = {
  github: 'GitHub',
  mcp: 'MCP servers',
  notifications: 'Notifications',
  builtin: 'Built-in tools',
};
/** The tab that holds a connection: GitHub, MCP, or the notification channels for the rest. */
const tabOf = (kind: string): ToolsTab =>
  kind === 'github' ? 'github' : kind === 'mcp' ? 'mcp' : 'notifications';

/** What the address asks for: a tab, a connection to open, or the form that adds an MCP server. */
function requested() {
  const query = new URLSearchParams(window.location.search);
  const connection = query.get('connection');
  const setup = query.get('setup') === 'mcp';
  const named = query.get('tab');
  const tab: ToolsTab = setup
    ? 'mcp'
    : connection
      ? tabOf(connection.split('.')[0])
      : (tabs.find((value) => value === named) ?? 'github');
  return { connection, setup, tab };
}

const credentialNoun = (item: IntegrationInfo) =>
  item.kind === 'github' ? 'token' : item.credential_ids.length > 1 ? 'credentials' : 'credential';
const capitalized = (value: string) => value[0].toUpperCase() + value.slice(1);
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const rows = 'divide-y divide-border rounded-lg border border-border bg-card';
const footnote = 'text-xs leading-relaxed text-muted-foreground';

export interface ToolsConsoleProps {
  api: Api;
  projects: Project[];
  connected?: boolean;
  onRefresh?: () => Promise<void>;
  onError?: (message: string) => void;
}

export default function ToolsConsole({ api, projects, connected = true, onRefresh }: ToolsConsoleProps) {
  const [request] = useState(requested);
  const connectionOpened = useRef(false);
  const [tab, setTab] = useState<ToolsTab>(request.tab);
  /** The connection a link opened; its details say that opening the page changed nothing. */
  const [linked, setLinked] = useState('');
  const [items, setItems] = useState<IntegrationInfo[]>([]);
  const [servers, setServers] = useState<MCPConnectionInfo[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinToolCatalog['items']>([]);
  /** Connections whose details are shown. */
  const [open, setOpen] = useState<string[]>([]);
  /** Per connection, a counter that asks its credential editor to open. */
  const [credentialRequests, setCredentialRequests] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ name: string | null } | null>(() =>
    request.setup ? { name: null } : null,
  );
  const [projectDialog, setProjectDialog] = useState(false);
  // Whether the GitHub App is installed: reading and delivering then use it instead of the saved tokens.
  const [githubInstalled, setGithubInstalled] = useState(false);
  const knownInstalled = useRef<boolean | null>(null);
  const [projectId, setProjectId] = useState('');
  const [policy, setPolicy] = useState<ProjectToolsPolicy | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [diagnostic, setDiagnostic] = useState<{ server: string; result: MCPDiscovery } | null>(null);
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
            const target = visible.find((item) => item.id === request.connection);
            if (!connectionOpened.current && target) {
              connectionOpened.current = true;
              setTab(tabOf(target.kind));
              setOpen([target.id]);
              setLinked(target.id);
            }
          },
          (reason: unknown) => setError(failure(reason)),
        )
        .finally(() => {
          setLoading(false);
          setReady(true);
        }),
    [api, request],
  );
  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);
  const load = async () => {
    setLoading(true);
    setError('');
    await fetchCatalog();
  };
  const onGitHubConnection = useCallback(
    (view: GitHubConnectionView) => {
      const installed = view.state === 'connected';
      setGithubInstalled(installed);
      // The capability rows say where their access comes from: read them again when that changes.
      if (knownInstalled.current !== null && knownInstalled.current !== installed) void fetchCatalog();
      knownInstalled.current = installed;
    },
    [fetchCatalog],
  );
  const changed = async () => {
    await load();
    await onRefresh?.();
  };
  const selectTab = (next: ToolsTab) => {
    setTab(next);
    // Reloading keeps the tab; the address is replaced so the back button still leaves the section.
    const url = new URL(window.location.href);
    url.search = next === 'github' ? '' : `?tab=${next}`;
    window.history.replaceState(window.history.state, '', url);
  };
  const toggleDetails = (id: string) => {
    setOpen((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
    setCredentialRequests((current) => ({ ...current, [id]: 0 }));
  };
  const editCredential = (id: string) => {
    setOpen((current) => (current.includes(id) ? current : [...current, id]));
    setCredentialRequests((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  };
  const chooseProject = (id: string) => {
    const pending = ++policyRequest.current;
    setProjectId(id);
    setPolicy(null);
    if (!id) return;
    void api
      .projectTools(id)
      .then((value) => {
        if (policyRequest.current !== pending) return;
        setPolicy(value);
        setAllowed(value.servers);
      })
      .catch((reason) => {
        if (policyRequest.current === pending) setError(failure(reason));
      });
  };
  const serverOf = (item: IntegrationInfo) =>
    item.kind === 'mcp'
      ? servers.find(
          (value) => item.credential_ids.includes(value.credential_id) || item.id === `mcp.${value.name}`,
        )
      : undefined;
  const toggle = async (item: IntegrationInfo) => {
    if (busy || !connected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await api.setIntegrationState(item.id, {
        enabled: !item.enabled,
        expected_revision: item.revision,
      });
      setItems((current) => current.map((value) => (value.id === next.id ? next : value)));
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
  const diagnose = async (server: MCPConnectionInfo) => {
    if (!connected || busy) return;
    setBusy(true);
    setError('');
    setDiagnostic(null);
    try {
      setDiagnostic({
        server: server.name,
        result: await api.discoverMCPTools(server.name, server.revision),
      });
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };

  const github = items.filter((item) => item.kind === 'github');
  const mcp = items.filter((item) => item.kind === 'mcp');
  const channels = items.filter((item) => item.kind !== 'github' && item.kind !== 'mcp');

  const row = (item: IntegrationInfo) => {
    const server = serverOf(item);
    const noun = credentialNoun(item);
    // Reading and delivering use the installed app; a token saved earlier is no longer what gives access.
    const throughApp = githubInstalled && (item.id === 'github.read' || item.id === 'github.publish');
    const result = server && diagnostic?.server === server.name ? diagnostic.result : null;
    return (
      <ConnectionRow
        key={item.id}
        title={item.title}
        description={item.description}
        facts={[
          server && (
            <code key="endpoint" className="font-mono">
              {server.endpoint}
            </code>
          ),
          server &&
            `${counted(Object.keys(server.tool_digests).length, 'reviewed tool contract')} · ${
              server.source === 'static' ? 'Set in the instance configuration' : `Review ${server.revision}`
            }`,
          item.access,
        ]}
        badges={
          <>
            {item.toggleable && (
              <Badge variant={item.enabled ? 'success' : 'warning'}>
                {item.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            )}
            {item.kind === 'slack' && <Experimental />}
            {throughApp ? (
              <Badge variant="success">Uses the connection</Badge>
            ) : (
              !!item.credential_ids.length && (
                <Badge variant={item.credential_configured ? 'success' : 'neutral'}>
                  {item.credential_configured ? `${capitalized(noun)} saved` : `No ${noun}`}
                </Badge>
              )
            )}
          </>
        }
        actions={
          <>
            {!!item.credential_ids.length && !throughApp && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!connected}
                aria-label={`${item.credential_configured ? 'Replace' : 'Add'} ${noun} for ${item.title}`}
                onClick={() => editCredential(item.id)}
              >
                {item.credential_configured ? 'Replace' : 'Add'} {noun}
              </Button>
            )}
            {item.toggleable && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || !connected}
                aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.title}`}
                onClick={() => void toggle(item)}
              >
                {item.enabled ? 'Disable' : 'Enable'}
              </Button>
            )}
            {server?.source === 'dynamic' && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!connected}
                aria-label={`Edit ${item.title}`}
                onClick={() => setEditor({ name: server.name })}
              >
                Edit
              </Button>
            )}
          </>
        }
        open={open.includes(item.id)}
        onToggle={() => toggleDetails(item.id)}
      >
        {linked === item.id && (
          <Notice tone="neutral" role="status">
            This is the connection the link asked for. Opening this page does not save credentials or grant
            execution permissions.
          </Notice>
        )}
        {!!item.credential_ids.length && (
          <Credentials
            embedded
            api={api}
            onChanged={changed}
            targetIds={item.credential_ids}
            connected={connected}
            editRequest={credentialRequests[item.id] ?? 0}
          />
        )}
        {!!item.tools.length && (
          <div className="grid min-w-0 gap-2">
            <h4 className="text-sm font-medium">Registered operations</h4>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {item.tools.map((tool) => (
                <li key={tool.name} className="flex min-w-0 items-start justify-between gap-4 px-3.5 py-3">
                  <div className="grid min-w-0 gap-0.5">
                    <code className="font-mono text-xs [overflow-wrap:anywhere]">{tool.name}</code>
                    <small className="text-xs text-muted-foreground">
                      {tool.roles.length ? tool.roles.join(' · ') : 'No specialist is granted this operation'}
                    </small>
                  </div>
                  <Badge variant="outline">{tool.effect.replaceAll('_', ' ')}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        {server && (
          <div className="grid min-w-0 gap-3">
            <h4 className="text-sm font-medium">Remote manifest</h4>
            <p className="text-sm text-muted-foreground">
              Reads the catalog the server advertises and compares it with the reviewed contracts. It does not
              execute tools or prove effective authorization.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="justify-self-start"
              disabled={busy || !connected}
              onClick={() => void diagnose(server)}
            >
              {busy ? 'Checking catalog…' : 'Inspect remote manifest'}
            </Button>
            {result && (
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="success">Catalog received</Badge>
                  <p className="text-sm">
                    Revision {result.connection_revision} · {counted(result.tools.length, 'advertised tool')}
                    {result.truncated ? ' · bounded result truncated' : ''}.
                  </p>
                </div>
                {result.tools.map((tool) => (
                  <div key={tool.name} className="grid gap-1 rounded-lg border border-border px-3.5 py-3">
                    <h5 className="text-sm font-semibold [overflow-wrap:anywhere]">{tool.name}</h5>
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
          </div>
        )}
        <p className={footnote}>
          Revision {item.revision}. Effective access also needs a reviewed contract and matching specialist,
          project and run permissions; enabling a connection does not expand any of them.
        </p>
      </ConnectionRow>
    );
  };

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        eyebrow="Capabilities & access"
        title="Tools"
        description="Connections to GitHub, MCP servers and notification channels, and the tools built into the factory. Model providers are connected in Config."
        actions={
          <Button type="button" variant="secondary" disabled={loading || busy} onClick={() => void load()}>
            Refresh
          </Button>
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
      {!ready ? (
        <SkeletonStatus label="Loading registered connections…">
          <SkeletonTabs count={4} />
          <SkeletonList rows={3} />
        </SkeletonStatus>
      ) : (
        <Tabs
          label="Tools sections"
          items={tabs.map((value) => ({
            value,
            label: tabLabels[value],
            count: value === 'mcp' ? mcp.length : value === 'builtin' ? builtins.length : undefined,
          }))}
          value={tab}
          onChange={selectTab}
          contentClassName="grid min-w-0 gap-8 pt-6"
        >
          {(current) =>
            current === 'github' ? (
              <>
                <GitHubConnection api={api} online={connected} onChanged={onGitHubConnection} />
                <section className="grid min-w-0 gap-4" aria-labelledby="tools-github-title">
                  <SectionHeading
                    id="tools-github-title"
                    title="Access"
                    description={
                      githubInstalled
                        ? 'Reading and delivering use the connection above, each with its own switch. Creating repositories keeps its own token.'
                        : 'Each permission has its own token, so reading a repository never carries write access.'
                    }
                  />
                  {github.length ? (
                    <ul className={rows}>{github.map(row)}</ul>
                  ) : (
                    <EmptyState as="h3" title="No GitHub connection registered">
                      This build does not register the GitHub adapter.
                    </EmptyState>
                  )}
                </section>
                <section
                  className="grid min-w-0 gap-4 border-t border-border pt-8"
                  aria-labelledby="tools-repositories-title"
                >
                  <SectionHeading
                    id="tools-repositories-title"
                    title="Repositories"
                    description="A repository becomes a project in Projects: from this GitHub access, by address, or as a new repository. This page keeps only the access."
                    actions={
                      <RoutedLink
                        className={buttonVariants({ variant: 'secondary' })}
                        to="/projects"
                        state={{ form: 'project' }}
                      >
                        Add a project
                      </RoutedLink>
                    }
                  />
                </section>
              </>
            ) : current === 'mcp' ? (
              <section className="grid min-w-0 gap-4" aria-labelledby="tools-mcp-title">
                <SectionHeading
                  id="tools-mcp-title"
                  title="Servers"
                  description="External tools that specialists may call. A server starts disabled and is used only by the roles and projects you select."
                  actions={
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={!connected || !servers.length}
                        onClick={() => setProjectDialog(true)}
                      >
                        Project access
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        disabled={!connected}
                        onClick={() => setEditor({ name: null })}
                      >
                        Add MCP server
                      </Button>
                    </>
                  }
                />
                {mcp.length ? (
                  <ul className={rows}>{mcp.map(row)}</ul>
                ) : (
                  <EmptyState as="h3" title="No MCP servers yet">
                    Add a server to review the tools it advertises. They stay unavailable until you choose
                    their roles, enable the server and allow it for a project.
                  </EmptyState>
                )}
              </section>
            ) : current === 'notifications' ? (
              <>
                <section className="grid min-w-0 gap-4" aria-labelledby="tools-channels-title">
                  <SectionHeading
                    id="tools-channels-title"
                    title="Channels"
                    description="Where the factory reaches you. A channel is bound in the instance configuration; its credentials are stored here."
                  />
                  {channels.length ? (
                    <ul className={rows}>{channels.map(row)}</ul>
                  ) : (
                    <EmptyState as="h3" title="No notification channel registered">
                      This build does not register a notification channel.
                    </EmptyState>
                  )}
                </section>
                <div className="grid min-w-0 gap-4 border-t border-border pt-8">
                  <Deliveries api={api} />
                </div>
              </>
            ) : (
              <BuiltinTools items={builtins} />
            )
          }
        </Tabs>
      )}
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
        description="Select only the projects that need a server. Changes use the current policy revision."
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
    </div>
  );
}

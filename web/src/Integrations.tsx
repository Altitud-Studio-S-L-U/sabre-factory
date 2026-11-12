import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  ApiError,
  type Api,
  type GitHubRepositoryInfo,
  type GitHubRepositoryPage,
  type IntegrationInfo,
} from './api';
import Credentials from './Credentials';
import Deliveries from './Deliveries';
import Icon from './Icon';
import MCPConnections from './MCPConnections';
import ModelConfiguration from './ModelConfiguration';
import RepoCreations from './RepoCreations';
import Select from './components/Select';
import './integrations.css';

function failure(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'The operation could not be confirmed. Refresh status before retrying.';
}

export default function Integrations({
  api,
  onChanged,
  includeModels = true,
}: {
  api: Api;
  onChanged: () => Promise<void>;
  includeModels?: boolean;
}) {
  const [items, setItems] = useState<IntegrationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [credentialsFor, setCredentialsFor] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.integrations());
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
  const changed = async () => {
    await load();
    await onChanged();
  };
  const toggle = async (item: IntegrationInfo) => {
    if (busy) return;
    setBusy(item.id);
    setError('');
    setNotice('');
    try {
      const next = await api.setIntegrationState(item.id, {
        enabled: !item.enabled,
        expected_revision: item.revision,
      });
      setItems((current) => current.map((value) => (value.id === next.id ? next : value)));
      setNotice(
        next.enabled
          ? `${item.title}: connection enabled.`
          : `${item.title}: new calls are blocked. Calls already in progress may finish.`,
      );
      await onChanged();
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(null);
    }
  };
  const selected = items.find((item) => item.id === credentialsFor);
  const readConnection = items.find((item) => item.id === 'github.read');
  return (
    <div className="integrations">
      <section aria-labelledby="integrations-title">
        <div className="section-heading">
          <div>
            <h2 id="integrations-title">Integrations and tools</h2>
            <p className="muted">
              Control the services the factory may use and the credentials for each connection.
            </p>
          </div>
          <button
            className="button small"
            type="button"
            onClick={() => void load()}
            disabled={loading || !!busy}
          >
            <Icon name="refresh" />
            Refresh connections
          </button>
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
        {loading && !items.length && <p role="status">Loading connections…</p>}
        <div className="integration-grid">
          {items.map((item) => (
            <article className="integration-card" key={item.id} aria-labelledby={`integration-${item.id}`}>
              <div className="integration-heading">
                <Icon name={item.kind === 'github' ? 'projects' : 'settings'} />
                <h3 id={`integration-${item.id}`}>{item.title}</h3>
                <span
                  className={`integration-state ${item.toggleable && !item.enabled ? 'is-disabled' : ''}`}
                >
                  {item.toggleable
                    ? item.enabled
                      ? 'Enabled'
                      : 'Disabled'
                    : item.kind === 'model'
                      ? 'Configuration by role'
                      : 'Instance configuration'}
                </span>
              </div>
              <p>{item.description}</p>
              <p className="muted">{item.access}</p>
              {!!item.tools.length && (
                <details>
                  <summary>Available tools ({item.tools.length})</summary>
                  <ul className="integration-tools">
                    {item.tools.map((tool) => (
                      <li key={tool.name}>
                        <code>{tool.name}</code>
                        <span>
                          {tool.effect === 'read'
                            ? 'Read'
                            : tool.effect === 'external_write'
                              ? 'Controlled external write'
                              : tool.effect === 'configuration'
                                ? 'Local configuration'
                                : tool.effect}
                          {tool.roles.length ? ` · ${tool.roles.join(', ')}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="integration-actions">
                {!!item.credential_ids.length && (
                  <button
                    className="button small"
                    type="button"
                    onClick={() => setCredentialsFor(credentialsFor === item.id ? null : item.id)}
                    aria-expanded={credentialsFor === item.id}
                    aria-label={`${item.credential_configured ? 'Manage credentials' : 'Configure credentials'} of ${item.title}`}
                  >
                    {item.credential_configured ? 'Manage credentials' : 'Configure credentials'}
                    <span className="sr-only"> of {item.title}</span>
                  </button>
                )}
                {item.toggleable && (
                  <button
                    className="button small"
                    type="button"
                    disabled={!!busy}
                    onClick={() => void toggle(item)}
                    aria-label={`${busy === item.id ? 'Saving' : item.enabled ? 'Disable' : 'Enable'} ${item.title}`}
                  >
                    {busy === item.id ? 'Saving…' : item.enabled ? 'Disable' : 'Enable'}
                    <span className="sr-only"> {item.title}</span>
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        {selected && (
          <section className="integration-credentials" aria-label={`Credentials for ${selected.title}`}>
            <div className="section-heading">
              <h3>{selected.title}</h3>
              <button className="button small" type="button" onClick={() => setCredentialsFor(null)}>
                Close credentials
              </button>
            </div>
            <Credentials
              key={selected.id}
              api={api}
              onChanged={changed}
              targetIds={selected.credential_ids}
            />
          </section>
        )}
      </section>
      {includeModels && <ModelConfiguration api={api} onChanged={changed} />}
      {readConnection && (
        <GitHubRepositories api={api} enabled={readConnection.enabled} onChanged={onChanged} />
      )}
      <MCPConnections api={api} onChanged={changed} />
      <RepoCreations api={api} />
      <Deliveries api={api} />
    </div>
  );
}

export function GitHubRepositories({
  api,
  enabled,
  onChanged,
}: {
  api: Api;
  enabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const id = useId();
  const [owner, setOwner] = useState('');
  const [ownerType, setOwnerType] = useState<'user' | 'org'>('org');
  const [query, setQuery] = useState<{ owner: string; owner_type: 'user' | 'org' } | null>(null);
  const [page, setPage] = useState<GitHubRepositoryPage | null>(null);
  const [selected, setSelected] = useState<GitHubRepositoryInfo | null>(null);
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<'node' | 'python'>('node');
  const [commands, setCommands] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const search = async (request: { owner: string; owner_type: 'user' | 'org' }, nextPage: number) => {
    if (busy || !enabled) return;
    setBusy(true);
    setError('');
    setNotice('');
    setSelected(null);
    try {
      const result = await api.githubRepositories({ ...request, page: nextPage });
      setPage(result);
      setQuery(request);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void search({ owner: owner.trim(), owner_type: ownerType }, 1);
  };
  const choose = (repository: GitHubRepositoryInfo) => {
    setSelected(repository);
    setName(repository.full_name.split('/')[1]);
    setCommands('');
    setError('');
    setNotice('');
  };
  const importRepository = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || busy || !enabled) return;
    let gates: string[][];
    try {
      gates = commands
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const value: unknown = JSON.parse(line);
          if (
            !Array.isArray(value) ||
            !value.length ||
            !value.every((arg) => typeof arg === 'string' && arg.length)
          )
            throw new Error();
          return value as string[];
        });
      if (!gates.length) throw new Error();
    } catch {
      setError('Enter one JSON argument array per line, for example ["npm", "test"].');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const [repositoryOwner, repository] = selected.full_name.split('/');
      const project = await api.importGitHubRepository({
        owner: repositoryOwner,
        repository,
        name,
        profile,
        gate_commands: gates,
      });
      setNotice(`${project.name} is registered in Projects. Start a run when needed.`);
      setSelected(null);
      await onChanged();
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="github-browser" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>GitHub repositories</h2>
      <p className="muted">
        Browse an account and import an existing repository. Import registers it with SABRE without changing
        GitHub or starting work.
      </p>
      {!enabled && <p className="notice neutral">Enable GitHub repository access to browse and import.</p>}
      <form className="repository-search" onSubmit={submit}>
        <label htmlFor={`${id}-type`}>
          Account type
          <Select
            id={`${id}-type`}
            value={ownerType}
            disabled={busy}
            onChange={(event) => setOwnerType(event.target.value as 'user' | 'org')}
          >
            <option value="org">Organization</option>
            <option value="user">User · public repositories</option>
          </Select>
        </label>
        <label htmlFor={`${id}-owner`}>
          User or organization
          <input
            id={`${id}-owner`}
            value={owner}
            required
            maxLength={39}
            placeholder="github-name"
            disabled={busy}
            onChange={(event) => setOwner(event.target.value)}
          />
        </label>
        <button className="button primary" type="submit" disabled={!enabled || busy}>
          {busy && !selected ? 'Searching…' : 'Search repositories'}
        </button>
      </form>
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
      {page && (
        <div aria-live="polite">
          <p className="muted">
            {page.access === 'public'
              ? 'Showing public repositories.'
              : 'Showing repositories accessible with the read credential.'}{' '}
            Page {page.page}.
          </p>
          {!page.items.length && <p>No repositories found on this page.</p>}
          <ul className="repository-list">
            {page.items.map((repository) => (
              <li key={repository.id}>
                <div>
                  <a href={repository.url} target="_blank" rel="noreferrer">
                    {repository.full_name}
                  </a>
                  <p>{repository.description}</p>
                  <span className="muted">
                    {repository.visibility === 'private' ? 'Private' : 'Public'}
                    {repository.language ? ` · ${repository.language}` : ''}
                    {repository.archived ? ' · Archived' : ''}
                    {repository.disabled ? ' · Unavailable' : ''}
                  </span>
                </div>
                <button
                  className="button small"
                  type="button"
                  disabled={
                    busy ||
                    !enabled ||
                    repository.archived ||
                    repository.disabled ||
                    !repository.default_branch
                  }
                  onClick={() => choose(repository)}
                  aria-label={`Import ${repository.full_name}`}
                >
                  Import<span className="sr-only"> {repository.full_name}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="integration-actions">
            <button
              className="button small"
              type="button"
              disabled={busy || !enabled || page.page <= 1}
              onClick={() => query && void search(query, page.page - 1)}
            >
              Previous page
            </button>
            <button
              className="button small"
              type="button"
              disabled={busy || !enabled || !page.next_page}
              onClick={() => query && page.next_page && void search(query, page.next_page)}
            >
              Next page
            </button>
          </div>
        </div>
      )}
      {selected && (
        <form
          className="repository-import"
          onSubmit={(event) => void importRepository(event)}
          aria-labelledby={`${id}-import-heading`}
        >
          <h3 id={`${id}-import-heading`}>Import {selected.full_name}</h3>
          <p className="muted">SABRE will check the repository again and use its default branch.</p>
          <label htmlFor={`${id}-name`}>
            Project name
            <input
              id={`${id}-name`}
              value={name}
              required
              maxLength={100}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label htmlFor={`${id}-profile`}>
            Project environment
            <Select
              id={`${id}-profile`}
              value={profile}
              disabled={busy}
              onChange={(event) => setProfile(event.target.value as 'node' | 'python')}
            >
              <option value="node">JavaScript / TypeScript</option>
              <option value="python">Python</option>
            </Select>
          </label>
          <label htmlFor={`${id}-commands`}>
            Delivery checks
            <textarea
              id={`${id}-commands`}
              value={commands}
              required
              rows={3}
              disabled={busy}
              placeholder={'["npm", "test"]'}
              onChange={(event) => setCommands(event.target.value)}
              aria-describedby={`${id}-commands-hint`}
            />
          </label>
          <p className="muted" id={`${id}-commands-hint`}>
            One argument array per line. Enter the actual repository verification commands.
          </p>
          <div className="integration-actions">
            <button className="button primary" type="submit" disabled={busy || !enabled}>
              {busy ? 'Importing…' : 'Register project'}
            </button>
            <button className="button small" type="button" disabled={busy} onClick={() => setSelected(null)}>
              Cancel import
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

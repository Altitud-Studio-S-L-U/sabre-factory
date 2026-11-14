import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  ApiError,
  type Api,
  type ConnectedRepositories,
  type GitHubRepositoryInfo,
  type GitHubRepositoryPage,
} from '../../api';
import Button from '../../components/Button';
import Field from '../../components/FormField';
import Input from '../../components/Input';
import Notice from '../../components/Notice';
import { SectionHeading } from '../../components/PageHeader';
import Select from '../../components/Select';
import Textarea from '../../components/Textarea';
import { cn } from '../../lib/utils';

function failure(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'The operation could not be confirmed. Refresh status before retrying.';
}

/** Browse a GitHub account and register one of its repositories as a project. Starts no work. */
export default function GitHubRepositories({
  api,
  enabled,
  installed = false,
  onChanged,
  className,
}: {
  api: Api;
  enabled: boolean;
  /** The GitHub App is installed: its repositories are listed directly instead of searching an account. */
  installed?: boolean;
  onChanged: () => Promise<void>;
  className?: string;
}) {
  const id = useId();
  const [reachable, setReachable] = useState<ConnectedRepositories | null>(null);
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
  const listed = installed && enabled;
  useEffect(() => {
    if (!listed) return;
    let current = true;
    api.githubConnectedRepositories(1).then(
      (result) => current && setReachable(result),
      (reason: unknown) => current && setError(failure(reason)),
    );
    return () => {
      current = false;
    };
  }, [api, listed]);
  const turn = async (next: number) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setSelected(null);
    try {
      setReachable(await api.githubConnectedRepositories(next));
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
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
    <section className={cn('grid min-w-0 gap-4', className)} aria-labelledby={`${id}-heading`}>
      <SectionHeading
        id={`${id}-heading`}
        title="GitHub repositories"
        description={
          installed
            ? 'The repositories the GitHub connection reaches. Import registers one with SABRE without changing GitHub or starting work.'
            : 'Browse an account and import an existing repository. Import registers it with SABRE without changing GitHub or starting work.'
        }
      />
      {!enabled && <Notice tone="neutral">Enable GitHub repository access to browse and import.</Notice>}
      {listed && (
        <div aria-live="polite" className="grid min-w-0 gap-3">
          {!reachable && !error && (
            <p className="text-sm text-muted-foreground">Reading the connection's repositories…</p>
          )}
          {reachable && !reachable.items.length && (
            <p className="text-sm">
              The GitHub App reaches no repository yet. Choose some on GitHub and return.
            </p>
          )}
          {!!reachable?.items.length && (
            <>
              <p className="text-sm text-muted-foreground">
                {reachable.total} {reachable.total === 1 ? 'repository' : 'repositories'} through the GitHub
                connection. Page {reachable.page}.
              </p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {reachable.items.map((repository) => (
                  <li
                    key={repository.id}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="grid min-w-0 flex-1 gap-1 [overflow-wrap:anywhere]">
                      <a
                        href={repository.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-semibold text-link underline-offset-4 hover:underline"
                      >
                        {repository.full_name}
                      </a>
                      <span className="text-xs text-muted-foreground">
                        {repository.visibility === 'private' ? 'Private' : 'Public'}
                        {repository.default_branch ? ` · ${repository.default_branch}` : ' · No branch yet'}
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={busy || !repository.default_branch}
                      onClick={() =>
                        choose({
                          ...repository,
                          archived: false,
                          disabled: false,
                          description: '',
                          language: null,
                        })
                      }
                      aria-label={`Import ${repository.full_name}`}
                    >
                      Import<span className="sr-only"> {repository.full_name}</span>
                    </Button>
                  </li>
                ))}
              </ul>
              {(reachable.page > 1 || reachable.next_page) && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={busy || reachable.page <= 1}
                    onClick={() => void turn(reachable.page - 1)}
                  >
                    Previous page
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={busy || !reachable.next_page}
                    onClick={() => reachable.next_page && void turn(reachable.next_page)}
                  >
                    Next page
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <form
        className="grid min-w-0 items-end gap-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        onSubmit={submit}
        hidden={listed}
      >
        <Field label="Account type">
          <Select
            value={ownerType}
            disabled={busy}
            onChange={(event) => setOwnerType(event.target.value as 'user' | 'org')}
          >
            <option value="org">Organization</option>
            <option value="user">User · public repositories</option>
          </Select>
        </Field>
        <Field label="User or organization">
          <Input
            value={owner}
            required
            maxLength={39}
            placeholder="github-name"
            disabled={busy}
            onChange={(event) => setOwner(event.target.value)}
          />
        </Field>
        <Button variant="primary" type="submit" disabled={!enabled || busy}>
          {busy && !selected ? 'Searching…' : 'Search repositories'}
        </Button>
      </form>
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
      {page && (
        <div aria-live="polite" className="grid min-w-0 gap-3">
          <p className="text-sm text-muted-foreground">
            {page.access === 'public'
              ? 'Showing public repositories.'
              : 'Showing repositories accessible with the read credential.'}{' '}
            Page {page.page}.
          </p>
          {!page.items.length && <p className="text-sm">No repositories found on this page.</p>}
          {!!page.items.length && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {page.items.map((repository) => (
                <li
                  key={repository.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="grid min-w-0 flex-1 gap-1 [overflow-wrap:anywhere]">
                    <a
                      href={repository.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-semibold text-link underline-offset-4 hover:underline"
                    >
                      {repository.full_name}
                    </a>
                    {repository.description && <p className="text-sm">{repository.description}</p>}
                    <span className="text-xs text-muted-foreground">
                      {repository.visibility === 'private' ? 'Private' : 'Public'}
                      {repository.language ? ` · ${repository.language}` : ''}
                      {repository.archived ? ' · Archived' : ''}
                      {repository.disabled ? ' · Unavailable' : ''}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
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
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={busy || !enabled || page.page <= 1}
              onClick={() => query && void search(query, page.page - 1)}
            >
              Previous page
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={busy || !enabled || !page.next_page}
              onClick={() => query && page.next_page && void search(query, page.next_page)}
            >
              Next page
            </Button>
          </div>
        </div>
      )}
      {selected && (
        <form
          className="grid min-w-0 gap-4 border-t border-border pt-5"
          onSubmit={(event) => void importRepository(event)}
          aria-labelledby={`${id}-import-heading`}
        >
          <div className="grid gap-1">
            <h3 id={`${id}-import-heading`} className="text-base font-semibold [overflow-wrap:anywhere]">
              Import {selected.full_name}
            </h3>
            <p className="text-sm text-muted-foreground">
              SABRE will check the repository again and use its default branch.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project name">
              <Input
                value={name}
                required
                maxLength={100}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Project environment">
              <Select
                value={profile}
                disabled={busy}
                onChange={(event) => setProfile(event.target.value as 'node' | 'python')}
              >
                <option value="node">JavaScript / TypeScript</option>
                <option value="python">Python</option>
              </Select>
            </Field>
          </div>
          <Field
            label="Delivery checks"
            hint="One argument array per line. Enter the actual repository verification commands."
          >
            <Textarea
              value={commands}
              required
              rows={3}
              disabled={busy}
              placeholder={'["npm", "test"]'}
              className="font-mono text-xs"
              onChange={(event) => setCommands(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit" disabled={busy || !enabled}>
              {busy ? 'Importing…' : 'Register project'}
            </Button>
            <Button variant="secondary" type="button" disabled={busy} onClick={() => setSelected(null)}>
              Cancel import
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

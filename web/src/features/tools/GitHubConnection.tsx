import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, type Api, type ConnectedRepositories, type GitHubConnectionView } from '../../api';
import Button from '../../components/Button';
import { buttonVariants } from '../../components/ui/button';
import DescriptionList from '../../components/DescriptionList';
import Experimental from '../../components/Experimental';
import Dialog, { DialogActions } from '../../components/Dialog';
import Field from '../../components/FormField';
import Input from '../../components/Input';
import LoadingState from '../../components/LoadingState';
import Notice from '../../components/Notice';
import Select from '../../components/Select';
import { Card, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';

function failure(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'GitHub could not be reached. Check the connection and try again.';
}

/** An answer that names one of the three states; anything else is not a connection to show. */
function known(value: unknown): value is GitHubConnectionView {
  const state = (value as { state?: unknown } | null)?.state;
  return state === 'not_connected' || state === 'registered' || state === 'connected';
}

/** What GitHub appends to the console's address when it sends the owner back. */
const RETURN_PARAMETERS = ['github', 'code', 'state', 'installation_id', 'setup_action'];

/** Post the manifest to GitHub from the owner's browser: a form with one field, as GitHub's flow requires. */
function postManifest(action: string, manifest: string) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  form.hidden = true;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
}

/**
 * The one GitHub connection of the factory. Not connected, it explains what connecting does and
 * starts it. Registered, it sends the owner to choose repositories. Connected, it shows the
 * account, the app and what the installation reaches, with the way back to GitHub and Disconnect.
 */
export default function GitHubConnection({
  api,
  online,
  onChanged,
}: {
  api: Api;
  online: boolean;
  onChanged: (view: GitHubConnectionView) => void;
}) {
  const titleId = useId();
  const [view, setView] = useState<GitHubConnectionView | null>(null);
  const [repositories, setRepositories] = useState<ConnectedRepositories | null>(null);
  const [account, setAccount] = useState<'personal' | 'organization'>('personal');
  const [organization, setOrganization] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [removed, setRemoved] = useState<GitHubConnectionView | null>(null);
  const [confirm, setConfirm] = useState(false);
  const started = useRef(false);
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    // Once per mount: a code from GitHub is single-use and must never be sent twice.
    if (started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    const step = url.searchParams.get('github');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const installation = url.searchParams.get('installation_id');
    if (step) {
      // Out of the address at once, so a reload or a shared link cannot replay it.
      for (const name of RETURN_PARAMETERS) url.searchParams.delete(name);
      window.history.replaceState(window.history.state, '', url);
    }
    const next =
      step === 'registered' && code && state
        ? api.githubConversion({ code, state })
        : step === 'installed'
          ? api.githubInstallation(
              installation && /^\d{1,16}$/.test(installation)
                ? { installation_id: Number(installation) }
                : undefined,
            )
          : api.githubConnection();
    next
      .then(
        (result) => {
          if (!known(result))
            return setError('The GitHub connection could not be read. Refresh and try again.');
          setView(result);
          changed.current(result);
        },
        (reason: unknown) => {
          setError(failure(reason));
          // The step failed; show where the connection actually stands.
          return api.githubConnection().then(
            (current) => known(current) && setView(current),
            () => undefined,
          );
        },
      )
      .finally(() => setBusy(false));
  }, [api]);

  const connected = view?.state === 'connected';
  useEffect(() => {
    if (!connected) return;
    let current = true;
    api.githubConnectedRepositories(1).then(
      (page) => current && setRepositories(page),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [api, connected]);

  const run = async (action: () => Promise<GitHubConnectionView>) => {
    setBusy(true);
    setError('');
    try {
      const result = await action();
      setView(result);
      changed.current(result);
      return result;
    } catch (reason) {
      setError(failure(reason));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setRemoved(null);
    try {
      const form = await api.githubManifest({
        account,
        organization: account === 'organization' ? organization.trim() : null,
      });
      // The form leaves this page for github.com and nowhere else.
      if (!form.action.startsWith('https://github.com/')) throw new Error('unexpected destination');
      postManifest(form.action, form.manifest);
    } catch (reason) {
      setError(failure(reason));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setConfirm(false);
    setRepositories(null);
    const result = await run(() => api.githubDisconnect());
    if (result) setRemoved(result);
  };

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader>
        <div className="grid min-w-0 gap-1">
          <CardTitle id={titleId} as="h3" className="text-base">
            GitHub connection
          </CardTitle>
          <CardDescription>
            {connected
              ? 'Reading and delivering use this app. Each operation gets a short-lived token for one repository.'
              : 'One connection instead of pasted tokens: you choose on GitHub which repositories the factory may use.'}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Experimental reason="It was exercised against a synthetic GitHub and has not been connected to github.com yet." />
          {view && (
            <Badge variant={connected ? 'success' : view.state === 'registered' ? 'warning' : 'neutral'}>
              {connected ? 'Connected' : view.state === 'registered' ? 'Not installed yet' : 'Not connected'}
            </Badge>
          )}
        </div>
      </CardHeader>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {removed && (
        <Notice tone="neutral" role="status" title="Disconnected from this factory.">
          <p>
            The app's credentials were removed here. Nothing was changed on GitHub: uninstall or delete the
            app there to remove its access.{' '}
            {(removed.manage_url ?? removed.app?.url) && (
              <a
                className="text-link underline underline-offset-2"
                href={removed.manage_url ?? removed.app?.url}
                target="_blank"
                rel="noreferrer"
              >
                Open it on GitHub
              </a>
            )}
          </p>
        </Notice>
      )}
      {!view ? (
        busy && <LoadingState label="Reading the GitHub connection…" />
      ) : view.state === 'not_connected' ? (
        <form className="grid min-w-0 gap-4" onSubmit={(event) => void connect(event)}>
          <p className="max-w-[72ch] text-sm text-muted-foreground">
            Connecting registers a private GitHub App for this factory on your account and returns here.
            Nothing is pasted: GitHub hands the app's key to the factory, and you then choose the repositories
            it may read and deliver to. Tokens saved below keep working until you connect.
          </p>
          <div className="grid min-w-0 items-end gap-3.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <Field label="Owner of the app" hint="A private app installs only on the account that owns it.">
              <Select
                value={account}
                disabled={busy}
                onChange={(event) => setAccount(event.target.value as 'personal' | 'organization')}
              >
                <option value="personal">My personal account</option>
                <option value="organization">An organization</option>
              </Select>
            </Field>
            {account === 'organization' && (
              <Field label="Organization">
                <Input
                  value={organization}
                  required
                  maxLength={39}
                  pattern="[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?"
                  placeholder="organization-name"
                  disabled={busy}
                  onChange={(event) => setOrganization(event.target.value)}
                />
              </Field>
            )}
          </div>
          <div>
            <Button variant="primary" type="submit" disabled={busy || !online}>
              {busy ? 'Opening GitHub…' : 'Connect GitHub'}
            </Button>
          </div>
        </form>
      ) : view.state === 'registered' ? (
        <div className="grid min-w-0 gap-4">
          <p className="max-w-[72ch] text-sm text-muted-foreground">
            The app <strong className="font-medium text-foreground">{view.app?.name}</strong> is registered on{' '}
            {view.app?.owner}. Install it on the repositories the factory may use, then return here.
          </p>
          <div className="flex flex-wrap gap-2">
            {view.install_url && (
              <a className={buttonVariants({ variant: 'default' })} href={view.install_url}>
                Choose repositories on GitHub
              </a>
            )}
            <Button
              type="button"
              disabled={busy || !online}
              onClick={() => void run(() => api.githubInstallation())}
            >
              {busy ? 'Checking…' : 'I installed it'}
            </Button>
            <Button type="button" variant="ghost" disabled={busy || !online} onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 gap-4">
          <DescriptionList
            label="GitHub connection"
            termWidth="9rem"
            items={[
              [
                'Account',
                `${view.account?.login} · ${view.account?.type === 'Organization' ? 'organization' : 'personal account'}`,
              ],
              ['App', view.app?.name],
              [
                'Repositories',
                repositories
                  ? `${repositories.total} ${repositories.total === 1 ? 'repository' : 'repositories'}${
                      view.account?.repository_selection === 'all'
                        ? ' · every repository of the account'
                        : ' · selected on GitHub'
                    }`
                  : 'Reading…',
              ],
            ]}
          />
          {!!repositories?.items.length && (
            <ul
              aria-label="Repositories the connection reaches"
              className="flex min-w-0 flex-wrap gap-1.5 text-xs text-muted-foreground"
            >
              {repositories.items.map((repository) => (
                <li key={repository.id} className="rounded-md border border-border px-2 py-1 font-mono">
                  {repository.full_name}
                </li>
              ))}
              {repositories.total > repositories.items.length && (
                <li className="px-1 py-1">and {repositories.total - repositories.items.length} more</li>
              )}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {view.manage_url && (
              <a
                className={buttonVariants({ variant: 'secondary' })}
                href={view.manage_url}
                target="_blank"
                rel="noreferrer"
              >
                Manage on GitHub
              </a>
            )}
            <Button type="button" variant="ghost" disabled={busy || !online} onClick={() => setConfirm(true)}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Disconnect GitHub"
        description="This removes the app's key and client secret from the factory. Reading and delivering go back to the tokens saved below, if any."
      >
        <p className="text-sm text-muted-foreground">
          Nothing is revoked on GitHub. To remove the app's access there, uninstall or delete it from your
          GitHub settings.
        </p>
        <DialogActions>
          <Button type="button" onClick={() => setConfirm(false)}>
            Keep connected
          </Button>
          <Button type="button" variant="danger" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, type Api, type SecretMetadata, type SecretTarget } from './api';
import Button from './components/Button';
import Dialog, { DialogActions } from './components/Dialog';
import Field from './components/FormField';
import Input from './components/Input';
import LoadingState from './components/LoadingState';
import Notice from './components/Notice';
import Select from './components/Select';
import { Badge } from './components/ui/badge';

type Editor = { id: string; expectedVersion: number | null };

function credentialError(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<number, string> = {
      0: 'The operation could not be confirmed. Check the connection and refresh metadata.',
      401: 'This session is not authorized. Open SABRE again.',
      403: 'This session cannot manage credentials.',
      409: 'The credential changed in another session. Refresh and select it again.',
      422: 'Review the credential destination and value. You will need to enter the value again.',
      503: 'The credential store is unavailable. Check the SABRE control service.',
    };
    return (
      messages[error.status] || 'The operation could not be confirmed. Refresh metadata before retrying.'
    );
  }
  return 'The operation could not be confirmed. Refresh metadata before retrying.';
}

function metadataOnly(item: SecretMetadata): SecretMetadata {
  return { id: item.id, version: item.version, configured: item.configured, updated_at: item.updated_at };
}

export default function Credentials({
  api,
  onChanged,
  targetIds,
  targetPrefix,
  connected = true,
  embedded = false,
  editRequest = 0,
}: {
  api: Api;
  onChanged: () => Promise<void>;
  targetIds?: string[];
  targetPrefix?: string;
  connected?: boolean;
  /** Inside a connection's details: no section title, one short note about storage. */
  embedded?: boolean;
  /** Each new value opens the editor once metadata is loaded, on the first destination without a value. */
  editRequest?: number;
}) {
  const [items, setItems] = useState<SecretMetadata[]>([]);
  const [targets, setTargets] = useState<SecretTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deactivating, setDeactivating] = useState<SecretMetadata | null>(null);
  const password = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const loadGeneration = useRef(0);
  const targetFilter = targetIds?.join('\n') ?? null;
  // A new destination scope closes any open editor before its metadata loads; the
  // write-only field unmounts with the editor, so no value survives the change.
  const [scope, setScope] = useState({ api, targetFilter, targetPrefix });
  if (scope.api !== api || scope.targetFilter !== targetFilter || scope.targetPrefix !== targetPrefix) {
    setScope({ api, targetFilter, targetPrefix });
    setHasSecret(false);
    setEditor(null);
    setDeactivating(null);
    setLoading(true);
  }
  // A request made from outside (the row's "Add token") waits for the destinations to load.
  const [handledRequest, setHandledRequest] = useState(0);
  if (editRequest !== handledRequest && !loading && !loadError && !busy && connected && targets.length) {
    const target =
      targets.find((candidate) => !items.some((item) => item.id === candidate.id && item.configured)) ||
      targets[0];
    setHandledRequest(editRequest);
    setHasSecret(false);
    setActionError('');
    setNotice('');
    setRefreshWarning(false);
    setDeactivating(null);
    setEditor({
      id: target.id,
      expectedVersion: items.find((item) => item.id === target.id)?.version ?? null,
    });
  }
  // State is applied in promise callbacks, so the mount effect never sets state synchronously.
  const fetchMetadata = useCallback(() => {
    const generation = (loadGeneration.current += 1);
    return Promise.all([api.secrets(), api.secretTargets()])
      .then(
        ([metadata, nextTargets]) => {
          if (generation !== loadGeneration.current) return;
          const allowed = targetFilter === null ? null : new Set(targetFilter.split('\n'));
          setItems(
            metadata
              .filter(
                (item) =>
                  (!allowed || allowed.has(item.id)) && (!targetPrefix || item.id.startsWith(targetPrefix)),
              )
              .map(metadataOnly)
              .sort((a, b) => a.id.localeCompare(b.id)),
          );
          setTargets(
            nextTargets
              .filter(
                (item) =>
                  (!allowed || allowed.has(item.id)) && (!targetPrefix || item.id.startsWith(targetPrefix)),
              )
              .map(({ id, label }) => ({ id, label })),
          );
          setLoadError('');
        },
        (error: unknown) => {
          if (generation === loadGeneration.current) setLoadError(credentialError(error));
        },
      )
      .finally(() => {
        if (generation === loadGeneration.current) setLoading(false);
      });
  }, [api, targetFilter, targetPrefix]);
  useEffect(() => {
    void fetchMetadata();
    return () => {
      loadGeneration.current += 1;
    };
  }, [fetchMetadata]);
  const load = async () => {
    if (password.current) password.current.value = '';
    setHasSecret(false);
    setEditor(null);
    setDeactivating(null);
    setLoading(true);
    await fetchMetadata();
  };

  const label = (id: string) => targets.find((target) => target.id === id)?.label || id;
  const choose = (id: string) => {
    if (password.current) password.current.value = '';
    setHasSecret(false);
    setActionError('');
    setNotice('');
    setRefreshWarning(false);
    setDeactivating(null);
    setEditor({ id, expectedVersion: items.find((item) => item.id === id)?.version ?? null });
  };
  const merge = (item: SecretMetadata) =>
    setItems((current) =>
      [...current.filter((value) => value.id !== item.id), metadataOnly(item)].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
  const refreshPublicStatus = async () => {
    try {
      await onChanged();
      setRefreshWarning(false);
    } catch {
      setRefreshWarning(true);
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || !password.current || !password.current.value || busy || !connected) return;
    const value = password.current.value;
    password.current.value = '';
    setHasSecret(false);
    const selected = editor;
    setBusy(true);
    setActionError('');
    setNotice('');
    setRefreshWarning(false);
    void (async () => {
      try {
        const saved = await api.upsertSecret(selected.id, {
          value,
          expected_version: selected.expectedVersion,
        });
        merge(saved);
        setEditor(null);
        setNotice(`Credential saved for ${label(saved.id)}. Version ${saved.version}.`);
        await refreshPublicStatus();
      } catch (error) {
        setEditor(null);
        setActionError(credentialError(error));
        await load();
      } finally {
        setBusy(false);
      }
    })();
  };
  const deactivate = async () => {
    if (!deactivating || busy || !connected) return;
    const selected = deactivating;
    setBusy(true);
    setActionError('');
    setNotice('');
    setRefreshWarning(false);
    try {
      const saved = await api.deactivateSecret(selected.id, { expected_version: selected.version });
      merge(saved);
      setNotice(
        `Credential disabled in SABRE. Version ${saved.version}. It has not been revoked at the provider.`,
      );
      await refreshPublicStatus();
    } catch (error) {
      setActionError(credentialError(error));
      await load();
    } finally {
      setDeactivating(null);
      setBusy(false);
    }
  };
  const available = !loading && !loadError && !busy && connected;
  return (
    <section
      className="grid min-w-0 gap-4"
      aria-labelledby={embedded ? undefined : titleId}
      aria-label={embedded ? 'Stored credential' : undefined}
    >
      {(!embedded || loadError) && (
        <div className="grid min-w-0 gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            {!embedded && (
              <h2 id={titleId} className="text-base font-semibold">
                SABRE credentials
              </h2>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={loading || busy}
              onClick={() => {
                if (password.current) password.current.value = '';
                setEditor(null);
                setDeactivating(null);
                setNotice('');
                setRefreshWarning(false);
                setActionError('');
                void load();
              }}
            >
              Refresh metadata
            </Button>
          </div>
          {!embedded && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Credentials are encrypted in the control database. The master key stays outside that database.
              The control service decrypts values in memory when making calls.
            </p>
          )}
        </div>
      )}
      {loadError && (
        <Notice tone="danger" role="alert">
          {loadError} Visible metadata may be outdated.
        </Notice>
      )}
      {actionError && (
        <Notice tone="danger" role="alert">
          {actionError}
        </Notice>
      )}
      {notice && (
        <Notice tone="neutral" role="status">
          {notice}
        </Notice>
      )}
      {refreshWarning && (
        <Notice
          tone="warning"
          role="status"
          actions={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void refreshPublicStatus()}
            >
              Refresh overall status
            </Button>
          }
        >
          <p>The credential operation is confirmed. Overall status could not be refreshed.</p>
        </Notice>
      )}
      {loading && <LoadingState label="Loading credential metadata…" />}
      {!loading && !loadError && items.length === 0 && (
        <p
          className={
            embedded
              ? 'text-sm text-muted-foreground'
              : 'rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground'
          }
        >
          No saved credentials yet.
        </p>
      )}
      {items.length > 0 && (
        <div className="@container divide-y divide-border rounded-lg border border-border">
          {items.map((item) => {
            const target = targets.find((candidate) => candidate.id === item.id);
            return (
              <article
                className="grid min-w-0 gap-3 px-4 py-3.5 @md:grid-cols-[minmax(0,1fr)_auto] @md:items-start"
                key={item.id}
              >
                <div className="grid min-w-0 gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">
                      {target?.label || item.id}
                    </h3>
                    <Badge variant={item.configured ? 'success' : 'warning'}>
                      {item.configured ? 'Configured' : 'Disabled'}
                    </Badge>
                  </div>
                  <p>
                    <code className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {item.id}
                    </code>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Version {item.version} · Updated {new Date(item.updated_at).toLocaleString('en-US')}
                  </p>
                  {!target && (
                    <small className="text-xs text-warning">
                      Outside the destinations registered by this instance.
                    </small>
                  )}
                </div>
                {(target || item.configured) && (
                  <div className="flex flex-wrap items-center gap-1">
                    {target && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={`${item.configured ? 'Replace' : 'Configure'} ${target.label}`}
                        disabled={!available}
                        onClick={() => choose(item.id)}
                      >
                        {item.configured ? 'Replace' : 'Configure'}
                      </Button>
                    )}
                    {item.configured && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-danger hover:enabled:bg-danger-bg"
                        aria-label={`Disable ${target?.label || item.id}`}
                        disabled={!available}
                        onClick={() => {
                          if (password.current) password.current.value = '';
                          setEditor(null);
                          setNotice('');
                          setRefreshWarning(false);
                          setActionError('');
                          setDeactivating(item);
                        }}
                      >
                        Disable
                      </Button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      <Dialog
        open={!!deactivating}
        title="Disable credential"
        busy={busy}
        onClose={() => setDeactivating(null)}
      >
        {deactivating && (
          <div className="grid gap-5">
            <Notice tone="warning" title={`Disable ${label(deactivating.id)} in SABRE?`}>
              <p>
                The stored value will be removed. This does not revoke the credential at the external
                provider.
              </p>
            </Notice>
            <DialogActions>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setDeactivating(null)}>
                Back
              </Button>
              <Button type="button" variant="danger" disabled={busy} onClick={() => void deactivate()}>
                Confirm deactivation
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
      {!editor && (
        <Button
          type="button"
          variant="secondary"
          className="justify-self-start"
          disabled={!available || targets.length === 0}
          onClick={() => {
            const target =
              targets.find(
                (candidate) => !items.some((item) => item.id === candidate.id && item.configured),
              ) || targets[0];
            if (target) choose(target.id);
          }}
        >
          Save credential
        </Button>
      )}
      <Dialog
        open={!!editor}
        title="Save credential"
        description="Write-only value bound to one registered destination."
        busy={busy}
        dirty={hasSecret}
        onClose={() => {
          if (password.current) password.current.value = '';
          setHasSecret(false);
          setEditor(null);
        }}
      >
        {editor && (
          <form className="grid min-w-0 gap-5" onSubmit={submit} autoComplete="off">
            <h3 className="text-base font-semibold">
              {editor.expectedVersion === null
                ? 'Save a credential'
                : `Replace version ${editor.expectedVersion}`}
            </h3>
            <Field label="Credential destination">
              <Select value={editor.id} disabled={busy} onChange={(event) => choose(event.target.value)}>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="New credential value"
              hint="Only the new value is sent. The field clears on submission, including errors. The previous value is never retrieved."
            >
              <Input
                ref={password}
                type="password"
                required
                maxLength={65536}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                disabled={busy}
                onChange={(event) => setHasSecret(event.target.value.length > 0)}
              />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <span className="text-xs text-muted-foreground">
                The value will be saved for this destination and version.
              </span>
              <Button type="submit" variant="primary" disabled={!available}>
                {busy
                  ? 'Saving…'
                  : editor.expectedVersion === null
                    ? 'Save encrypted value'
                    : 'Replace encrypted value'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {embedded
          ? 'Stored encrypted and never shown again. Saving a value does not validate it with the provider or start work.'
          : 'Configure provider, model and spending limits in the instance settings. Saving a credential does not validate it with the provider or start work.'}
      </p>
    </section>
  );
}

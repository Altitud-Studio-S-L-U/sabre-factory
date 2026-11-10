import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, type Api, type SecretMetadata, type SecretTarget } from './api';
import Select from './components/Select';

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
}: {
  api: Api;
  onChanged: () => Promise<void>;
  targetIds?: string[];
  targetPrefix?: string;
}) {
  const [items, setItems] = useState<SecretMetadata[]>([]);
  const [targets, setTargets] = useState<SecretTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deactivating, setDeactivating] = useState<SecretMetadata | null>(null);
  const password = useRef<HTMLInputElement>(null);
  const destinationId = useId();
  const valueId = useId();
  const valueHint = useId();
  const loadGeneration = useRef(0);
  const targetFilter = targetIds?.join('\n') ?? null;
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (password.current) password.current.value = '';
    setEditor(null);
    setDeactivating(null);
    setLoading(true);
    try {
      const [metadata, nextTargets] = await Promise.all([api.secrets(), api.secretTargets()]);
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
    } catch (error) {
      if (generation === loadGeneration.current) setLoadError(credentialError(error));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [api, targetFilter, targetPrefix]);
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [load]);

  const label = (id: string) => targets.find((target) => target.id === id)?.label || id;
  const choose = (id: string) => {
    if (password.current) password.current.value = '';
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
    if (!editor || !password.current || !password.current.value || busy) return;
    const value = password.current.value;
    password.current.value = '';
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
    if (!deactivating || busy) return;
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
  const available = !loading && !loadError && !busy;
  return (
    <section className="credentials-section" aria-labelledby="credentials-title">
      <div className="section-heading">
        <h2 id="credentials-title">SABRE credentials</h2>
        <button
          className="button small"
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
        </button>
      </div>
      <p className="credentials-context">
        Credentials are encrypted in the control database. The master key stays outside that database. The
        control service decrypts values in memory when making calls.
      </p>
      {loadError && (
        <div className="notice error" role="alert">
          {loadError} Visible metadata may be outdated.
        </div>
      )}
      {actionError && (
        <div className="notice error" role="alert">
          {actionError}
        </div>
      )}
      {notice && (
        <div className="notice neutral" role="status">
          {notice}
        </div>
      )}
      {refreshWarning && (
        <div className="notice warning" role="status">
          <p>The credential operation is confirmed. Overall status could not be refreshed.</p>
          <button className="button small" disabled={busy} onClick={() => void refreshPublicStatus()}>
            Refresh overall status
          </button>
        </div>
      )}
      {loading && (
        <div className="quiet-state" role="status">
          Loading credential metadata…
        </div>
      )}
      {!loading && !loadError && items.length === 0 && (
        <p className="quiet-state">No saved credentials yet.</p>
      )}
      {items.length > 0 && (
        <div className="credentials-list">
          {items.map((item) => {
            const target = targets.find((candidate) => candidate.id === item.id);
            return (
              <article className="credential-row" key={item.id}>
                <div>
                  <h3>{target?.label || item.id}</h3>
                  <p>
                    <code>{item.id}</code>
                  </p>
                  <p>
                    Version {item.version} · Updated {new Date(item.updated_at).toLocaleString('en-US')}
                  </p>
                  {!target && <small>Outside the destinations registered by this instance.</small>}
                </div>
                <span className={`badge ${item.configured ? 'badge-completed' : 'badge-paused'}`}>
                  {item.configured ? 'Guardada' : 'Desactivada'}
                </span>
                <div className="credential-actions">
                  {target && (
                    <button
                      className="button small"
                      aria-label={`${item.configured ? 'Replace' : 'Configure'} ${target.label}`}
                      disabled={!available}
                      onClick={() => choose(item.id)}
                    >
                      {item.configured ? 'Replace' : 'Configure'}
                    </button>
                  )}
                  {item.configured && (
                    <button
                      className="text-button danger-quiet"
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
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {deactivating && (
        <div className="notice warning">
          <div>
            <strong>Disable {label(deactivating.id)} in SABRE?</strong>
            <p>
              The stored value will be removed. This does not revoke the credential at the external provider.
            </p>
          </div>
          <button className="button danger" disabled={busy} onClick={() => void deactivate()}>
            Confirm deactivation
          </button>
          <button className="text-button" disabled={busy} onClick={() => setDeactivating(null)}>
            Back
          </button>
        </div>
      )}
      {!editor && (
        <button
          className="button"
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
        </button>
      )}
      {editor && (
        <form className="form-panel credential-editor" onSubmit={submit} autoComplete="off">
          <div className="section-heading">
            <h3>
              {editor.expectedVersion === null
                ? 'Save a credential'
                : `Replace version ${editor.expectedVersion}`}
            </h3>
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                if (password.current) password.current.value = '';
                setEditor(null);
              }}
            >
              Close
            </button>
          </div>
          <div className="field">
            <label htmlFor={destinationId}>Credential destination</label>
            <Select
              id={destinationId}
              value={editor.id}
              disabled={busy}
              onChange={(event) => choose(event.target.value)}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label htmlFor={valueId}>New credential value</label>
            <input
              ref={password}
              id={valueId}
              type="password"
              required
              maxLength={65536}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              disabled={busy}
              aria-describedby={valueHint}
            />
            <small id={valueHint}>
              Only the new value is sent. The field clears on submission, including errors. The previous value
              is never retrieved.
            </small>
          </div>
          <div className="form-actions">
            <span>The value will be saved for this destination and version.</span>
            <button className="button primary" disabled={!available}>
              {busy
                ? 'Saving…'
                : editor.expectedVersion === null
                  ? 'Save encrypted value'
                  : 'Replace encrypted value'}
            </button>
          </div>
        </form>
      )}
      <p className="credentials-footnote">
        Configure provider, model and spending limits in the instance settings. Saving a credential does not
        validate it with the provider or start work.
      </p>
    </section>
  );
}

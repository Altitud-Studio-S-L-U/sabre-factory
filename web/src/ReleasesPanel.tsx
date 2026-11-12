import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  type Api,
  type ReleaseCandidate,
  type ReleasePreparation,
  type ReleasePublication,
  type WorkOrder,
} from './api';
import Dialog from './components/Dialog';
import Field from './components/FormField';
import './ReleasesPanel.css';

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const validVersion = (value: string) =>
  semver.test(value) &&
  (value.indexOf('-') < 0 ||
    value
      .slice(value.indexOf('-') + 1)
      .split('.')
      .every((part) => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0')));
const authorizationBlockers = (candidate: ReleaseCandidate) =>
  candidate.blockers.filter((item) => !item.startsWith('RELEASE_AUTHORIZATION_EXPIRED:'));
const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'The release operation could not be confirmed. Refresh the candidate before another command.';
const githubRelease = (value: string | null) => {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
};

export default function ReleasesPanel({
  api,
  work,
  connected = true,
}: {
  api: Api;
  work: Pick<WorkOrder, 'id' | 'status'>;
  connected?: boolean;
}) {
  const [items, setItems] = useState<ReleaseCandidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [prepare, setPrepare] = useState(false);
  const [packageVersion, setPackageVersion] = useState('');
  const [checksText, setChecksText] = useState('');
  const [preparedRequest, setPreparedRequest] = useState<ReleasePreparation | null>(null);
  const [action, setAction] = useState<{ type: 'authorize' | 'publish'; candidate: ReleaseCandidate } | null>(
    null,
  );
  const [authorizationChecked, setAuthorizationChecked] = useState(false);
  const [expires, setExpires] = useState('3600');
  const [confirmedTag, setConfirmedTag] = useState('');
  const [publication, setPublication] = useState<ReleasePublication | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const checks = checksText
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
  const validPreparation =
    validVersion(packageVersion.trim()) &&
    checks.length > 0 &&
    checks.length <= 40 &&
    new Set(checks).size === checks.length &&
    checks.every((item) => item.length <= 200);
  const saveCandidate = useCallback((candidate: ReleaseCandidate) => {
    setItems((current) => [candidate, ...current.filter((item) => item.id !== candidate.id)]);
    setSelectedId(candidate.id);
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const page = await api.releases();
      if (!page || !Array.isArray(page.items)) throw new Error('Invalid release snapshot');
      setItems(page.items.filter((item) => item.work_id === work.id));
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setLoading(false);
    }
  }, [api, work.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const inspect = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      saveCandidate(await api.getRelease(id));
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const prepareCandidate = async () => {
    if (!connected || busy || (!preparedRequest && !validPreparation)) return;
    const request = preparedRequest ?? {
      version: 1 as const,
      work_id: work.id,
      package_version: packageVersion.trim(),
      idempotency_key: `release-prepare:${crypto.randomUUID()}`,
      required_checks: checks,
    };
    setPreparedRequest(request);
    setBusy(true);
    setError('');
    try {
      const candidate = await api.prepareRelease(request);
      saveCandidate(candidate);
      setPrepare(false);
      setPreparedRequest(null);
      setNotice(
        'Immutable candidate prepared. Review its commit, artifacts and live checks before authorizing publication.',
      );
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const chooseAction = async (type: 'authorize' | 'publish') => {
    if (!selected || busy || !connected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const candidate = await api.getRelease(selected.id);
      saveCandidate(candidate);
      setAction({ type, candidate });
      setAuthorizationChecked(false);
      setExpires('3600');
      setConfirmedTag('');
      setPublication(null);
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const authorize = async () => {
    if (
      !action ||
      !connected ||
      action.type !== 'authorize' ||
      busy ||
      !authorizationChecked ||
      !/^\d+$/.test(expires) ||
      Number(expires) < 60 ||
      Number(expires) > 86400 ||
      authorizationBlockers(action.candidate).length
    )
      return;
    setBusy(true);
    setError('');
    try {
      const candidate = await api.authorizeRelease(action.candidate.id, {
        version: 1,
        expected_revision: action.candidate.revision,
        candidate_digest: action.candidate.digest,
        authorize_publication: true,
        expires_seconds: Number(expires),
      });
      saveCandidate(candidate);
      setAction(null);
      setNotice('This exact candidate is authorized. Publication remains a separate command.');
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    if (
      !action ||
      !connected ||
      action.type !== 'publish' ||
      busy ||
      confirmedTag !== action.candidate.tag ||
      action.candidate.blockers.length
    )
      return;
    const request = publication ?? {
      version: 1 as const,
      expected_revision: action.candidate.revision,
      candidate_digest: action.candidate.digest,
      idempotency_key: `release-publish:${crypto.randomUUID()}`,
    };
    setPublication(request);
    setBusy(true);
    setError('');
    try {
      const candidate = await api.publishRelease(action.candidate.id, request);
      saveCandidate(candidate);
      setAction(null);
      setPublication(null);
      setNotice(
        candidate.status === 'published'
          ? 'Publication receipt confirmed for this candidate.'
          : 'Publication is not confirmed. Inspect the candidate and reconcile its recorded outcome.',
      );
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const refreshDialog = async () => {
    if (!action || busy) return;
    const id = action.candidate.id;
    setAction(null);
    setPublication(null);
    await inspect(id);
  };

  return (
    <section className="releases-panel" aria-label="Release candidates">
      <header className="releases-heading">
        <div>
          <h3>Release candidates</h3>
          <p>Immutable versioned artifacts and publication bound to their checked commit.</p>
        </div>
        <div className="releases-actions">
          <button
            type="button"
            className="button small"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Refresh candidates
          </button>
          <button
            type="button"
            className="button"
            disabled={!connected || busy || work.status !== 'completed'}
            onClick={() => {
              setPrepare(true);
              setPackageVersion('');
              setChecksText('');
              setPreparedRequest(null);
              setError('');
            }}
          >
            Prepare candidate
          </button>
        </div>
      </header>
      {!connected && (
        <p className="notice warning" role="status">
          Disconnected. Candidate mutations and publication are unavailable; saved results may be stale.
        </p>
      )}
      {work.status !== 'completed' && (
        <p className="inspector-caption">
          Candidate preparation requires a completed run with delivered, verified source evidence.
        </p>
      )}
      {error && !prepare && !action && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading release candidates…</p>
      ) : !items.length ? (
        <p className="inspector-empty">No release candidate recorded for this run.</p>
      ) : (
        <>
          <div className="release-candidate-list" aria-label="Recorded candidates">
            {items.map((item) => (
              <button
                type="button"
                className={`button small ${selected?.id === item.id ? 'active' : ''}`}
                key={item.id}
                onClick={() => setSelectedId(item.id)}
              >
                {item.tag} · {item.status}
              </button>
            ))}
          </div>
          {selected && (
            <article className="release-candidate-detail">
              <header>
                <h4>{selected.tag}</h4>
                <span>{selected.status}</span>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void inspect(selected.id)}
                >
                  Inspect current checks
                </button>
              </header>
              <dl>
                <dt>Candidate</dt>
                <dd>
                  <code>
                    {selected.id} · revision {selected.revision}
                  </code>
                </dd>
                <dt>Digest</dt>
                <dd>
                  <code>{selected.digest}</code>
                </dd>
                <dt>Exact commit</dt>
                <dd>
                  <code>{selected.commit}</code>
                </dd>
                <dt>Source snapshot</dt>
                <dd>
                  <code>{selected.snapshot_digest}</code>
                </dd>
                <dt>Required CI</dt>
                <dd>{selected.required_checks.join(', ')}</dd>
                <dt>Authorization expiry</dt>
                <dd>{selected.authorization_expires_at ?? 'Not authorized'}</dd>
              </dl>
              {selected.blockers.length ? (
                <div className="notice error">
                  <strong>Publication blocked</strong>
                  <ul>
                    {selected.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="inspector-caption">
                  No blockers reported by the latest inspection. Publication rechecks live CI, security,
                  authorization and artifact identity.
                </p>
              )}
              <details>
                <summary>Prepared changelog</summary>
                <pre>{selected.changelog}</pre>
              </details>
              <details>
                <summary>Artifacts and checksums ({selected.artifacts.length})</summary>
                <div className="release-artifacts">
                  {selected.artifacts.map((artifact) => (
                    <article key={artifact.id}>
                      <strong>{artifact.name}</strong>
                      <span>
                        {artifact.media_type} · {artifact.size_bytes.toLocaleString('en-US')} bytes
                      </span>
                      <code>{artifact.digest}</code>
                    </article>
                  ))}
                </div>
              </details>
              <div className="releases-actions">
                <button
                  type="button"
                  className="button"
                  disabled={
                    !connected ||
                    busy ||
                    !!authorizationBlockers(selected).length ||
                    !['prepared', 'authorized', 'uncertain'].includes(selected.status)
                  }
                  onClick={() => void chooseAction('authorize')}
                >
                  Authorize exact candidate
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    !connected ||
                    busy ||
                    !!selected.blockers.length ||
                    !['authorized', 'uncertain'].includes(selected.status)
                  }
                  onClick={() => void chooseAction('publish')}
                >
                  {selected.status === 'uncertain' ? 'Reconcile publication' : 'Publish authorized candidate'}
                </button>
                {githubRelease(selected.release_url) && (
                  <a
                    className="text-button"
                    href={githubRelease(selected.release_url)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open recorded release
                  </a>
                )}
              </div>
            </article>
          )}
        </>
      )}
      {prepare && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setPrepare(false);
          }}
          title="Prepare release candidate"
          busy={busy}
          dirty={!!packageVersion && !preparedRequest}
          description={`Prepare local immutable artifacts for completed run ${work.id}. This does not publish a release.`}
          footer={
            <button
              type="button"
              className="button primary"
              disabled={!connected || busy || (!preparedRequest && !validPreparation)}
              onClick={() => void prepareCandidate()}
            >
              {busy
                ? 'Preparing…'
                : preparedRequest
                  ? 'Retry exact preparation'
                  : 'Prepare immutable candidate'}
            </button>
          }
        >
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <fieldset disabled={!connected || busy || !!preparedRequest} className="release-form-fields">
            <Field label="Package version" hint="Semantic version without a leading v, for example 1.2.3.">
              <input
                value={packageVersion}
                onChange={(event) => setPackageVersion(event.target.value)}
                maxLength={100}
              />
            </Field>
            <Field
              label="Required CI check names"
              hint="One exact required check name per line. Missing or failed checks block publication."
            >
              <textarea
                value={checksText}
                onChange={(event) => setChecksText(event.target.value)}
                maxLength={8000}
              />
            </Field>
          </fieldset>
        </Dialog>
      )}
      {action && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setAction(null);
          }}
          title={
            action.type === 'authorize' ? 'Authorize exact release candidate' : 'Publish release candidate'
          }
          busy={busy}
          description={`${action.candidate.tag} · revision ${action.candidate.revision} · commit ${action.candidate.commit}`}
          footer={
            <>
              <button type="button" className="button" disabled={busy} onClick={() => void refreshDialog()}>
                Refresh candidate
              </button>
              {action.type === 'authorize' ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    !connected ||
                    busy ||
                    !authorizationChecked ||
                    Number(expires) < 60 ||
                    Number(expires) > 86400 ||
                    !/^\d+$/.test(expires) ||
                    !!authorizationBlockers(action.candidate).length
                  }
                  onClick={() => void authorize()}
                >
                  Authorize this digest
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    !connected ||
                    busy ||
                    confirmedTag !== action.candidate.tag ||
                    !!action.candidate.blockers.length
                  }
                  onClick={() => void publish()}
                >
                  {busy
                    ? 'Checking publication…'
                    : publication
                      ? 'Retry exact publication'
                      : 'Confirm publication'}
                </button>
              )}
            </>
          }
        >
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <p>Exact candidate digest:</p>
          <code className="release-exact-digest">{action.candidate.digest}</code>
          {action.candidate.blockers.length > 0 && (
            <div className="notice error">
              <strong>Publication blocked</strong>
              <ul>
                {action.candidate.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          )}
          {action.type === 'authorize' ? (
            <fieldset disabled={!connected || busy} className="release-form-fields">
              <Field label="Authorization validity · seconds">
                <input
                  type="number"
                  min={60}
                  max={86400}
                  step={1}
                  value={expires}
                  onChange={(event) => setExpires(event.target.value)}
                />
              </Field>
              <label>
                <input
                  type="checkbox"
                  checked={authorizationChecked}
                  onChange={(event) => setAuthorizationChecked(event.target.checked)}
                />{' '}
                I authorize publication of this exact candidate digest.
              </label>
              <p>
                Authorization applies only to these artifacts and this commit. Publication requires a separate
                confirmation.
              </p>
            </fieldset>
          ) : (
            <>
              <p>
                This command can create a GitHub release for the exact authorized candidate. Merge and
                deployment remain separately controlled.
              </p>
              <Field label={`Type ${action.candidate.tag} to confirm publication`}>
                <input
                  value={confirmedTag}
                  disabled={!connected || busy || !!publication}
                  onChange={(event) => setConfirmedTag(event.target.value)}
                />
              </Field>
              {publication && (
                <p>
                  The publication request is locked. A retry preserves its receipt; refresh the candidate to
                  inspect an uncertain outcome.
                </p>
              )}
            </>
          )}
        </Dialog>
      )}
    </section>
  );
}

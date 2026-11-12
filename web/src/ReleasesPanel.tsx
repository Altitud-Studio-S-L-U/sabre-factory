import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  type Api,
  type ReleaseCandidate,
  type ReleasePreparation,
  type ReleasePublication,
  type WorkOrder,
} from './api';
import Button from './components/Button';
import CheckField from './components/CheckField';
import CodeBlock from './components/CodeBlock';
import DescriptionList from './components/DescriptionList';
import Dialog from './components/Dialog';
import Disclosure from './components/Disclosure';
import Field from './components/FormField';
import Input from './components/Input';
import Notice from './components/Notice';
import Textarea from './components/Textarea';
import { Badge } from './components/ui/badge';
import { cn } from './lib/utils';

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
  // Another run (or session) shows its own candidates: reset the view before they load.
  const [source, setSource] = useState({ api, workId: work.id });
  if (source.api !== api || source.workId !== work.id) {
    setSource({ api, workId: work.id });
    setLoading(true);
    setError('');
  }
  // State is applied in promise callbacks, so the mount effect never sets state synchronously.
  const fetchCandidates = useCallback(
    () =>
      api
        .releases()
        .then((page) => {
          if (!page || !Array.isArray(page.items)) throw new Error('Invalid release snapshot');
          setItems(page.items.filter((item) => item.work_id === work.id));
        })
        .catch((reason: unknown) => setError(failure(reason)))
        .finally(() => setLoading(false)),
    [api, work.id],
  );
  useEffect(() => {
    void fetchCandidates();
  }, [fetchCandidates]);
  const load = async () => {
    setLoading(true);
    setError('');
    await fetchCandidates();
  };
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

  const caption = 'text-xs leading-relaxed text-muted-foreground';
  const blockers = (list: string[]) => (
    <Notice tone="danger" title="Publication blocked">
      <ul className="grid list-disc gap-1 pl-4 [overflow-wrap:anywhere]">
        {list.map((blocker) => (
          <li key={blocker}>{blocker}</li>
        ))}
      </ul>
    </Notice>
  );

  return (
    <section className="grid min-w-0 gap-4" aria-label="Release candidates">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h3 className="text-base font-semibold">Release candidates</h3>
          <p className="text-sm text-muted-foreground">
            Immutable versioned artifacts and publication bound to their checked commit.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Refresh candidates
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
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
          </Button>
        </div>
      </header>
      {!connected && (
        <Notice tone="warning" role="status">
          Disconnected. Candidate mutations and publication are unavailable; saved results may be stale.
        </Notice>
      )}
      {work.status !== 'completed' && (
        <p className={caption}>
          Candidate preparation requires a completed run with delivered, verified source evidence.
        </p>
      )}
      {error && !prepare && !action && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="neutral" role="status">
          {notice}
        </Notice>
      )}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading release candidates…
        </p>
      ) : !items.length ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">
          No release candidate recorded for this run.
        </p>
      ) : (
        <>
          <div role="group" aria-label="Recorded candidates" className="flex max-w-full flex-wrap gap-2">
            {items.map((item) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={selected?.id === item.id}
                className="aria-pressed:border-primary/60 aria-pressed:bg-accent"
                key={item.id}
                onClick={() => setSelectedId(item.id)}
              >
                {item.tag} · {item.status}
              </Button>
            ))}
          </div>
          {selected && (
            <article className="grid min-w-0 gap-4 rounded-lg border border-border bg-card p-4">
              <header className="flex min-w-0 flex-wrap items-center gap-2.5">
                <h4 className="text-base font-semibold [overflow-wrap:anywhere]">{selected.tag}</h4>
                <Badge variant={selected.status === 'published' ? 'success' : 'neutral'}>
                  {selected.status}
                </Badge>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="ml-auto px-0"
                  disabled={busy}
                  onClick={() => void inspect(selected.id)}
                >
                  Inspect current checks
                </Button>
              </header>
              <DescriptionList
                termWidth="10rem"
                className="text-xs"
                items={[
                  [
                    'Candidate',
                    <code key="candidate" className="font-mono">
                      {selected.id} · revision {selected.revision}
                    </code>,
                  ],
                  [
                    'Digest',
                    <code key="digest" className="font-mono">
                      {selected.digest}
                    </code>,
                  ],
                  [
                    'Exact commit',
                    <code key="commit" className="font-mono">
                      {selected.commit}
                    </code>,
                  ],
                  [
                    'Source snapshot',
                    <code key="snapshot" className="font-mono">
                      {selected.snapshot_digest}
                    </code>,
                  ],
                  ['Required CI', selected.required_checks.join(', ')],
                  ['Authorization expiry', selected.authorization_expires_at ?? 'Not authorized'],
                ]}
              />
              {selected.blockers.length ? (
                blockers(selected.blockers)
              ) : (
                <p className={caption}>
                  No blockers reported by the latest inspection. Publication rechecks live CI, security,
                  authorization and artifact identity.
                </p>
              )}
              <div className="grid gap-1">
                <Disclosure variant="plain" summary="Prepared changelog">
                  <CodeBlock>{selected.changelog}</CodeBlock>
                </Disclosure>
                <Disclosure
                  variant="plain"
                  summary={`Artifacts and checksums (${selected.artifacts.length})`}
                >
                  <div className="grid gap-2">
                    {selected.artifacts.map((artifact) => (
                      <article
                        key={artifact.id}
                        className="grid min-w-0 gap-1 rounded-md border border-border px-3 py-2.5 text-xs"
                      >
                        <strong className="text-sm font-semibold [overflow-wrap:anywhere]">
                          {artifact.name}
                        </strong>
                        <span className="text-muted-foreground">
                          {artifact.media_type} · {artifact.size_bytes.toLocaleString('en-US')} bytes
                        </span>
                        <code className="font-mono [overflow-wrap:anywhere]">{artifact.digest}</code>
                      </article>
                    ))}
                  </div>
                </Disclosure>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    !connected ||
                    busy ||
                    !!authorizationBlockers(selected).length ||
                    !['prepared', 'authorized', 'uncertain'].includes(selected.status)
                  }
                  onClick={() => void chooseAction('authorize')}
                >
                  Authorize exact candidate
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={
                    !connected ||
                    busy ||
                    !!selected.blockers.length ||
                    !['authorized', 'uncertain'].includes(selected.status)
                  }
                  onClick={() => void chooseAction('publish')}
                >
                  {selected.status === 'uncertain' ? 'Reconcile publication' : 'Publish authorized candidate'}
                </Button>
                {githubRelease(selected.release_url) && (
                  <a
                    className="px-2 text-sm font-medium text-link underline-offset-4 hover:underline"
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
            <Button
              type="button"
              variant="primary"
              disabled={!connected || busy || (!preparedRequest && !validPreparation)}
              onClick={() => void prepareCandidate()}
            >
              {busy
                ? 'Preparing…'
                : preparedRequest
                  ? 'Retry exact preparation'
                  : 'Prepare immutable candidate'}
            </Button>
          }
        >
          <div className="grid gap-4">
            {error && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            <fieldset disabled={!connected || busy || !!preparedRequest} className="grid min-w-0 gap-4">
              <Field label="Package version" hint="Semantic version without a leading v, for example 1.2.3.">
                <Input
                  value={packageVersion}
                  onChange={(event) => setPackageVersion(event.target.value)}
                  maxLength={100}
                />
              </Field>
              <Field
                label="Required CI check names"
                hint="One exact required check name per line. Missing or failed checks block publication."
              >
                <Textarea
                  value={checksText}
                  className="font-mono text-xs"
                  onChange={(event) => setChecksText(event.target.value)}
                  maxLength={8000}
                />
              </Field>
            </fieldset>
          </div>
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
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void refreshDialog()}>
                Refresh candidate
              </Button>
              {action.type === 'authorize' ? (
                <Button
                  type="button"
                  variant="primary"
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
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
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
                </Button>
              )}
            </>
          }
        >
          <div className="grid gap-4">
            {error && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            <div className="grid gap-1.5">
              <p className="text-sm">Exact candidate digest:</p>
              <code
                className={cn(
                  'block rounded-md border border-border bg-code px-3 py-2 font-mono text-xs',
                  '[overflow-wrap:anywhere]',
                )}
              >
                {action.candidate.digest}
              </code>
            </div>
            {action.candidate.blockers.length > 0 && blockers(action.candidate.blockers)}
            {action.type === 'authorize' ? (
              <fieldset disabled={!connected || busy} className="grid min-w-0 gap-4">
                <Field label="Authorization validity · seconds">
                  <Input
                    type="number"
                    min={60}
                    max={86400}
                    step={1}
                    value={expires}
                    onChange={(event) => setExpires(event.target.value)}
                  />
                </Field>
                <CheckField
                  label="I authorize publication of this exact candidate digest."
                  checked={authorizationChecked}
                  onChange={(event) => setAuthorizationChecked(event.target.checked)}
                />
                <p className="text-sm text-muted-foreground">
                  Authorization applies only to these artifacts and this commit. Publication requires a
                  separate confirmation.
                </p>
              </fieldset>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  This command can create a GitHub release for the exact authorized candidate. Merge and
                  deployment remain separately controlled.
                </p>
                <Field label={`Type ${action.candidate.tag} to confirm publication`}>
                  <Input
                    value={confirmedTag}
                    disabled={!connected || busy || !!publication}
                    onChange={(event) => setConfirmedTag(event.target.value)}
                  />
                </Field>
                {publication && (
                  <p className="text-sm text-muted-foreground">
                    The publication request is locked. A retry preserves its receipt; refresh the candidate to
                    inspect an uncertain outcome.
                  </p>
                )}
              </>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  type Api,
  type RepoCreationPage,
  type RepoCreationProposal,
  type RepoCreationRequest,
} from './api';
import Field from './components/FormField';
import Select from './components/Select';
import CreateRepositoryFlow from './CreateRepositoryFlow';

const statusText: Record<RepoCreationProposal['status'], string> = {
  proposed: 'Awaiting your decision',
  approved: 'Approved · queued',
  rejected: 'Rejected',
  executing: 'Creating on GitHub',
  created: 'Repository created',
  conflict: 'Repository already exists',
  failed: 'Creation failed',
  reconciliation_required: 'Unconfirmed result',
};
const message = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : 'The operation could not be confirmed. Refresh proposals before continuing.';

export default function RepoCreations({ api }: { api: Api }) {
  const [page, setPage] = useState<RepoCreationPage>({ items: [], truncated: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [ownerType, setOwnerType] = useState<'user' | 'org'>('org');
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [reviewed, setReviewed] = useState<string[]>([]);
  const pending = useRef<{ material: string; key: string } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await api.repositoryProposals());
      setError('');
    } catch (reason) {
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!page.items.some((item) => ['approved', 'executing'].includes(item.status))) return;
    const timer = window.setTimeout(() => void load(), 15000);
    return () => window.clearTimeout(timer);
  }, [page, load]);
  const update = (next: RepoCreationProposal) =>
    setPage((current) => ({
      ...current,
      items: [next, ...current.items.filter((item) => item.id !== next.id)],
    }));
  const propose = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const request = {
      owner_type: ownerType,
      owner: owner.trim(),
      name: name.trim(),
      description: description.trim(),
      visibility,
      initialize: false,
    };
    const material = JSON.stringify(request);
    if (pending.current?.material !== material) pending.current = { material, key: crypto.randomUUID() };
    try {
      update(
        await api.proposeRepository({
          ...request,
          idempotency_key: pending.current.key,
        } satisfies RepoCreationRequest),
      );
      pending.current = null;
      setEditing(false);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  const decide = async (item: RepoCreationProposal, decision: 'approve' | 'reject') => {
    if (busy || (decision === 'approve' && !reviewed.includes(item.id))) return;
    setBusy(true);
    setError('');
    try {
      update(
        await api.decideRepository(item.id, {
          expected_revision: item.revision,
          request_digest: item.request_digest,
          decision,
        }),
      );
    } catch (reason) {
      setError(message(reason));
      setReviewed([]);
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async (item: RepoCreationProposal) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      update(await api.reconcileRepository(item.id));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="integration-section" aria-labelledby="repository-creation-title">
      <CreateRepositoryFlow api={api} onCreated={update} />
      <div className="section-heading">
        <div>
          <h2 id="repository-creation-title">Create on GitHub</h2>
          <p className="muted">Prepare the proposal and review its details before authorizing creation.</p>
        </div>
        <div className="integration-actions">
          <button className="button small" disabled={busy || loading} onClick={() => void load()}>
            Refresh proposals
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => setEditing((value) => !value)}
            aria-expanded={editing}
          >
            Propose repository
          </button>
        </div>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <form
          className="connection-form"
          onSubmit={(event) => void propose(event)}
          aria-label="Repository proposal"
        >
          <div className="form-grid">
            <Field label="Owner type">
              <Select
                value={ownerType}
                disabled={busy}
                onChange={(event) => setOwnerType(event.target.value as 'user' | 'org')}
              >
                <option value="org">Organization</option>
                <option value="user">User</option>
              </Select>
            </Field>
            <Field label="GitHub owner">
              <input
                required
                pattern={'[A-Za-z0-9][A-Za-z0-9\\-]{0,38}'}
                maxLength={39}
                value={owner}
                disabled={busy}
                onChange={(event) => setOwner(event.target.value)}
              />
            </Field>
            <Field label="Repository name">
              <input
                required
                pattern={'[A-Za-z0-9_.\\-]+'}
                maxLength={100}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Visibility">
              <Select
                value={visibility}
                disabled={busy}
                onChange={(event) => setVisibility(event.target.value as 'private' | 'public')}
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </Select>
            </Field>
          </div>
          <Field label="Description">
            <input
              maxLength={350}
              value={description}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <p className="muted">
            This saves a local proposal. Creation requires your approval and a separate creation credential;
            branch and PR credentials are not reused.
          </p>
          <button className="button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save proposal for review'}
          </button>
        </form>
      )}
      {loading && !page.items.length && <p role="status">Loading proposals…</p>}
      {!loading && !page.items.length && (
        <p className="muted">No proposals yet. Choose an owner, name and visibility to prepare the first.</p>
      )}
      <div className="proposal-list">
        {page.items.map((item) => (
          <article
            className="proposal"
            key={item.id}
            aria-label={`Propuesta ${item.request.owner}/${item.request.name}`}
          >
            <div className="integration-heading">
              <h3>
                {item.request.owner}/{item.request.name}
              </h3>
              <span className="integration-state">{statusText[item.status]}</span>
            </div>
            <dl className="proposal-details">
              <div>
                <dt>Owner</dt>
                <dd>
                  {item.request.owner_type === 'org' ? 'Organization' : 'Usuario'} · {item.request.owner}
                </dd>
              </div>
              <div>
                <dt>Visibility</dt>
                <dd>{item.request.visibility === 'private' ? 'Private' : 'Public'}</dd>
              </div>
            </dl>
            {item.request.description && <p>{item.request.description}</p>}
            {item.status === 'proposed' && (
              <>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={reviewed.includes(item.id)}
                    disabled={busy}
                    onChange={(event) =>
                      setReviewed((current) =>
                        event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  I reviewed these details and authorize creating this repository.
                </label>
                <div className="integration-actions">
                  <button
                    className="button primary"
                    disabled={busy || !reviewed.includes(item.id)}
                    onClick={() => void decide(item, 'approve')}
                  >
                    Approve and create
                  </button>
                  <button
                    className="button small"
                    disabled={busy}
                    onClick={() => void decide(item, 'reject')}
                  >
                    Reject proposal
                  </button>
                </div>
              </>
            )}
            {item.receipt && (
              <a href={item.receipt.url} target="_blank" rel="noreferrer">
                Open created repository
              </a>
            )}
            {['executing', 'reconciliation_required'].includes(item.status) && (
              <>
                <p className="muted">
                  If a response is lost, SABRE checks GitHub and preserves uncertainty. It will not repeat
                  creation or adopt a repository by name alone.
                </p>
                <button className="button small" disabled={busy} onClick={() => void reconcile(item)}>
                  Verify result on GitHub
                </button>
              </>
            )}
            {item.candidate && (
              <p className="muted">
                Observed {item.candidate.full_name}, but no receipt links it to this creation request yet.
              </p>
            )}
            {item.error_code && (
              <p className="muted">
                Referencia: <code>{item.error_code}</code>
              </p>
            )}
          </article>
        ))}
      </div>
      {page.truncated && <p className="muted">Showing the 100 most recent proposals.</p>}
    </section>
  );
}

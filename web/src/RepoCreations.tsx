import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError,
  type Api,
  type RepoCreationPage,
  type RepoCreationProposal,
  type RepoCreationRequest,
} from './api';
import Button from './components/Button';
import CheckField from './components/CheckField';
import DescriptionList from './components/DescriptionList';
import Field from './components/FormField';
import Input from './components/Input';
import Notice from './components/Notice';
import { SectionHeading } from './components/PageHeader';
import Select from './components/Select';
import { Badge } from './components/ui/badge';
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
const statusTone: Record<
  RepoCreationProposal['status'],
  'neutral' | 'info' | 'warning' | 'danger' | 'success'
> = {
  proposed: 'warning',
  approved: 'info',
  rejected: 'neutral',
  executing: 'info',
  created: 'success',
  conflict: 'danger',
  failed: 'danger',
  reconciliation_required: 'warning',
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
  // State is applied in promise callbacks, so the mount effect never sets state synchronously.
  const fetchProposals = useCallback(
    () =>
      api
        .repositoryProposals()
        .then(
          (next) => {
            setPage(next);
            setError('');
          },
          (reason: unknown) => setError(message(reason)),
        )
        .finally(() => setLoading(false)),
    [api],
  );
  const load = useCallback(async () => {
    setLoading(true);
    await fetchProposals();
  }, [fetchProposals]);
  useEffect(() => {
    void fetchProposals();
  }, [fetchProposals]);
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
    <section className="grid min-w-0 gap-4" aria-labelledby="repository-creation-title">
      <SectionHeading
        id="repository-creation-title"
        title="Create on GitHub"
        description="Prepare the proposal and review its details before authorizing creation."
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || loading}
              onClick={() => void load()}
            >
              Refresh proposals
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => setEditing((value) => !value)}
              aria-expanded={editing}
            >
              Propose repository
            </Button>
          </>
        }
      />
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {editing && (
        <form
          className="grid min-w-0 gap-4 rounded-lg border border-border bg-card p-5"
          onSubmit={(event) => void propose(event)}
          aria-label="Repository proposal"
        >
          <div className="grid gap-4 sm:grid-cols-2">
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
              <Input
                required
                pattern={'[A-Za-z0-9][A-Za-z0-9\\-]{0,38}'}
                maxLength={39}
                value={owner}
                disabled={busy}
                onChange={(event) => setOwner(event.target.value)}
              />
            </Field>
            <Field label="Repository name">
              <Input
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
            <Input
              maxLength={350}
              value={description}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <p className="text-sm text-muted-foreground">
            This saves a local proposal. Creation requires your approval and a separate creation credential;
            branch and PR credentials are not reused.
          </p>
          <Button type="submit" variant="primary" className="justify-self-start" disabled={busy}>
            {busy ? 'Saving…' : 'Save proposal for review'}
          </Button>
        </form>
      )}
      {loading && !page.items.length && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading proposals…
        </p>
      )}
      {!loading && !page.items.length && (
        <p className="text-sm text-muted-foreground">
          No proposals yet. Choose an owner, name and visibility to prepare the first.
        </p>
      )}
      {!!page.items.length && (
        <div className="grid min-w-0 gap-3">
          {page.items.map((item) => (
            <article
              className="grid min-w-0 gap-3.5 rounded-lg border border-border bg-card p-5 [overflow-wrap:anywhere]"
              key={item.id}
              aria-label={`Proposal ${item.request.owner}/${item.request.name}`}
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2.5">
                <h3 className="min-w-0 text-base font-semibold">
                  {item.request.owner}/{item.request.name}
                </h3>
                <Badge variant={statusTone[item.status]}>{statusText[item.status]}</Badge>
              </div>
              <DescriptionList
                termWidth="6rem"
                items={[
                  [
                    'Owner',
                    `${item.request.owner_type === 'org' ? 'Organization' : 'User'} · ${item.request.owner}`,
                  ],
                  ['Visibility', item.request.visibility === 'private' ? 'Private' : 'Public'],
                ]}
              />
              {item.request.description && <p className="text-sm">{item.request.description}</p>}
              {item.status === 'proposed' && (
                <>
                  <CheckField
                    label="I reviewed these details and authorize creating this repository."
                    checked={reviewed.includes(item.id)}
                    disabled={busy}
                    onChange={(event) =>
                      setReviewed((current) =>
                        event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={busy || !reviewed.includes(item.id)}
                      onClick={() => void decide(item, 'approve')}
                    >
                      Approve and create
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void decide(item, 'reject')}
                    >
                      Reject proposal
                    </Button>
                  </div>
                </>
              )}
              {item.receipt && (
                <a
                  href={item.receipt.url}
                  target="_blank"
                  rel="noreferrer"
                  className="justify-self-start text-sm font-medium text-link underline-offset-4 hover:underline"
                >
                  Open created repository
                </a>
              )}
              {['executing', 'reconciliation_required'].includes(item.status) && (
                <>
                  <p className="text-sm text-muted-foreground">
                    If a response is lost, SABRE checks GitHub and preserves uncertainty. It will not repeat
                    creation or adopt a repository by name alone.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="justify-self-start"
                    disabled={busy}
                    onClick={() => void reconcile(item)}
                  >
                    Verify result on GitHub
                  </Button>
                </>
              )}
              {item.candidate && (
                <p className="text-sm text-muted-foreground">
                  Observed {item.candidate.full_name}, but no receipt links it to this creation request yet.
                </p>
              )}
              {item.error_code && (
                <p className="text-sm text-muted-foreground">
                  Reference: <code className="font-mono text-xs">{item.error_code}</code>
                </p>
              )}
            </article>
          ))}
        </div>
      )}
      {page.truncated && (
        <p className="text-xs text-muted-foreground">Showing the 100 most recent proposals.</p>
      )}
      {/* After the proposals: proposing a repository is the main path; this one authorizes it together with its first flow. */}
      <CreateRepositoryFlow api={api} onCreated={update} />
    </section>
  );
}

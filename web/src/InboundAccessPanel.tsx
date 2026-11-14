import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Api, DelegationCreate, DelegationGrant, IssuedDelegation, Project } from './api';
import Button from './components/Button';
import CheckField from './components/CheckField';
import Dialog, { DialogActions } from './components/Dialog';
import EmptyState from './components/EmptyState';
import Field from './components/FormField';
import Input from './components/Input';
import LoadingState from './components/LoadingState';
import Notice from './components/Notice';
import { SectionHeading } from './components/PageHeader';
import Experimental from './components/Experimental';
import { Badge } from './components/ui/badge';
import { Card } from './components/ui/card';

const operations: { value: DelegationCreate['operations'][number]; label: string }[] = [
  { value: 'work.submit', label: 'Submit runs' },
  { value: 'work.query', label: 'Inspect assigned runs' },
  { value: 'work.answer', label: 'Answer clarification questions' },
  { value: 'work.cancel', label: 'Cancel assigned runs' },
];
const ceilings = [
  { key: 'max_runs', label: 'Maximum admitted runs', min: 1, max: 100 },
  { key: 'max_calls', label: 'Model calls per run', min: 1, max: 500 },
  { key: 'max_tokens', label: 'Tokens per run', min: 1, max: 10000000 },
  { key: 'max_cost_usd', label: 'Model API cost per run · USD', min: 0, max: 1000, step: 0.01 },
  { key: 'active_seconds', label: 'Active seconds per run', min: 60, max: 86400 },
] as const;
const initial = (idempotencyKey: string = crypto.randomUUID()): DelegationCreate => ({
  version: 1,
  idempotency_key: idempotencyKey,
  principal: '',
  projects: [],
  operations: [],
  expires_in: 3600,
  max_runs: 1,
  max_calls: 10,
  max_tokens: 20000,
  max_cost_usd: 0,
  active_seconds: 600,
});
/** Wall clock in ten-second steps, so expiry is read during render without impure calls. */
const clockStep = 10_000;
const readClock = () => Math.floor(Date.now() / clockStep) * clockStep;
const subscribeClock = (notify: () => void) => {
  const timer = setInterval(notify, clockStep);
  return () => clearInterval(timer);
};
const expired = (grant: DelegationGrant, now: number) => Date.parse(grant.expires_at) <= now;
const status = (grant: DelegationGrant, now: number) =>
  grant.revoked_at ? 'Revoked' : expired(grant, now) ? 'Expired' : 'Active until expiry';
const statusTone = { Revoked: 'neutral', Expired: 'warning', 'Active until expiry': 'success' } as const;

/** A bordered group of related controls with a small legend. */
function FieldGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="grid min-w-0 gap-3 rounded-lg border border-border px-4 pt-2 pb-4">
      <legend className="px-1.5 text-xs font-medium text-muted-foreground">{legend}</legend>
      {children}
    </fieldset>
  );
}

export default function InboundAccessPanel({
  api,
  projects,
  connected = true,
}: {
  api: Api;
  projects: Project[];
  connected?: boolean;
}) {
  const [grants, setGrants] = useState<DelegationGrant[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => initial());
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [receipt, setReceipt] = useState<IssuedDelegation | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  const [revoking, setRevoking] = useState<DelegationGrant | null>(null);
  const mounted = useRef(false);
  const now = useSyncExternalStore(subscribeClock, readClock);
  useEffect(() => {
    mounted.current = true;
    api
      .delegations()
      .then((items) => {
        if (mounted.current) {
          setGrants(items);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (mounted.current) setError('Access metadata could not be loaded. Refresh before making changes.');
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [api]);
  const refresh = async () => {
    if (!connected || busy || loading) return;
    setLoading(true);
    setError('');
    try {
      const items = await api.delegations();
      if (mounted.current) {
        setGrants(items);
        setLoaded(true);
      }
    } catch {
      if (mounted.current)
        setError('Access metadata could not be refreshed. The saved snapshot is retained.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  const valid =
    /^[A-Za-z0-9_.-]{1,100}$/.test(draft.principal) &&
    !['owner', 'supervisor', 'system', 'admin'].includes(draft.principal.toLowerCase()) &&
    draft.projects.length > 0 &&
    draft.projects.length <= 30 &&
    draft.projects.every((id) => projects.some((project) => project.id === id)) &&
    draft.operations.length > 0 &&
    (!(draft.operations.includes('work.answer') || draft.operations.includes('work.cancel')) ||
      draft.operations.includes('work.query')) &&
    Number.isInteger(draft.expires_in) &&
    draft.expires_in >= 60 &&
    draft.expires_in <= 86400 &&
    ceilings.every(
      (field) =>
        Number.isFinite(draft[field.key]) &&
        draft[field.key] >= field.min &&
        draft[field.key] <= field.max &&
        (field.key === 'max_cost_usd' || Number.isInteger(draft[field.key])),
    );
  const issue = async () => {
    if (!connected || busy || !loaded || !valid || !approved) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const issued = await api.issueDelegation(draft);
      if (!mounted.current) return;
      setEditing(false);
      setDraft(initial());
      setApproved(false);
      setUncertain(false);
      setRevealed(false);
      setCopyNotice('');
      setReceipt(issued);
      try {
        const items = await api.delegations();
        if (mounted.current) setGrants(items);
      } catch {
        if (mounted.current) setNotice('Access issuance confirmed. Refresh to reload the metadata list.');
      }
    } catch {
      if (mounted.current) {
        setUncertain(true);
        setError(
          'Access issuance could not be confirmed. A grant may already exist. Retry the same request to recover its identity, or inspect the access list. This draft and request identity are retained; no new credential is issued automatically.',
        );
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const revoke = async () => {
    if (!connected || busy || !revoking) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.revokeDelegation(revoking.id);
      if (!result.revoked || result.id !== revoking.id) throw new Error('Unconfirmed revocation');
      if (!mounted.current) return;
      setGrants((items) =>
        items.map((item) => (item.id === result.id ? { ...item, revoked_at: result.revoked_at } : item)),
      );
      setRevoking(null);
      setNotice('Access revoked. Future delegated effects are denied at the next authorization check.');
    } catch {
      if (mounted.current)
        setError('Revocation could not be confirmed. Refresh access metadata before retrying.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const closeReceipt = () => {
    setReceipt(null);
    setRevealed(false);
    setCopyNotice('');
  };
  return (
    <Card className="@container gap-5" aria-label="Inbound delegated access">
      <SectionHeading
        className="items-start [&>:first-child]:flex-1 [&>:first-child]:basis-72"
        title="Inbound access"
        badge={<Experimental />}
        description="Issue a separate credential for an external agent to use this factory. Grants cover selected projects and assigned runs; they never reuse your owner credential or change network exposure."
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || loading || !connected}
              onClick={() => void refresh()}
            >
              Refresh access
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !loaded || !connected || !projects.length}
              onClick={() => {
                if (!uncertain) {
                  setDraft(initial());
                  setApproved(false);
                  setError('');
                }
                setEditing(true);
              }}
            >
              {uncertain ? 'Resolve pending issuance' : 'Issue access'}
            </Button>
          </>
        }
      />
      {!connected && (
        <Notice tone="warning" role="status">
          Disconnected. Saved metadata remains available; issuing and revoking access are disabled.
        </Notice>
      )}
      {loading && <LoadingState label="Loading access metadata…" />}
      {notice && (
        <Notice tone="neutral" role="status">
          {notice}
        </Notice>
      )}
      {error && !editing && !revoking && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {loaded && !grants.length && <EmptyState title="No delegated access issued." />}
      {grants.length > 0 && (
        <div className="grid min-w-0 gap-3 @3xl:grid-cols-2">
          {grants.map((grant) => (
            <article
              key={grant.id}
              className="grid min-w-0 content-start gap-3 rounded-lg border border-border bg-secondary/40 p-4"
            >
              <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <strong className="text-sm font-semibold [overflow-wrap:anywhere]">{grant.principal}</strong>
                <Badge variant={statusTone[status(grant, now)]}>{status(grant, now)}</Badge>
              </header>
              <div className="grid min-w-0 gap-1.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                <p>
                  Projects:{' '}
                  {grant.data.projects
                    .map((id) => projects.find((project) => project.id === id)?.name ?? id)
                    .join(', ')}
                </p>
                <p>
                  {grant.data.operations
                    .map((value) => operations.find((operation) => operation.value === value)?.label ?? value)
                    .join(' · ')}
                </p>
                <p>
                  Maximum {grant.data.max_runs} admitted runs. Each run: {grant.data.max_calls} calls ·{' '}
                  {grant.data.max_tokens.toLocaleString('en-US')} tokens · $
                  {grant.data.max_cost_usd.toFixed(2)} model API cost · {grant.data.active_seconds}s active.
                </p>
                <p>
                  Expires{' '}
                  <time dateTime={grant.expires_at}>{new Date(grant.expires_at).toLocaleString()}</time>
                </p>
              </div>
              <div>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  disabled={!connected || busy || !!grant.revoked_at || expired(grant, now)}
                  onClick={() => {
                    setError('');
                    setRevoking(grant);
                  }}
                >
                  Revoke {grant.principal}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      <Dialog
        open={editing}
        onClose={() => {
          setEditing(false);
          if (!uncertain) {
            setDraft(initial());
            setApproved(false);
            setError('');
          }
        }}
        title="Issue delegated access"
        description="Choose the exact scope before issuing a new external credential."
        busy={busy}
        dirty={
          !uncertain && (JSON.stringify(draft) !== JSON.stringify(initial(draft.idempotency_key)) || approved)
        }
      >
        <form
          className="grid min-w-0 gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void issue();
          }}
        >
          {error && (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          )}
          {!connected && (
            <Notice tone="warning" role="status">
              Disconnected. Your draft is retained.
            </Notice>
          )}
          <fieldset className="grid min-w-0 gap-5" disabled={busy || !connected || uncertain}>
            <Field
              label="External principal"
              hint="A distinct name using letters, numbers, underscores, dots or hyphens. Owner, admin, system and supervisor are reserved."
            >
              <Input
                required
                maxLength={100}
                pattern={'[A-Za-z0-9_.\\-]+'}
                value={draft.principal}
                onChange={(event) => setDraft({ ...draft, principal: event.target.value })}
              />
            </Field>
            <FieldGroup legend="Allowed projects · up to 30">
              {projects.map((project) => (
                <CheckField
                  key={project.id}
                  label={project.name}
                  checked={draft.projects.includes(project.id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      projects: event.target.checked
                        ? [...draft.projects, project.id]
                        : draft.projects.filter((id) => id !== project.id),
                    })
                  }
                />
              ))}
            </FieldGroup>
            <FieldGroup legend="Allowed operations">
              {operations.map((operation) => (
                <CheckField
                  key={operation.value}
                  label={operation.label}
                  checked={draft.operations.includes(operation.value)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      operations: event.target.checked
                        ? [...draft.operations, operation.value]
                        : draft.operations.filter((value) => value !== operation.value),
                    })
                  }
                />
              ))}
              <p className="text-xs text-muted-foreground">
                Inspection, answers and cancellation apply only to runs assigned to this grant. Answers can
                clarify work; they cannot approve permissions, architecture or publication. Answers and
                cancellation also require explicitly selecting Inspect assigned runs.
              </p>
            </FieldGroup>
            <Field
              label="Expires after · seconds"
              hint="60–86,400 seconds (up to 24 hours). Expiry blocks further delegated effects."
            >
              <Input
                type="number"
                required
                min={60}
                max={86400}
                step={1}
                value={draft.expires_in}
                onChange={(event) => setDraft({ ...draft, expires_in: Number(event.target.value) })}
              />
            </Field>
            <FieldGroup legend="Finite admission and per-run ceilings">
              <p className="text-xs text-muted-foreground">
                These ceilings apply to each admitted run. Maximum admitted runs bounds the number of runs for
                the whole grant. Zero USD permits no paid model API spend.
              </p>
              <div className="@container">
                <div className="grid gap-4 @md:grid-cols-2">
                  {ceilings.map((field) => (
                    <Field key={field.key} label={field.label}>
                      <Input
                        type="number"
                        required
                        min={field.min}
                        max={field.max}
                        step={'step' in field ? field.step : 1}
                        value={draft[field.key]}
                        onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })}
                      />
                    </Field>
                  ))}
                </div>
              </div>
            </FieldGroup>
            <CheckField
              label="I authorize this principal to use only these projects, operations and finite limits."
              checked={approved}
              onChange={(event) => setApproved(event.target.checked)}
            />
            <DialogActions>
              <Button variant="primary" type="submit" disabled={!valid || !approved || busy || !connected}>
                Issue scoped credential
              </Button>
            </DialogActions>
          </fieldset>
          {uncertain && (
            <DialogActions>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !connected}
                onClick={() => void issue()}
              >
                Retry same issuance request
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  void refresh();
                }}
              >
                Inspect access list
              </Button>
            </DialogActions>
          )}
        </form>
      </Dialog>
      <Dialog
        open={!!receipt}
        onClose={closeReceipt}
        title="Save the delegated credential"
        description="This credential is available once. Closing this dialog clears it from the panel; it cannot be retrieved from the access list."
      >
        {receipt && (
          <div className="grid min-w-0 gap-4">
            <p className="text-sm">
              Issued to <strong>{receipt.principal}</strong>. Expires{' '}
              {new Date(receipt.expires_at).toLocaleString()}. Use only with the factory’s existing A2A
              endpoint; issuance does not expose a listener or change routing.
            </p>
            {receipt.token ? (
              <>
                <Field label="New delegated credential">
                  <Input
                    type={revealed ? 'text' : 'password'}
                    className="font-mono"
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    value={receipt.token}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={() => setRevealed(!revealed)}>
                    {revealed ? 'Hide credential' : 'Reveal credential'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(receipt.token!);
                        if (mounted.current) setCopyNotice('Credential copied. Protect it as a secret.');
                      } catch {
                        if (mounted.current)
                          setCopyNotice('Copy unavailable. Reveal the credential to copy it manually.');
                      }
                    }}
                  >
                    Copy credential
                  </Button>
                </div>
                {copyNotice && (
                  <Notice tone="neutral" role="status">
                    {copyNotice}
                  </Notice>
                )}
              </>
            ) : (
              <Notice tone="warning" role="status">
                The original grant was recovered. Its credential cannot be retrieved or shown again. Inspect
                or revoke this grant before explicitly issuing replacement access.
              </Notice>
            )}
            <p className="text-sm text-muted-foreground">
              Grant ID: <code className="font-mono text-xs text-foreground">{receipt.id}</code>
            </p>
            <DialogActions>
              <Button
                type="button"
                variant="danger"
                disabled={!connected || busy || !grants.some((grant) => grant.id === receipt.id)}
                onClick={() => {
                  const grant = grants.find((item) => item.id === receipt.id);
                  if (grant) {
                    closeReceipt();
                    setError('');
                    setRevoking(grant);
                  }
                }}
              >
                Revoke this access
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!revoking}
        onClose={() => {
          setRevoking(null);
          setError('');
        }}
        title="Revoke delegated access?"
        busy={busy}
        description="Revocation blocks future delegated authorization checks. Saved run evidence remains available."
      >
        {revoking && (
          <div className="grid min-w-0 gap-4">
            <p className="text-sm">
              Revoke <strong>{revoking.principal}</strong> for {revoking.data.projects.length} project(s)?
              This cannot restore or reveal its credential.
            </p>
            {error && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            {!connected && (
              <Notice tone="warning" role="status">
                Disconnected. Revocation is disabled until connection returns.
              </Notice>
            )}
            <DialogActions>
              <Button
                type="button"
                variant="danger"
                disabled={busy || !connected}
                onClick={() => void revoke()}
              >
                Confirm revocation
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

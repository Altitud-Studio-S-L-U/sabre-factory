import Button from './components/Button';
import Input from './components/Input';
import Textarea from './components/Textarea';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  type Api,
  type BudgetAmendment,
  type BudgetMetric,
  type BudgetReconciliation,
  type BudgetView,
  type WorkOrder,
} from './api';
import Dialog from './components/Dialog';
import Field from './components/FormField';
import { currentBlocker, isBudgetCode, isClosed } from './runState';
import Select from './components/Select';
import BudgetBlockReason from './BudgetBlockReason';
import CheckField from './components/CheckField';
import Disclosure from './components/Disclosure';
import Notice from './components/Notice';
import { Eyebrow } from './components/PageHeader';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table';

const labels: Record<BudgetMetric, string> = {
  tokens: 'Tokens',
  invocations: 'Model invocations',
  active_seconds: 'Active seconds',
  repairs: 'Repair cycles',
};
const metrics = Object.keys(labels) as BudgetMetric[];
const note = 'text-xs leading-relaxed text-muted-foreground';
const cell = 'whitespace-nowrap tabular-nums [overflow-wrap:normal]';
type Mode = 'bounded' | 'reserve' | 'uncapped';
type Editor = {
  type: 'amend' | 'reconcile';
  revision: number;
  metric: BudgetMetric;
  mode: Mode;
  primary: string;
  reserve: string;
  reason: string;
  usageIds: string[];
  resume: boolean;
};
type Candidate =
  | { key: string; type: 'amend'; request: BudgetAmendment }
  | { key: string; type: 'reconcile'; request: BudgetReconciliation };
const number = (value: number) => value.toLocaleString('en-US');
const integer = (value: string) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= 1000000000;
const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'The command could not be confirmed. Inspect the current limits before creating another command.';
const checked = (value: BudgetView) => {
  if (
    !value ||
    !value.metrics ||
    !Number.isInteger(value.revision) ||
    !metrics.every((metric) => value.metrics[metric]?.policy)
  )
    throw new ApiError(502, 'The recorded budget snapshot could not be verified. Refresh to retry.');
  return value;
};

export default function BudgetPanel({
  api,
  work,
  onChanged,
  refreshKey,
  connected = true,
}: {
  api: Api;
  work: WorkOrder;
  onChanged?: (work: WorkOrder) => void;
  refreshKey?: string | number;
  connected?: boolean;
}) {
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const closed = isClosed(work);
  const canAmend = connected && ['paused', 'blocked'].includes(work.status) && work.control !== 'cancel';
  const budgetBlocked = work.status === 'blocked' && isBudgetCode(currentBlocker(work));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBudget(checked(await api.workBudget(work.id)));
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setLoading(false);
    }
  }, [api, work.id]);
  // Another run or a newer run revision discards the snapshot and any open editor before rendering.
  const [source, setSource] = useState({ api, id: work.id, refreshKey });
  if (source.api !== api || source.id !== work.id || source.refreshKey !== refreshKey) {
    setSource({ api, id: work.id, refreshKey });
    setLoading(true);
    setError('');
    setBudget(null);
    setEditor(null);
    setCandidate(null);
  }
  useEffect(() => {
    let active = true;
    void api
      .workBudget(work.id)
      .then((value) => {
        if (active) setBudget(checked(value));
      })
      .catch((reason) => {
        if (active) setError(failure(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, work.id, refreshKey]);

  const selectMetric = (metric: BudgetMetric) => {
    const policy = budget?.metrics[metric]?.policy;
    if (!policy) return;
    setEditor((current) =>
      current
        ? {
            ...current,
            metric,
            mode: policy.primary === null ? 'uncapped' : policy.reserve > 0 ? 'reserve' : 'bounded',
            primary: String(policy.primary ?? 0),
            reserve: String(policy.reserve),
          }
        : null,
    );
  };
  const open = (type: Editor['type'], mode?: Mode) => {
    if (!budget || !connected) return;
    const metric = metrics.includes(budget.limiting_metric as BudgetMetric)
      ? (budget.limiting_metric as BudgetMetric)
      : 'tokens';
    const policy = budget.metrics[metric].policy;
    setEditor({
      type,
      revision: budget.revision,
      metric,
      mode: mode ?? (policy.primary === null ? 'uncapped' : policy.reserve > 0 ? 'reserve' : 'bounded'),
      primary: String(policy.primary ?? 0),
      reserve: String(policy.reserve),
      reason: '',
      usageIds: [],
      resume: false,
    });
    setCandidate(null);
    setError('');
    setNotice('');
  };
  const close = () => {
    if (!busy) {
      setEditor(null);
      setCandidate(null);
    }
  };
  const valid =
    !!editor &&
    editor.reason.trim().length >= 5 &&
    editor.reason.length <= 2000 &&
    (editor.type === 'reconcile'
      ? editor.usageIds.length > 0 && editor.usageIds.length <= 50
      : editor.mode === 'uncapped' ||
        (integer(editor.primary) &&
          (editor.mode !== 'reserve' || integer(editor.reserve)) &&
          Number(editor.primary) + (editor.mode === 'reserve' ? Number(editor.reserve) : 0) <= 1000000000));
  const save = async () => {
    if (!editor || busy || !connected || (!candidate && !valid)) return;
    let selected = candidate;
    if (!selected) {
      const key = `budget-${editor.type}:${crypto.randomUUID()}`;
      if (editor.type === 'amend') {
        const primary = editor.mode === 'uncapped' ? null : Number(editor.primary);
        const reserve = editor.mode === 'reserve' ? Number(editor.reserve) : 0;
        selected = {
          key,
          type: 'amend',
          request: {
            version: 1,
            expected_revision: editor.revision,
            metric: editor.metric,
            policy: { primary, reserve, absolute: primary === null ? null : primary + reserve },
            reason: editor.reason.trim(),
            resume: editor.resume,
          },
        };
      } else
        selected = {
          key,
          type: 'reconcile',
          request: {
            version: 1,
            expected_revision: editor.revision,
            usage_ids: [...editor.usageIds],
            reason: editor.reason.trim(),
          },
        };
      setCandidate(selected);
    }
    setBusy(true);
    setError('');
    try {
      const updated =
        selected.type === 'amend'
          ? await api.amendBudget(work.id, selected.request, selected.key)
          : await api.reconcileBudget(work.id, selected.request, selected.key);
      setNotice(
        selected.type === 'amend'
          ? selected.request.resume
            ? 'Limits saved. Resume requested; the run remains subject to its other controls.'
            : 'Limits saved. The run was not resumed.'
          : 'Selected reservations retained as unknown usage. The run was not resumed.',
      );
      setEditor(null);
      setCandidate(null);
      onChanged?.(updated);
      await load();
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const inspect = async () => {
    if (busy) return;
    setEditor(null);
    setCandidate(null);
    setError('');
    setNotice('Inspect the saved revision and authorization history before preparing another command.');
    await load();
  };

  return (
    <section className="grid min-w-0 gap-4" aria-label="Run budget limits">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h3 className="text-base font-semibold">Run limits</h3>
          <p className={note}>Independent ceilings and recorded owner authorizations.</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={loading || busy}
          onClick={() => void load()}
        >
          Refresh limits
        </Button>
      </header>
      {!connected && (
        <Notice tone="warning" role="status">
          Disconnected. Budget changes are unavailable; the displayed snapshot may be stale.
        </Notice>
      )}
      {error && !editor && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="neutral" role="status">
          {notice}
        </Notice>
      )}
      {loading && !budget ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading recorded limits…
        </p>
      ) : !budget ? (
        <p className="text-sm text-muted-foreground">No budget snapshot available.</p>
      ) : (
        <>
          {budgetBlocked && (
            <section
              className="grid min-w-0 gap-4 rounded-lg border border-primary/50 bg-accent p-5"
              aria-label="Budget decision"
            >
              <div className="grid gap-1.5">
                <Eyebrow>Operator decision required</Eyebrow>
                <h3 className="text-lg leading-snug font-semibold">
                  Budget authorization required — choose how to continue
                </h3>
                <p className="max-w-[78ch] text-sm text-muted-foreground">
                  The next step was blocked by a budget check. Recorded usage can still be below a ceiling: a
                  model call must also fit its reservation before it starts. Review the recorded reason before
                  changing a limit. Other limits, paid API spending and factory policies still apply. Nothing
                  changes until you review and save the authorization.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  type="button"
                  variant="primary"
                  disabled={!canAmend || busy}
                  onClick={() => open('amend', 'bounded')}
                >
                  Set a new limit
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canAmend || busy}
                  onClick={() => open('amend', 'uncapped')}
                >
                  Remove a ceiling
                </Button>
                <span className={note}>Or leave this run blocked and decide later.</span>
              </div>
            </section>
          )}
          {budget.denial && <BudgetBlockReason denial={budget.denial} closed={closed} />}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            <span>Authorization revision {budget.revision}</span>
            <span>
              {closed ? 'Last phase' : 'Pending step'}: {budget.pending_step}
            </span>
            {budget.limiting_metric && budget.limiting_metric !== 'exhausted' && (
              <strong className="font-semibold text-foreground">
                Limiting metric: {labels[budget.limiting_metric as BudgetMetric] ?? budget.limiting_metric}
              </strong>
            )}
          </div>
          <Table className="text-xs">
            <TableCaption className="mt-0 caption-top border-b border-border px-4 py-2.5 text-left text-xs">
              Current run budget snapshot
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead>Used</TableHead>
                <TableHead>Reserved</TableHead>
                <TableHead>Remaining</TableHead>
                <TableHead>Primary</TableHead>
                <TableHead>Reserve</TableHead>
                <TableHead>Absolute</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.map((metric) => {
                const row = budget.metrics[metric];
                if (!row) return null;
                return (
                  <TableRow key={metric}>
                    <TableHead scope="row" className="py-3 align-top text-foreground">
                      {labels[metric]}
                    </TableHead>
                    <TableCell className={cell}>
                      {row.used === null
                        ? 'Unknown'
                        : `${number(row.used)}${row.unknown ? ' measured · incomplete' : ''}`}
                    </TableCell>
                    <TableCell className={cell}>
                      {number(row.reserved)}
                      {row.unknown && (
                        <small className="mt-1 block text-muted-foreground">Unsettled usage</small>
                      )}
                    </TableCell>
                    <TableCell className={cell}>
                      {row.remaining === null
                        ? row.policy.primary === null
                          ? 'Uncapped'
                          : 'Unknown'
                        : number(row.remaining)}
                    </TableCell>
                    <TableCell className={cell}>
                      {row.policy.primary === null ? 'Uncapped' : number(row.policy.primary)}
                    </TableCell>
                    <TableCell className={cell}>{number(row.policy.reserve)}</TableCell>
                    <TableCell className={cell}>
                      {row.policy.absolute === null ? 'Uncapped' : number(row.policy.absolute)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className={note}>
            {budget.token_prevention === 'cli_post_invocation'
              ? 'CLI aggregate token usage can be known only after an invocation; reservations and per-operation safeguards still apply.'
              : 'Dispatch uses bounded reservations before provider calls.'}{' '}
            Paid API spend remains separately authorized.
          </p>
          {closed ? (
            <p className={note}>
              This run is {work.status === 'cancelled' ? 'cancelled' : 'completed'}. Limits and usage are a
              final record.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                type="button"
                variant="secondary"
                disabled={!canAmend || busy}
                onClick={() => open('amend')}
              >
                Amend limits
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!canAmend || busy || !budget.unsettled_usage_ids.length}
                onClick={() => open('reconcile')}
              >
                Review unsettled usage{budget.unreconciled_calls ? ` (${budget.unreconciled_calls})` : ''}
              </Button>
              {connected && !canAmend && (
                <small className={note}>
                  Pause the run before changing authorizations or reconciling usage.
                </small>
              )}
            </div>
          )}
          <Disclosure
            variant="plain"
            summary={`Authorization history (${budget.authorizations.length})`}
            contentClassName="gap-0 pl-0"
          >
            {!budget.authorizations.length ? (
              <p className="text-sm text-muted-foreground">No amendments or reserve activations recorded.</p>
            ) : (
              <div className="grid divide-y divide-border border-y border-border">
                {budget.authorizations.map((authorization) => (
                  <article key={authorization.revision} className="grid min-w-0 gap-1 py-3 text-xs">
                    <strong className="text-sm font-semibold">
                      Revision {authorization.revision} · {labels[authorization.metric]} ·{' '}
                      {authorization.operation.replaceAll('_', ' ')}
                    </strong>
                    <p>{authorization.reason}</p>
                    <code className="block font-mono text-muted-foreground [overflow-wrap:anywhere]">
                      {JSON.stringify(authorization.before)} → {JSON.stringify(authorization.after)}
                    </code>
                  </article>
                ))}
              </div>
            )}
          </Disclosure>
        </>
      )}
      {editor && (
        <Dialog
          open
          onClose={close}
          title={editor.type === 'amend' ? 'Amend run limits' : 'Review unsettled usage'}
          busy={busy}
          dirty={!!editor.reason && !candidate}
          description={`Run ${work.id} · authorization revision ${editor.revision}. ${editor.resume ? 'You are authorizing a resume after these limits are saved.' : 'The run stays paused unless you explicitly request a resume.'}`}
          footer={
            <>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void inspect()}>
                Inspect current limits
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!connected || busy || (!candidate && !valid)}
                onClick={() => void save()}
              >
                {busy
                  ? 'Saving…'
                  : candidate
                    ? 'Retry exact command'
                    : editor.type === 'amend'
                      ? editor.resume
                        ? 'Save limits and resume'
                        : 'Save limits'
                      : 'Retain selected reservations'}
              </Button>
            </>
          }
        >
          <div className="grid gap-4">
            {error && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            {candidate && (
              <p className={note}>
                The submitted candidate is locked. A retry keeps the same command receipt; inspect current
                limits before creating another candidate.
              </p>
            )}
            <fieldset disabled={!connected || busy || !!candidate} className="grid min-w-0 gap-4">
              {editor.type === 'amend' ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Metric">
                      <Select
                        value={editor.metric}
                        onChange={(event) => selectMetric(event.target.value as BudgetMetric)}
                      >
                        {metrics.map((metric) => (
                          <option key={metric} value={metric}>
                            {labels[metric]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Cumulative limit policy">
                      <Select
                        value={editor.mode}
                        onChange={(event) => setEditor({ ...editor, mode: event.target.value as Mode })}
                      >
                        <option value="bounded">Bounded</option>
                        <option value="reserve">With finite reserve</option>
                        <option value="uncapped">No cumulative cap</option>
                      </Select>
                    </Field>
                  </div>
                  {editor.mode === 'uncapped' ? (
                    <Notice tone="warning">
                      This removes the cumulative {labels[editor.metric].toLowerCase()} ceiling. Factory
                      policy, provider limits and cancellation still apply.
                    </Notice>
                  ) : (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Primary ceiling">
                          <Input
                            type="number"
                            min={0}
                            max={1000000000}
                            step={1}
                            value={editor.primary}
                            onChange={(event) => setEditor({ ...editor, primary: event.target.value })}
                          />
                        </Field>
                        {editor.mode === 'reserve' && (
                          <Field label="Authorized finite reserve">
                            <Input
                              type="number"
                              min={0}
                              max={1000000000}
                              step={1}
                              value={editor.reserve}
                              onChange={(event) => setEditor({ ...editor, reserve: event.target.value })}
                            />
                          </Field>
                        )}
                      </div>
                      <p className="text-sm">
                        Absolute authorized ceiling:{' '}
                        {integer(editor.primary) && (editor.mode !== 'reserve' || integer(editor.reserve))
                          ? number(
                              Number(editor.primary) +
                                (editor.mode === 'reserve' ? Number(editor.reserve) : 0),
                            )
                          : 'Enter valid integers'}
                        .
                      </p>
                    </>
                  )}
                  <p className={note}>
                    A reserve is granted once and never replenishes automatically. Zero repair cycles permits
                    no repair attempts.
                  </p>
                  <CheckField
                    className="rounded-lg border border-border bg-secondary p-3.5"
                    label="Resume this run after saving the limits"
                    checked={editor.resume}
                    disabled={!!budget?.unreconciled_calls}
                    onChange={(event) => setEditor({ ...editor, resume: event.target.checked })}
                  />
                  <p className={note}>
                    {budget?.unreconciled_calls
                      ? 'Review unsettled usage before requesting a resume. You can still save limits now.'
                      : 'Resuming may invoke the configured models and consume usage. Other ceilings can block the run again.'}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm">
                    Retain the full selected reservations as unknown consumption. This does not report
                    measured usage, release tokens or resume the run.
                  </p>
                  <div className="grid gap-3">
                    {budget?.unsettled_usage_ids.map((id) => (
                      <CheckField
                        key={id}
                        label={<code className="font-mono text-xs [overflow-wrap:anywhere]">{id}</code>}
                        checked={editor.usageIds.includes(id)}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            usageIds: event.target.checked
                              ? [...editor.usageIds, id]
                              : editor.usageIds.filter((item) => item !== id),
                          })
                        }
                      />
                    ))}
                  </div>
                  {budget && budget.unreconciled_calls > budget.unsettled_usage_ids.length && (
                    <small className={note}>
                      Showing {budget.unsettled_usage_ids.length} of {budget.unreconciled_calls} unsettled
                      calls. Other reservations remain unresolved.
                    </small>
                  )}
                </>
              )}
              <Field label="Reason for this authorization">
                <Textarea
                  minLength={5}
                  maxLength={2000}
                  value={editor.reason}
                  onChange={(event) => setEditor({ ...editor, reason: event.target.value })}
                />
              </Field>
            </fieldset>
          </div>
        </Dialog>
      )}
    </section>
  );
}

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
import Select from './components/Select';
import './BudgetPanel.css';
import BudgetBlockReason from './BudgetBlockReason';

const labels: Record<BudgetMetric, string> = {
  tokens: 'Tokens',
  invocations: 'Model invocations',
  active_seconds: 'Active seconds',
  repairs: 'Repair cycles',
};
const metrics = Object.keys(labels) as BudgetMetric[];
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
  const canAmend = connected && ['paused', 'blocked'].includes(work.status) && work.control !== 'cancel';
  const budgetBlocked =
    work.status === 'blocked' &&
    !!work.error_code &&
    (work.error_code.startsWith('BUDGET_') || work.error_code.endsWith('_BUDGET_EXHAUSTED')) &&
    work.error_code !== 'CONTEXT_BUDGET_EXHAUSTED';

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
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setBudget(null);
    setEditor(null);
    setCandidate(null);
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
    <section className="budget-panel" aria-label="Run budget limits">
      <header className="budget-panel-heading">
        <div>
          <h3>Run limits</h3>
          <p>Independent ceilings and recorded owner authorizations.</p>
        </div>
        <Button type="button" className="button small" disabled={loading || busy} onClick={() => void load()}>
          Refresh limits
        </Button>
      </header>
      {!connected && (
        <p className="notice warning" role="status">
          Disconnected. Budget changes are unavailable; the displayed snapshot may be stale.
        </p>
      )}
      {error && !editor && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {loading && !budget ? (
        <p role="status">Loading recorded limits…</p>
      ) : !budget ? (
        <p>No budget snapshot available.</p>
      ) : (
        <>
          {budgetBlocked && (
            <section className="budget-decision" aria-label="Budget decision">
              <div>
                <span className="eyebrow">Operator decision required</span>
                <h3>Budget authorization required — choose how to continue</h3>
                <p>
                  The next step was blocked by a budget check. Recorded usage can still be below a ceiling: a
                  model call must also fit its reservation before it starts. Review the recorded reason before
                  changing a limit. Other limits, paid API spending and factory policies still apply. Nothing
                  changes until you review and save the authorization.
                </p>
              </div>
              <div className="budget-panel-actions">
                <Button
                  type="button"
                  className="button primary"
                  disabled={!canAmend || busy}
                  onClick={() => open('amend', 'bounded')}
                >
                  Set a new limit
                </Button>
                <Button
                  type="button"
                  className="button"
                  disabled={!canAmend || busy}
                  onClick={() => open('amend', 'uncapped')}
                >
                  Remove a ceiling
                </Button>
                <span className="budget-explanation">Or leave this run blocked and decide later.</span>
              </div>
            </section>
          )}
          {budget.denial && <BudgetBlockReason denial={budget.denial} />}
          <div className="budget-snapshot">
            <span>Authorization revision {budget.revision}</span>
            <span>Pending step: {budget.pending_step}</span>
            {budget.limiting_metric && budget.limiting_metric !== 'exhausted' && (
              <strong>
                Limiting metric: {labels[budget.limiting_metric as BudgetMetric] ?? budget.limiting_metric}
              </strong>
            )}
          </div>
          <div className="budget-table-wrap">
            <table>
              <caption>Current run budget snapshot</caption>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Used</th>
                  <th>Reserved</th>
                  <th>Remaining</th>
                  <th>Primary</th>
                  <th>Reserve</th>
                  <th>Absolute</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((metric) => {
                  const row = budget.metrics[metric];
                  if (!row) return null;
                  return (
                    <tr key={metric}>
                      <th scope="row">{labels[metric]}</th>
                      <td>
                        {row.used === null
                          ? 'Unknown'
                          : `${number(row.used)}${row.unknown ? ' measured · incomplete' : ''}`}
                      </td>
                      <td>
                        {number(row.reserved)}
                        {row.unknown && <small>Unsettled usage</small>}
                      </td>
                      <td>
                        {row.remaining === null
                          ? row.policy.primary === null
                            ? 'Uncapped'
                            : 'Unknown'
                          : number(row.remaining)}
                      </td>
                      <td>{row.policy.primary === null ? 'Uncapped' : number(row.policy.primary)}</td>
                      <td>{number(row.policy.reserve)}</td>
                      <td>{row.policy.absolute === null ? 'Uncapped' : number(row.policy.absolute)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="budget-explanation">
            {budget.token_prevention === 'cli_post_invocation'
              ? 'CLI aggregate token usage can be known only after an invocation; reservations and per-operation safeguards still apply.'
              : 'Dispatch uses bounded reservations before provider calls.'}{' '}
            Paid API spend remains separately authorized.
          </p>
          <div className="budget-panel-actions">
            <Button
              type="button"
              className="button"
              disabled={!canAmend || busy}
              onClick={() => open('amend')}
            >
              Amend limits
            </Button>
            <Button
              type="button"
              className="button"
              disabled={!canAmend || busy || !budget.unsettled_usage_ids.length}
              onClick={() => open('reconcile')}
            >
              Review unsettled usage{budget.unreconciled_calls ? ` (${budget.unreconciled_calls})` : ''}
            </Button>
            {connected && !canAmend && (
              <small>Pause the run before changing authorizations or reconciling usage.</small>
            )}
          </div>
          <details className="budget-history">
            <summary>Authorization history ({budget.authorizations.length})</summary>
            {!budget.authorizations.length ? (
              <p>No amendments or reserve activations recorded.</p>
            ) : (
              budget.authorizations.map((authorization) => (
                <article key={authorization.revision}>
                  <strong>
                    Revision {authorization.revision} · {labels[authorization.metric]} ·{' '}
                    {authorization.operation.replaceAll('_', ' ')}
                  </strong>
                  <p>{authorization.reason}</p>
                  <code>
                    {JSON.stringify(authorization.before)} → {JSON.stringify(authorization.after)}
                  </code>
                </article>
              ))
            )}
          </details>
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
              <Button type="button" className="button" disabled={busy} onClick={() => void inspect()}>
                Inspect current limits
              </Button>
              <Button
                type="button"
                className="button primary"
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
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {candidate && (
            <p className="budget-explanation">
              The submitted candidate is locked. A retry keeps the same command receipt; inspect current
              limits before creating another candidate.
            </p>
          )}
          <fieldset disabled={!connected || busy || !!candidate} className="budget-editor-fields">
            {editor.type === 'amend' ? (
              <>
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
                {editor.mode === 'uncapped' ? (
                  <p className="notice warning">
                    This removes the cumulative {labels[editor.metric].toLowerCase()} ceiling. Factory policy,
                    provider limits and cancellation still apply.
                  </p>
                ) : (
                  <>
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
                    <p>
                      Absolute authorized ceiling:{' '}
                      {integer(editor.primary) && (editor.mode !== 'reserve' || integer(editor.reserve))
                        ? number(
                            Number(editor.primary) + (editor.mode === 'reserve' ? Number(editor.reserve) : 0),
                          )
                        : 'Enter valid integers'}
                      .
                    </p>
                  </>
                )}
                <p className="budget-explanation">
                  A reserve is granted once and never replenishes automatically. Zero repair cycles permits no
                  repair attempts.
                </p>
                <label className="budget-resume-choice">
                  <Input
                    type="checkbox"
                    checked={editor.resume}
                    disabled={!!budget?.unreconciled_calls}
                    onChange={(event) => setEditor({ ...editor, resume: event.target.checked })}
                  />
                  <span>Resume this run after saving the limits</span>
                </label>
                <p className="budget-explanation">
                  {budget?.unreconciled_calls
                    ? 'Review unsettled usage before requesting a resume. You can still save limits now.'
                    : 'Resuming may invoke the configured models and consume usage. Other ceilings can block the run again.'}
                </p>
              </>
            ) : (
              <>
                <p>
                  Retain the full selected reservations as unknown consumption. This does not report measured
                  usage, release tokens or resume the run.
                </p>
                <div className="budget-usage-list">
                  {budget?.unsettled_usage_ids.map((id) => (
                    <label key={id}>
                      <Input
                        type="checkbox"
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
                      <code>{id}</code>
                    </label>
                  ))}
                </div>
                {budget && budget.unreconciled_calls > budget.unsettled_usage_ids.length && (
                  <small>
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
        </Dialog>
      )}
    </section>
  );
}

import { Fragment, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Check, ExternalLink } from 'lucide-react';
import type {
  Api,
  AuditView,
  HumanQuestion,
  Project,
  SecurityException,
  SecurityFinding,
  WorkOrder,
} from '../../api';
import Button from '../../components/Button';
import Input from '../../components/Input';
import Textarea from '../../components/Textarea';
import Field from '../../components/FormField';
import Select from '../../components/Select';
import Dialog, { DialogActions } from '../../components/Dialog';
import Tabs from '../../components/Tabs';
import Notice from '../../components/Notice';
import Disclosure from '../../components/Disclosure';
import EmptyState from '../../components/EmptyState';
import { SectionHeading, Eyebrow } from '../../components/PageHeader';
import UsageMeter, { UsageMeterGrid } from '../../components/UsageMeter';
import { Badge } from '../../components/ui/badge';
import { buttonVariants } from '../../components/ui/button';
import { Card, CardDescription, CardTitle } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import ExecutionTimeline from '../../ExecutionTimeline';
import WorkAudit from '../../WorkAudit';
import RunReport from '../../RunReport';
import BudgetPanel from '../../BudgetPanel';
import ReleasesPanel from '../../ReleasesPanel';
import RemoteTasksPanel from '../../RemoteTasksPanel';
import useRunUsage from '../../useRunUsage';
import {
  budgetCheckCovered,
  currentBlocker,
  historicalError,
  isBudgetCode,
  isClosed,
  pendingQuestions,
} from '../../runState';
import {
  CliProgressPolicy,
  ErrorNotice,
  RunBadge,
  emptyPlanMessages,
  externalUrl,
  lines,
  message,
  modeLabels,
  phaseLabels,
  roleLabels,
  time,
  useAction,
} from './shared';

type DetailTab = 'Process' | 'Tasks & evidence' | 'Review & security' | 'Activity' | 'Limits & scope';
const detailTabs: DetailTab[] = [
  'Process',
  'Tasks & evidence',
  'Review & security',
  'Activity',
  'Limits & scope',
];
const specialties: Record<string, string> = {
  infrastructure: 'Infrastructure',
  frontend: 'Frontend',
  backend: 'Backend',
  documentation: 'Documentation',
};
const findingCategories: Record<string, string> = {
  secret: 'Secret',
  vulnerability: 'Vulnerability',
  code: 'Code analysis',
  configuration: 'Configuration',
  scanner_error: 'Incomplete check',
};

/** Quiet one-line state for an empty list inside a section. */
function QuietState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-code px-4 py-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('grid min-w-0 content-start gap-4', className)}>{children}</section>;
}

function Count({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{children}</span>;
}

export default function RunDetail({
  api,
  connected = true,
  order,
  project,
  onChanged,
  cliMode,
}: {
  api: Api;
  connected?: boolean;
  order: WorkOrder;
  project?: Project;
  onChanged: () => Promise<void>;
  cliMode: boolean;
}) {
  const action = useAction();
  const [detailTab, setDetailTab] = useState<DetailTab>('Process');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [eventsError, setEventsError] = useState('');
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [auditError, setAuditError] = useState('');
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditRefresh, setAuditRefresh] = useState(0);
  const liveUsage = useRunUsage(api, order.id, order.status, connected);
  useEffect(() => {
    let live = true;
    void api
      .audit(order.id)
      .then((value) => {
        if (live) {
          setAudit(value);
          setAuditError('');
        }
      })
      .catch((error) => {
        if (live) setAuditError(message(error));
      })
      .finally(() => {
        if (live) setAuditLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, order.id, order.calls_used, order.phase, order.status, auditRefresh]);
  useEffect(() => {
    let live = true;
    void api
      .events(order.id)
      .then((data) => {
        if (live) {
          setEvents(data);
          setEventsError('');
        }
      })
      .catch((err) => {
        if (live) setEventsError(message(err));
      });
    return () => {
      live = false;
    };
  }, [api, order.id, order.updated_at]);
  const control = (next: 'pause' | 'resume' | 'cancel') => {
    if (!connected) return;
    void action.run(async () => {
      await api.control(order.id, next);
      setConfirmCancel(false);
      await onChanged();
    });
  };
  const pending = pendingQuestions(order);
  const terminal = isClosed(order) || order.phase === 'security_watch';
  // The status decides what is current: a code retained on a closed run is history, not a pending decision.
  const blocker = currentBlocker(order);
  const history = historicalError(order);
  const budgetCovered =
    isBudgetCode(blocker) && budgetCheckCovered(order.budget_denial, order.effective_budget_policy);
  const budgetDecision =
    isBudgetCode(blocker) &&
    !budgetCovered &&
    ['blocked', 'paused'].includes(order.status) &&
    order.control !== 'cancel';
  const pr = externalUrl(order.evidence?.pr_url);
  const perAgent =
    order.budget.max_calls === null &&
    order.budget.max_tokens === null &&
    order.budget.active_seconds === null;
  const canChangeLimits =
    cliMode &&
    !perAgent &&
    !terminal &&
    ['paused', 'blocked'].includes(order.status) &&
    order.control !== 'cancel' &&
    order.budget.max_cost_usd === 0;

  return (
    <div className="grid min-w-0 gap-3">
      <header data-testid="run-header" className="grid min-w-0 gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5">
            <Link to="/runs" className="text-muted-foreground hover:text-foreground">
              Runs
            </Link>
            <span aria-hidden="true">/</span>
            <span>{project?.name || 'Project'}</span>
            <span aria-hidden="true">/</span>
            <span>{modeLabels[order.mode]}</span>
            <span aria-hidden="true">/</span>
            <span>Review {order.plan_revision}</span>
          </nav>
          <Badge variant="outline" className="text-primary">
            {phaseLabels[order.phase] || order.phase}
          </Badge>
          <span>Updated {time(order.updated_at)}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1
              tabIndex={-1}
              data-focus-heading
              className="text-2xl font-semibold tracking-tight outline-none"
            >
              {order.phase === 'security_watch' ? 'Monitoring' : modeLabels[order.mode]}{' '}
              {project?.name || 'project'}
            </h1>
            <RunBadge value={order.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!terminal && ['running', 'queued', 'waiting_input', 'failed'].includes(order.status) && (
              <Button
                type="button"
                size="sm"
                disabled={!connected || action.busy || order.control === 'pause'}
                onClick={() => control('pause')}
              >
                Pause
              </Button>
            )}
            {!terminal && ['paused', 'blocked', 'failed'].includes(order.status) && (
              <Button
                type="button"
                size="sm"
                disabled={action.busy || !connected}
                onClick={() => (budgetDecision ? setDetailTab('Limits & scope') : control('resume'))}
              >
                {budgetDecision ? 'Resolve budget' : 'Resume'}
              </Button>
            )}
            {!terminal && (
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={action.busy || !connected}
                onClick={() => setConfirmCancel(!confirmCancel)}
              >
                Cancel run
              </Button>
            )}
            {pr && (
              <a className={buttonVariants({ size: 'sm' })} href={pr} target="_blank" rel="noreferrer">
                Review PR ↗
              </a>
            )}
          </div>
        </div>
        {history && (
          <Notice tone="neutral" role="note" aria-label="Retained run history" title={`History · ${history}`}>
            <p>
              Last recorded stop reason before this run was{' '}
              {order.status === 'cancelled' ? 'cancelled' : 'closed'}. No decision is pending and it cannot be
              resumed. The recorded evidence remains available for inspection.
            </p>
          </Notice>
        )}
        {blocker && (
          <Notice
            tone={budgetCovered ? 'neutral' : 'warning'}
            title={budgetCovered ? 'Limits updated — run still stopped' : blocker}
          >
            <p>
              {budgetCovered
                ? 'The saved authorization covers the recorded budget check. Resume rechecks all current controls and may invoke the configured models.'
                : order.summary}
            </p>
            {budgetDecision && (
              <div className="mt-2 grid justify-items-start gap-3">
                <p>
                  The run is waiting for your budget decision. Set a new ceiling or remove a ceiling, then
                  choose whether to resume. Other permissions and checks remain in force.
                </p>
                <Button type="button" variant="primary" onClick={() => setDetailTab('Limits & scope')}>
                  Review budget options
                </Button>
              </div>
            )}
          </Notice>
        )}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
          {!blocker && <p className="max-w-[72ch] text-sm text-muted-foreground">{order.summary}</p>}
          <Disclosure
            variant="plain"
            summary="Full objective"
            aria-label="Run objective"
            className="min-w-0 basis-full text-sm sm:basis-auto"
          >
            <p className="max-w-[72ch] text-sm whitespace-pre-wrap text-muted-foreground">
              {order.objective}
            </p>
          </Disclosure>
        </div>
      </header>
      {order.control && !terminal && ['running', 'queued'].includes(order.status) && (
        <Notice
          tone="neutral"
          role="status"
          title={order.control === 'pause' ? 'Pause requested.' : 'Cancellation requested.'}
        >
          <p>Work will stop at the next safe checkpoint. You can continue inspecting its status.</p>
        </Notice>
      )}
      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this run?"
        description="Pending work stops at a safe boundary. Saved evidence remains available."
        busy={action.busy}
      >
        <DialogActions>
          <Button type="button" disabled={action.busy} onClick={() => setConfirmCancel(false)}>
            Keep running
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={action.busy || !connected}
            onClick={() => control('cancel')}
          >
            Confirm cancellation
          </Button>
        </DialogActions>
      </Dialog>
      {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
      {pending.length > 0 && (
        <Section>
          <SectionHeading
            title="Your decision unlocks the next step"
            actions={<Count>{pending.length} pending</Count>}
          />
          {pending.map((question) => (
            <QuestionForm
              connected={connected}
              key={question.id}
              api={api}
              order={order}
              question={question}
              onChanged={onChanged}
            />
          ))}
        </Section>
      )}
      <Tabs
        items={detailTabs.map((value) => ({ value, label: value }))}
        value={detailTab}
        onChange={setDetailTab}
        label="Run workspace"
      >
        {(activeTab) => (
          <div>
            {activeTab === 'Process' && (
              <div className="grid min-w-0 gap-5">
                <RemoteTasksPanel
                  api={api}
                  workId={order.id}
                  connected={connected}
                  refreshKey={order.updated_at}
                  showEmpty={false}
                />
                <ExecutionTimeline
                  key={order.id}
                  api={api}
                  workId={order.id}
                  order={order}
                  audit={audit}
                  liveUsage={liveUsage}
                  active={['running', 'queued'].includes(order.status)}
                />
              </div>
            )}
            {activeTab === 'Review & security' && (
              <div className="grid min-w-0 gap-5">
                <RunReport work={order} />
                {order.security_snapshot_digest && (
                  <SecurityExceptions api={api} order={order} onChanged={onChanged} connected={connected} />
                )}
              </div>
            )}
            {activeTab !== 'Process' && activeTab !== 'Review & security' && (
              <div
                data-view={
                  activeTab === 'Tasks & evidence'
                    ? 'evidence'
                    : activeTab === 'Activity'
                      ? 'activity'
                      : 'limits'
                }
                className="@container grid min-w-0 gap-6"
              >
                <div
                  className={cn(
                    'grid min-w-0 gap-6',
                    activeTab === 'Limits & scope' && '@4xl:grid-cols-[minmax(0,1fr)_22rem]',
                  )}
                >
                  <div className="grid min-w-0 content-start gap-8">
                    {activeTab === 'Tasks & evidence' && order.evidence && <DeliveryEvidence order={order} />}
                    {activeTab === 'Tasks & evidence' && (
                      <ReleasesPanel api={api} work={order} connected={connected} />
                    )}
                    {activeTab === 'Tasks & evidence' && (
                      <RemoteTasksPanel
                        api={api}
                        workId={order.id}
                        connected={connected}
                        refreshKey={order.updated_at}
                      />
                    )}
                    {activeTab === 'Tasks & evidence' && <WorkPlan order={order} />}
                    {activeTab === 'Tasks & evidence' && (
                      <Section>
                        <SectionHeading
                          title="Security pipeline"
                          actions={<Count>{order.findings.length} findings</Count>}
                        />
                        {order.findings.length ? (
                          <Findings findings={order.findings} />
                        ) : (
                          <QuietState>
                            {order.evidence
                              ? 'The review recorded no findings.'
                              : 'The security pipeline has not produced a result for this delivery.'}
                          </QuietState>
                        )}
                        {order.security_snapshot_digest && (
                          <SecurityExceptions
                            api={api}
                            order={order}
                            onChanged={onChanged}
                            connected={connected}
                          />
                        )}
                      </Section>
                    )}
                    {activeTab === 'Activity' && (
                      <Section>
                        <SectionHeading
                          title="Activity"
                          actions={
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                setAuditLoading(true);
                                setAuditRefresh((value) => value + 1);
                              }}
                              disabled={auditLoading}
                            >
                              Refresh audit
                            </Button>
                          }
                        />
                        <WorkAudit data={audit} loading={auditLoading} error={auditError} />
                        {eventsError ? (
                          <ErrorNotice>{eventsError}</ErrorNotice>
                        ) : !events.length ? (
                          <QuietState>No recorded events yet.</QuietState>
                        ) : (
                          <ol className="grid gap-0 border-l border-border pl-5" aria-label="Recorded events">
                            {events.map((event, index) => (
                              <li key={String(event.id || index)} className="relative py-2">
                                <span
                                  className="absolute top-3.5 -left-[1.4rem] size-2 rounded-full bg-primary"
                                  aria-hidden="true"
                                />
                                <p className="text-sm">
                                  {String(event.message || event.kind || 'Recorded event')}
                                </p>
                                {typeof event.created_at === 'string' && (
                                  <time className="text-xs text-muted-foreground" dateTime={event.created_at}>
                                    {time(event.created_at)}
                                  </time>
                                )}
                              </li>
                            ))}
                          </ol>
                        )}
                      </Section>
                    )}
                    {activeTab === 'Limits & scope' && (
                      <LimitsAndUsage
                        api={api}
                        order={order}
                        connected={connected}
                        onChanged={onChanged}
                        perAgent={perAgent}
                        canChangeLimits={canChangeLimits}
                        action={action}
                      />
                    )}
                  </div>
                  {activeTab === 'Limits & scope' && (
                    <aside className="grid min-w-0 content-start gap-4" aria-label="Run scope">
                      <Card className="gap-3">
                        <CardTitle>Acceptance criteria</CardTitle>
                        <ul className="grid list-disc gap-1.5 pl-5 text-sm">
                          {order.acceptance.map((criterion, index) => (
                            <li key={index}>{criterion}</li>
                          ))}
                        </ul>
                        {order.constraints.length > 0 && (
                          <>
                            <CardTitle as="h3" className="text-base">
                              Constraints
                            </CardTitle>
                            <ul className="grid list-disc gap-1.5 pl-5 text-sm">
                              {order.constraints.map((constraint, index) => (
                                <li key={index}>{constraint}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </Card>
                      {!terminal && (
                        <ScopeForm api={api} order={order} onChanged={onChanged} connected={connected} />
                      )}
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        Run <code className="font-mono [overflow-wrap:anywhere]">{order.id}</code>
                        <br />
                        Created {time(order.created_at)}
                      </p>
                    </aside>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Tabs>
    </div>
  );
}

function LimitsAndUsage({
  api,
  order,
  connected,
  onChanged,
  perAgent,
  canChangeLimits,
  action,
}: {
  api: Api;
  order: WorkOrder;
  connected: boolean;
  onChanged: () => Promise<void>;
  perAgent: boolean;
  canChangeLimits: boolean;
  action: ReturnType<typeof useAction>;
}) {
  const budgetPanel = (
    <BudgetPanel
      connected={connected}
      api={api}
      work={order}
      refreshKey={order.updated_at}
      onChanged={() => {
        void onChanged();
      }}
    />
  );
  if (order.effective_budget_policy || order.budget.policy) return budgetPanel;
  return (
    <>
      <Card aria-labelledby="usage-title" className="@container">
        <div className="grid gap-1.5">
          <CardTitle id="usage-title">Usage and limits</CardTitle>
          <CardDescription>
            Recorded cumulative usage against this run’s configured ceilings. Pending model consumption may
            not be reflected here.
          </CardDescription>
        </div>
        <UsageMeterGrid>
          <UsageMeter label="Model calls" value={order.calls_used} max={order.budget.max_calls} />
          <UsageMeter label="Tokens" value={order.tokens_used} max={order.budget.max_tokens} />
          <UsageMeter
            label="Recorded API cost"
            value={order.cost_usd}
            max={order.budget.max_cost_usd}
            currency
          />
          <UsageMeter
            label="Active time · min"
            value={Math.round(order.active_seconds_used / 60)}
            max={order.budget.active_seconds === null ? null : Math.round(order.budget.active_seconds / 60)}
          />
        </UsageMeterGrid>
        {perAgent && <CliProgressPolicy />}
        {canChangeLimits && (
          <div className="grid justify-items-start gap-3">
            <p className="text-sm">
              You can replace cumulative quotas with per-agent controls. Recorded usage and checks remain
              available; the run stays stopped until resumed.
            </p>
            <Disclosure variant="plain" summary="How per-agent controls work">
              <CliProgressPolicy />
            </Disclosure>
            <Button
              type="button"
              size="sm"
              disabled={action.busy || !connected}
              onClick={() =>
                void action.run(async () => {
                  if (!connected) return;
                  await api.useCliProgressLimits(order.id, {
                    expected_revision: order.plan_revision,
                    expected_budget: order.budget,
                  });
                  await onChanged();
                })
              }
            >
              Use per-agent controls
            </Button>
          </div>
        )}
      </Card>
      {isBudgetCode(order.error_code) && budgetPanel}
    </>
  );
}

function DeliveryEvidence({ order }: { order: WorkOrder }) {
  const evidence = order.evidence!;
  return (
    <Section>
      <SectionHeading
        title="Delivery evidence"
        actions={<Count>{evidence.gates.length} recorded checks</Count>}
      />
      <p className="text-sm">{evidence.review}</p>
      {evidence.gates.some(
        (gate) => !gate.snapshot_digest || gate.snapshot_digest !== evidence.snapshot_digest,
      ) && (
        <ErrorNotice>
          Some check snapshots do not match the delivery and cannot validate this evidence.
        </ErrorNotice>
      )}
      {evidence.gates.length ? (
        <ul className="grid gap-2" aria-label="Delivery checks">
          {evidence.gates.map((gate, index) => {
            const matches = Boolean(
              gate.snapshot_digest && gate.snapshot_digest === evidence.snapshot_digest,
            );
            const passed = gate.exit_code === 0 && matches;
            return (
              <li
                key={index}
                data-state={passed ? 'passed' : 'failed'}
                className={cn(
                  'flex min-w-0 items-start justify-between gap-4 rounded-md border px-4 py-3',
                  passed ? 'border-success-border bg-success-bg/40' : 'border-danger-border bg-danger-bg/40',
                )}
              >
                <div className="grid min-w-0 gap-1">
                  <code className="font-mono text-xs [overflow-wrap:anywhere]">{gate.command.join(' ')}</code>
                  <p className="text-xs text-muted-foreground">
                    Exit {gate.exit_code} · {matches ? 'Delivery snapshot' : 'Snapshot differs from delivery'}
                  </p>
                </div>
                <strong className={cn('shrink-0 text-sm', passed ? 'text-success' : 'text-danger')}>
                  {!matches ? 'Foreign evidence' : passed ? 'Passed' : 'Failed'}
                </strong>
              </li>
            );
          })}
        </ul>
      ) : (
        <QuietState>This evidence has no recorded checks.</QuietState>
      )}
      <Disclosure summary="Technical references">
        <dl className="grid gap-x-4 gap-y-2 text-sm @md:grid-cols-[10rem_minmax(0,1fr)] [&_code]:font-mono [&_code]:text-xs [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-muted-foreground">
          <dt>Commit</dt>
          <dd>
            <code>{evidence.commit}</code>
          </dd>
          <dt>Snapshot</dt>
          <dd>
            <code>{evidence.snapshot_digest}</code>
          </dd>
          <dt>Verification profile</dt>
          <dd>
            <code>{evidence.profile_digest}</code>
          </dd>
          <dt>Security rules</dt>
          <dd>{evidence.rules_version}</dd>
          {evidence.branch && (
            <>
              <dt>Branch</dt>
              <dd>
                <code>{evidence.branch}</code>
              </dd>
            </>
          )}
          {evidence.gates.map((gate, index) => (
            <Fragment key={index}>
              <dt>Check {index + 1} · output</dt>
              <dd>
                <code>{gate.output_digest}</code>
              </dd>
              <dt>Check {index + 1} · snapshot</dt>
              <dd>
                <code>{gate.snapshot_digest}</code>
              </dd>
            </Fragment>
          ))}
        </dl>
      </Disclosure>
    </Section>
  );
}

function WorkPlan({ order }: { order: WorkOrder }) {
  const monitoring = order.phase === 'security_watch';
  return (
    <Section>
      <SectionHeading
        title={monitoring ? 'Remediation proposals' : 'Work plan'}
        actions={
          <Count>
            {order.tasks.filter((task) => task.status === 'completed').length} / {order.tasks.length} tasks
          </Count>
        }
      />
      {!order.tasks.length ? (
        <EmptyState title={monitoring ? 'No remediation proposals' : 'No recorded tasks'}>
          {monitoring ? 'Monitoring recorded no remediation proposals.' : emptyPlanMessages[order.status]}
        </EmptyState>
      ) : (
        <ol className="grid gap-2">
          {order.tasks.map((task) => (
            <li key={task.id} className="flex min-w-0 gap-3 rounded-lg border border-border bg-card p-4">
              <span
                className={cn(
                  'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border',
                  task.status === 'completed'
                    ? 'border-success-border bg-success-bg text-success'
                    : 'border-border text-muted-foreground',
                )}
                aria-hidden="true"
              >
                {task.status === 'completed' ? (
                  <Check className="size-3.5" />
                ) : (
                  <span className="size-1.5 rounded-full bg-current" />
                )}
              </span>
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{task.title}</h3>
                  <RunBadge value={task.status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {roleLabels[task.role] || task.role}
                  {task.specialty && task.specialty !== 'general'
                    ? ` · ${specialties[task.specialty]}`
                    : ''}{' '}
                  · {task.attempts} {task.attempts === 1 ? 'attempt' : 'attempts'}
                </p>
                {task.depends_on.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Depends on:{' '}
                    {task.depends_on
                      .map((id) => order.tasks.find((candidate) => candidate.id === id)?.title || id)
                      .join(' · ')}
                  </p>
                )}
                {task.result && <p className="text-sm">{task.result}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function SecurityExceptions({
  api,
  connected,
  order,
  onChanged,
}: {
  api: Api;
  connected: boolean;
  order: WorkOrder;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const [items, setItems] = useState<SecurityException[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const load = useCallback(
    () =>
      api
        .securityExceptions(order.id)
        .then((next) => {
          setItems(next);
          setError('');
        })
        .catch((err: unknown) => setError(message(err))),
    [api, order.id],
  );
  useEffect(() => {
    void load();
  }, [load, order.updated_at]);
  const allowed =
    order.phase !== 'security_watch' &&
    ['paused', 'blocked'].includes(order.status) &&
    Boolean(order.security_snapshot_digest && order.security_rules_version);
  const eligible = order.findings.filter(
    (finding) =>
      !['secret', 'scanner_error'].includes(finding.category) &&
      ['high', 'critical'].includes(finding.severity) &&
      !finding.baseline,
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connected || !allowed) return;
    const data = new FormData(event.currentTarget);
    void action.run(async () => {
      await api.approveSecurityException(order.id, {
        fingerprint: String(data.get('finding')),
        justification: String(data.get('justification')),
        expires_at: new Date(String(data.get('expiry'))).toISOString(),
        snapshot_digest: order.security_snapshot_digest!,
        rules_version: order.security_rules_version!,
        plan_revision: order.plan_revision,
      });
      setShowForm(false);
      await load();
      await onChanged();
    });
  };
  return (
    <div className="grid min-w-0 gap-3">
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
      {items.map((item) => (
        <article key={item.id} className="grid gap-1.5 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Owner-approved exception · revision {item.plan_revision}</h3>
          <p className="text-sm">{item.justification}</p>
          <p className="text-xs text-muted-foreground">
            {item.revoked_at ? `Revoked ${time(item.revoked_at)}` : `Expires ${time(item.expires_at)}`}
          </p>
          {!item.revoked_at && (
            <Button
              type="button"
              variant="link"
              className="justify-self-start px-0 text-danger"
              disabled={action.busy || !connected}
              onClick={() =>
                void action.run(async () => {
                  if (!connected) return;
                  await api.revokeSecurityException(order.id, item.id);
                  await load();
                  await onChanged();
                })
              }
            >
              Revoke exception
            </Button>
          )}
        </article>
      ))}
      {allowed && eligible.length > 0 && (
        <>
          <Button
            type="button"
            size="sm"
            className="justify-self-start"
            disabled={!connected}
            onClick={() => setShowForm(!showForm)}
          >
            Temporary security exception
          </Button>
          {showForm && (
            <Card>
              <form onSubmit={submit}>
                <fieldset className="grid gap-4" disabled={!connected || action.busy}>
                  <div className="grid gap-1">
                    <CardTitle as="h3" className="text-base">
                      Accept a specific risk
                    </CardTitle>
                    <CardDescription>
                      Your approval applies to this source snapshot and revision. Resume the run to verify it
                      again.
                    </CardDescription>
                  </div>
                  <Field label="Finding">
                    <Select name="finding" required defaultValue="">
                      <option value="" disabled>
                        Select the risk
                      </option>
                      {eligible.map((finding) => (
                        <option key={finding.fingerprint} value={finding.fingerprint}>
                          {finding.title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Exception justification">
                    <Textarea name="justification" required minLength={10} maxLength={4000} rows={3} />
                  </Field>
                  <Field label="Expiry · local time" hint="Choose a future date within 30 days.">
                    <Input name="expiry" type="datetime-local" required />
                  </Field>
                  <Button variant="primary" className="justify-self-start" disabled={action.busy}>
                    {action.busy ? 'Saving…' : 'Temporarily approve this risk'}
                  </Button>
                </fieldset>
              </form>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function QuestionForm({
  api,
  connected,
  order,
  question,
  onChanged,
}: {
  api: Api;
  connected: boolean;
  order: WorkOrder;
  question: HumanQuestion;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const [answer, setAnswer] = useState('');
  return (
    <article className="grid gap-4 rounded-lg border border-warning-border bg-card p-5">
      <div className="flex gap-3">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-md bg-warning-bg font-semibold text-warning"
          aria-hidden="true"
        >
          ?
        </span>
        <div className="grid min-w-0 gap-1">
          <Eyebrow className="normal-case">Pending decision · revision {question.plan_revision}</Eyebrow>
          <h3 className="text-base font-semibold">{question.prompt}</h3>
        </div>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!connected) return;
          void action.run(async () => {
            await api.answer(order.id, {
              question_id: question.id,
              plan_revision: question.plan_revision,
              answer,
            });
            await onChanged();
          });
        }}
      >
        <fieldset className="grid gap-4" disabled={!connected || action.busy}>
          {question.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {question.options.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="aria-pressed:border-primary aria-pressed:bg-accent"
                  aria-pressed={answer === option}
                  onClick={() => setAnswer(option)}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
          <Field label="Your answer">
            <Textarea
              required
              rows={2}
              maxLength={12000}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Describe how the team should continue…"
            />
          </Field>
          {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">Your answer will be bound to this decision.</span>
            <Button variant="primary" disabled={action.busy}>
              {action.busy ? 'Sending…' : 'Answer and continue'}
            </Button>
          </div>
        </fieldset>
      </form>
    </article>
  );
}

function ScopeForm({
  api,
  connected,
  order,
  onChanged,
}: {
  api: Api;
  connected: boolean;
  order: WorkOrder;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const canChange = ['paused', 'blocked'].includes(order.status);
  return (
    <Disclosure summary="Change request">
      <p className="text-sm text-muted-foreground">
        Updating scope creates a new plan revision. Previous decisions must be revalidated.{' '}
        {!canChange && (
          <strong className="text-foreground">Pause the run before applying this change.</strong>
        )}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!connected || !canChange) return;
          const data = new FormData(event.currentTarget);
          void action.run(async () => {
            await api.scope(order.id, {
              expected_revision: order.plan_revision,
              objective: String(data.get('objective')),
              acceptance: lines(data.get('acceptance')),
            });
            await onChanged();
          });
        }}
      >
        <fieldset className="grid gap-4" disabled={!connected || action.busy}>
          <Field label="New objective">
            <Textarea name="objective" required minLength={5} defaultValue={order.objective} rows={3} />
          </Field>
          <Field label="Updated criteria">
            <Textarea name="acceptance" required defaultValue={order.acceptance.join('\n')} rows={3} />
          </Field>
          {action.error && <ErrorNotice>{action.error}</ErrorNotice>}
          <Button className="justify-self-start" disabled={action.busy || !canChange}>
            {action.busy ? 'Updating…' : 'Update scope'}
          </Button>
        </fieldset>
      </form>
    </Disclosure>
  );
}

export function Findings({ findings }: { findings: SecurityFinding[] }) {
  return (
    <div className="grid gap-3">
      {findings.map((finding, index) => {
        const reference = externalUrl(finding.reference);
        return (
          <article
            key={`${finding.fingerprint}-${index}`}
            className="grid gap-2 rounded-lg border border-border bg-card p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <RunBadge value={finding.severity} />
              <span className="font-mono text-xs text-muted-foreground">{finding.scanner}</span>
              {finding.baseline && <Badge variant="neutral">Accepted baseline</Badge>}
              {finding.exception_id && <Badge variant="warning">Temporary exception</Badge>}
            </div>
            <h3 className="text-sm font-semibold">{finding.title}</h3>
            {finding.path && (
              <code className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">
                {finding.path}
                {finding.line ? `:${finding.line}` : ''}
              </code>
            )}
            {finding.remediation && <p className="text-sm">{finding.remediation}</p>}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{findingCategories[finding.category]}</span>
              {reference ? (
                <a
                  className="inline-flex items-center gap-1 text-link hover:underline"
                  href={reference}
                  target="_blank"
                  rel="noreferrer"
                >
                  View reference ↗
                  <ExternalLink className="sr-only" aria-hidden="true" />
                </a>
              ) : (
                finding.reference && <span>{finding.reference}</span>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

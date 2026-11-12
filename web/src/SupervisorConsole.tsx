import Button from './components/Button';
import Input from './components/Input';
import Textarea from './components/Textarea';
import MessageContent from './components/MessageContent';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router';
import { ArrowUp, ArrowUpRight, HardHat, LoaderCircle, Wrench } from 'lucide-react';
import type { Api, OperatorMessageView, OperatorAction, WorkOrder } from './api';
import Select from './components/Select';
import './SupervisorConsole.css';

const actions: { id: OperatorAction; label: string; run: boolean }[] = [
  { id: 'submit_work', label: 'Start runs within explicitly supplied budgets', run: false },
  { id: 'control_work', label: 'Pause, resume or cancel the identified run', run: true },
  { id: 'answer_question', label: 'Submit your answer to a pending question', run: true },
  { id: 'change_scope', label: 'Change the identified run scope', run: true },
  { id: 'register_project', label: 'Register a repository with supplied checks', run: false },
];
const blockedReasons: Record<string, string> = {
  OPERATOR_INTERRUPTED: 'The worker stopped. Reconcile the retained checkpoint before resuming this message.',
  MODEL_NOT_READY: 'Connect the provider and choose a model in Config, then reconcile this message.',
  MODEL_NOT_CONFIGURED: 'Choose an explicit model in Config before resuming this message.',
  CHAT_BUSY: 'An earlier message has an incomplete checkpoint. Reconcile that message first.',
  CHAT_CONTEXT_CHANGED:
    'The conversation has advanced. Inspect its latest recorded state before sending a new instruction.',
  BUDGET_EXHAUSTED: 'The separate conversation allowance is exhausted. Review its usage and configuration.',
  OPERATOR_CONVERSATION_TIMEOUT:
    'The response reached its time limit. Its checkpoint and uncertain reservations are retained.',
};

function InternalActionLink({
  to,
  children,
  onNavigate,
}: {
  to: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const routed = useInRouterContext();
  return routed ? (
    <Link className="button small" to={to} onClick={onNavigate}>
      {children}
    </Link>
  ) : (
    <a className="button small" href={to} onClick={onNavigate}>
      {children}
    </a>
  );
}

function PendingMessage({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sent = Date.parse(createdAt);
  const seconds = Number.isFinite(sent) ? Math.max(0, Math.floor((now - sent) / 1000)) : null;
  return (
    <div className="supervisor-pending">
      <span role="status">
        <LoaderCircle size={14} aria-hidden="true" /> Processing message
      </span>
      <small aria-live="off">
        {seconds === null
          ? 'Submission time unavailable'
          : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} since sent · includes queue time`}
      </small>
    </div>
  );
}

function readinessDestination(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const action = value as { id?: string; kind?: string; target?: string };
  const routes = [
    {
      id: 'connect-github-read',
      kind: 'open_tool',
      target: 'github.read',
      to: '/tools?connection=github.read',
      label: 'Connect GitHub repositories',
    },
    {
      id: 'connect-github-publish',
      kind: 'open_tool',
      target: 'github.publish',
      to: '/tools?connection=github.publish',
      label: 'Connect GitHub deliveries',
    },
    {
      id: 'configure-models',
      kind: 'open_models',
      target: 'model',
      to: '/config?section=models',
      label: 'Choose a model',
    },
    {
      id: 'connect-provider',
      kind: 'open_models',
      target: 'model',
      to: '/config?section=provider',
      label: 'Connect model provider',
    },
    {
      id: 'add-mcp-connection',
      kind: 'open_tools',
      target: 'mcp',
      to: '/tools?setup=mcp',
      label: 'Add MCP connection',
    },
  ];
  return (
    routes.find(
      (route) => route.id === action.id && route.kind === action.kind && route.target === action.target,
    ) ?? null
  );
}

function RecordedSupervisorTools({
  api,
  message,
  onNavigate,
  observe,
}: {
  api: Api;
  message: OperatorMessageView;
  onNavigate: () => void;
  observe: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Awaited<ReturnType<Api['supervisorMessageTools']>> | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const active = message.state === 'running';
  useEffect(() => {
    if (!open && !active && !observe) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await api.supervisorMessageTools(message.id);
        if (stopped) return;
        if (result.version !== 1 || result.message_id !== message.id || !Array.isArray(result.tools))
          throw new Error(
            'Retained tool records did not match this message. Refresh before inspecting activity.',
          );
        setPage(result);
        setError('');
        if (message.state === 'queued' || message.state === 'running') timer = setTimeout(load, 2500);
      } catch (reason) {
        if (!stopped)
          setError(reason instanceof Error ? reason.message : 'Recorded tools could not be loaded.');
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, message.id, message.state, open, revision, active, observe]);
  const destinations =
    page?.available && Array.isArray(page.actions)
      ? page.actions.map(readinessDestination).filter((item) => item !== null)
      : [];
  return (
    <>
      {destinations.length > 0 && (
        <div className="supervisor-action-card" aria-label="Observed setup actions">
          <p>Continue setup</p>
          <div>
            {destinations.map((destination) => (
              <InternalActionLink key={destination.id} to={destination.to} onNavigate={onNavigate}>
                {destination.label}
                <ArrowUpRight size={13} aria-hidden="true" />
              </InternalActionLink>
            ))}
          </div>
          <small>Opens the matching factory screen. No settings are changed automatically.</small>
        </div>
      )}
      <details className="supervisor-tools" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <Wrench size={14} aria-hidden="true" />
          <span>Recorded tool invocations{page ? ` · ${page.tools.length}` : ''}</span>
          <span className="supervisor-inspect-label">Inspect</span>
          {page?.available && page.tools.length > 0 && !open && (
            <span className="supervisor-tool-peek">
              {page.tools.at(-1)!.name} · {page.tools.at(-1)!.status}
            </span>
          )}
        </summary>
        {open && (
          <>
            {error && (
              <p role="alert">
                {error}{' '}
                <Button className="button small" onClick={() => setRevision((value) => value + 1)}>
                  Retry recorded tools
                </Button>
              </p>
            )}
            {!page && !error && <p role="status">Loading retained tool records…</p>}
            {page && !page.available && (
              <p className="hint">
                No retained checkpoint is available for this message. Tool activity cannot be reconstructed.
              </p>
            )}
            {page?.available && (
              <>
                <p className="hint">
                  Recorded checkpoint · {page.checkpoint_id ?? 'Not identified'}. Refreshes while this message
                  is active.
                </p>
                {!page.tools.length && <p className="hint">No tool calls recorded for this message.</p>}
                {page.tools.map((tool) => (
                  <details className="supervisor-tool" key={tool.call_id}>
                    <summary>
                      {tool.name} · {tool.status}
                    </summary>
                    <p className="hint">Call {tool.call_id}</p>
                    <strong>Input</strong>
                    <pre>{tool.input}</pre>
                    <strong>Result</strong>
                    <pre>{tool.output ?? 'No result recorded.'}</pre>
                    {(tool.redacted || tool.truncated) && (
                      <p className="hint">
                        {tool.redacted ? 'Sensitive content redacted. ' : ''}
                        {tool.truncated ? 'Content truncated to the inspection limit.' : ''}
                      </p>
                    )}
                  </details>
                ))}
                {page.truncated && <p className="hint">Only the bounded retained tool records are shown.</p>}
              </>
            )}
          </>
        )}
      </details>
    </>
  );
}

export default function SupervisorConsole({
  api,
  orders,
  selectedId,
  disconnected,
}: {
  api: Api;
  orders: Pick<WorkOrder, 'id' | 'objective' | 'questions' | 'plan_revision' | 'status' | 'error_code'>[];
  selectedId: string | null;
  disconnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [scope, setScope] = useState('');
  const [history, setHistory] = useState<Record<string, OperatorMessageView[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [grants, setGrants] = useState<OperatorAction[]>([]);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const receiptKeys = useRef(new Map<string, string>());
  const launcher = useRef<HTMLButtonElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const historyPanel = useRef<HTMLDivElement>(null);
  const followHistory = useRef(true);
  const expansionControl = useRef<HTMLButtonElement>(null);
  const scopeChosen = useRef(false);
  useEffect(() => {
    if (open) composer.current?.focus();
  }, [open]);
  const conversation = history[scope] ?? [];
  const message = drafts[scope] ?? '';
  const responding = conversation.some((item) => item.state === 'queued' || item.state === 'running');
  const closeForNavigation = () => {
    setExpanded(false);
    setOpen(false);
  };
  useEffect(() => {
    if (followHistory.current && historyPanel.current)
      historyPanel.current.scrollTop = historyPanel.current.scrollHeight;
  }, [conversation]);
  useEffect(() => {
    if (!open || !expanded || !drawer.current) return;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    const siblings: { element: HTMLElement; inert: boolean }[] = [];
    let ancestor: HTMLElement = drawer.current;
    while (ancestor.parentElement) {
      for (const element of ancestor.parentElement.children) {
        if (element !== ancestor && element instanceof HTMLElement) {
          siblings.push({ element, inert: element.inert });
          element.inert = true;
        }
      }
      if (ancestor.parentElement === document.body) break;
      ancestor = ancestor.parentElement;
    }
    document.body.style.overflow = 'hidden';
    composer.current?.focus();
    return () => {
      for (const sibling of siblings) sibling.element.inert = sibling.inert;
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [expanded, open]);
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const page = await api.supervisorMessages(scope || null);
        if (stopped) return;
        setHistory((prior) => ({
          ...prior,
          [scope]: [
            ...new Map([...(prior[scope] ?? []), ...page.items].map((item) => [item.id, item])).values(),
          ]
            .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
            .slice(-100),
        }));
        setTruncated(page.truncated);
        setLoadError('');
      } catch (reason) {
        if (!stopped)
          setLoadError(reason instanceof Error ? reason.message : 'Supervisor history could not be loaded.');
      }
      if (!stopped) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, open, scope]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || disconnected || !message.trim()) return;
    const text = message.trim();
    const permitted = actions.filter((action) => !scope || action.run).map((action) => action.id);
    const allowed_actions = grants.filter((action) => permitted.includes(action));
    const fingerprint = JSON.stringify({ scope, text, allowed_actions });
    if (!receiptKeys.current.has(fingerprint) && receiptKeys.current.size >= 32) {
      setError('Too many unconfirmed messages. Reconcile existing submissions before sending new requests.');
      return;
    }
    const key = receiptKeys.current.get(fingerprint) ?? crypto.randomUUID();
    receiptKeys.current.set(fingerprint, key);
    setBusy(true);
    setError('');
    try {
      const reply = await api.talkSupervisor({
        version: 1,
        text,
        work_id: scope || null,
        idempotency_key: key,
        allowed_actions,
      });
      setHistory((prior) => ({
        ...prior,
        [scope]: [...(prior[scope] ?? []).filter((item) => item.id !== reply.id), reply].slice(-100),
      }));
      setDrafts((prior) => ({ ...prior, [scope]: '' }));
      receiptKeys.current.delete(fingerprint);
      setGrants([]);
    } catch (reason) {
      setError(
        `${reason instanceof Error ? reason.message : 'Message admission could not be confirmed.'} Check the conversation before retrying. The same unchanged message retains its request key.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const scopes = [...new Set([...orders.map((order) => order.id), ...(selectedId ? [selectedId] : [])])];
  const attention = orders
    .map((order) => ({
      order,
      questions: order.questions.filter(
        (question) => question.answer === null && question.plan_revision === order.plan_revision,
      ),
    }))
    .filter(({ order, questions }) => questions.length > 0 || ['blocked', 'failed'].includes(order.status));
  const chooseScope = (id: string) => {
    setScope(id);
    followHistory.current = true;
    scopeChosen.current = true;
    setGrants([]);
    setError('');
  };
  async function resume(item: OperatorMessageView) {
    if (busy || disconnected) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api.resumeSupervisorMessage(item.id, {
        version: 1,
        expected_error_code: item.error_code,
      });
      setHistory((prior) => ({
        ...prior,
        [scope]: (prior[scope] ?? []).map((message) => (message.id === updated.id ? updated : message)),
      }));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Message resumption could not be confirmed. Refresh before retrying.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        type="button"
        ref={launcher}
        className="supervisor-launcher button"
        aria-expanded={open}
        aria-controls="supervisor-conversation"
        onClick={() => {
          if (!open && !scopeChosen.current) {
            setScope(selectedId ?? '');
            scopeChosen.current = true;
          }
          setOpen(!open);
          setExpanded(false);
        }}
      >
        Supervisor <span aria-hidden="true">↗</span>
      </Button>
      {open && (
        <section
          ref={drawer}
          id="supervisor-conversation"
          className={`supervisor-drawer${expanded ? ' is-expanded' : ''}`}
          role={expanded ? 'dialog' : 'region'}
          aria-modal={expanded ? true : undefined}
          aria-label="Supervisor conversation"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              if (expanded) setExpanded(false);
              else {
                setOpen(false);
                launcher.current?.focus();
              }
            }
            if (expanded && event.key === 'Tab') {
              const controls = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button,input,textarea,select,a[href],[tabindex]',
                ),
              ).filter(
                (element) =>
                  !element.matches(':disabled,[type="hidden"]') &&
                  element.tabIndex >= 0 &&
                  element.getClientRects().length > 0,
              );
              const first = controls[0];
              const last = controls.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <div className="section-heading">
            <div className="supervisor-profile">
              <span className="supervisor-avatar" aria-hidden="true">
                <HardHat size={22} />
              </span>
              <div>
                <h2>
                  Supervisor{' '}
                  <span className="supervisor-presence" data-offline={disconnected}>
                    {disconnected ? 'Offline' : responding ? 'Working' : 'Connected'}
                  </span>
                </h2>
                <span className="eyebrow">Your factory coordination agent</span>
              </div>
            </div>
            <div className="supervisor-window-controls">
              <Button
                ref={expansionControl}
                type="button"
                className="button small"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? 'Restore chat' : 'Expand chat'}
              </Button>
              <Button
                type="button"
                className="icon-button"
                aria-label="Close supervisor"
                onClick={() => {
                  setExpanded(false);
                  setOpen(false);
                  launcher.current?.focus();
                }}
              >
                ×
              </Button>
            </div>
          </div>
          <label className="supervisor-scope">
            Conversation context
            <Select value={scope} disabled={busy} onChange={(event) => chooseScope(event.target.value)}>
              <option value="">Factory · process coordination</option>
              {scopes.map((id) => (
                <option key={id} value={id}>
                  {orders.find((order) => order.id === id)?.objective.slice(0, 65) ?? id}
                  {' · '}
                  {id.slice(-8)}
                </option>
              ))}
            </Select>
          </label>
          <details className="supervisor-context">
            <summary>Context and permissions</summary>
            <p className="hint">
              {scope
                ? 'Run-scoped supervision. Other runs are outside this conversation.'
                : 'Factory-wide coordination. Identify a run explicitly before requesting changes.'}{' '}
              Execution budgets and permissions cannot be increased through these tools.
            </p>
          </details>
          <details className="supervisor-attention">
            <summary>
              Attention inbox · {attention.length} {attention.length === 1 ? 'run' : 'runs'}
            </summary>
            <div className="supervisor-attention-list">
              {!attention.length && <p>No pending questions or blocked runs in the current run list.</p>}
              {attention.map(({ order, questions }) => (
                <article key={order.id}>
                  <strong>{order.objective}</strong>
                  <small>
                    {order.status.replaceAll('_', ' ')}
                    {order.error_code ? ` · ${order.error_code}` : ''} · {questions.length} pending{' '}
                    {questions.length === 1 ? 'question' : 'questions'}
                  </small>
                  {questions.map((question) => (
                    <p key={question.id}>{question.prompt}</p>
                  ))}
                  <Button className="button small" disabled={busy} onClick={() => chooseScope(order.id)}>
                    Discuss run · {order.id.slice(-8)}
                  </Button>
                </article>
              ))}
            </div>
            <p className="hint">
              Based on the loaded run states. Selecting a run changes chat context; it does not answer, resume
              or resolve it.
            </p>
          </details>
          {disconnected && (
            <p className="notice warning">
              Connection interrupted. Stored messages remain available when the factory reconnects.
            </p>
          )}
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {loadError && (
            <p role="alert" className="notice error">
              {loadError}
            </p>
          )}
          <div
            ref={historyPanel}
            className="supervisor-history"
            aria-label="Recorded supervisor messages"
            tabIndex={0}
            onScroll={(event) => {
              const panel = event.currentTarget;
              followHistory.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
            }}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {!conversation.length && (
              <div className="supervisor-welcome">
                <span className="supervisor-avatar" aria-hidden="true">
                  <HardHat size={28} />
                </span>
                <h3>What should we work on?</h3>
                <p>Ask about recorded progress, flag a concern or plan the next run. You stay in control.</p>
                <div className="supervisor-suggestions">
                  {['What needs my attention?', 'Summarize active runs', 'Help me plan a run'].map(
                    (prompt) => (
                      <Button
                        key={prompt}
                        className="button small"
                        onClick={() => {
                          setDrafts((prior) => ({ ...prior, [scope]: prompt }));
                          composer.current?.focus();
                        }}
                      >
                        {prompt}
                      </Button>
                    ),
                  )}
                </div>
              </div>
            )}
            {truncated && <p className="hint">Showing the latest 100 messages.</p>}
            {conversation.map((item, index) => (
              <article className="supervisor-exchange" key={item.id}>
                <div className="supervisor-owner-message">
                  <strong>You · {item.source === 'mcp' ? 'MCP' : 'Console'}</strong>
                  <time className="supervisor-message-time" dateTime={item.created_at}>
                    {new Date(item.created_at).toLocaleString()}
                  </time>
                  <p>{item.text}</p>
                  <small>
                    {item.allowed_actions.length
                      ? `Authorized tools: ${item.allowed_actions.join(', ')}`
                      : 'Read-only message'}
                  </small>
                </div>
                <div className="supervisor-reply">
                  <div className="supervisor-reply-identity">
                    <span className="supervisor-avatar" aria-hidden="true">
                      <HardHat size={17} />
                    </span>
                    <strong>
                      Supervisor{' '}
                      <span className={`supervisor-message-state state-${item.state}`}>{item.state}</span>
                    </strong>
                  </div>
                  {item.reply ? (
                    <MessageContent text={item.reply} />
                  ) : (
                    <p>
                      {item.state === 'blocked'
                        ? `Blocked · ${item.error_code ?? 'Inspect configuration before retrying'}. ${blockedReasons[item.error_code ?? ''] ?? 'Inspect the recorded outcome before resuming.'}`
                        : item.state === 'running'
                          ? 'Preparing a response…'
                          : 'Message queued. No action has been confirmed.'}
                    </p>
                  )}
                  {(item.state === 'queued' || item.state === 'running') && (
                    <PendingMessage createdAt={item.created_at} />
                  )}
                  {item.state === 'blocked' && (
                    <>
                      <Button
                        type="button"
                        className="button small"
                        disabled={busy || disconnected}
                        onClick={() => void resume(item)}
                      >
                        Reconcile and resume message
                      </Button>
                      <p className="hint">
                        Resumes this message with its original action grants. A model invocation may consume
                        the separately configured conversation budget.
                      </p>
                      {['MODEL_NOT_READY', 'MODEL_NOT_CONFIGURED', 'BUDGET_EXHAUSTED'].includes(
                        item.error_code ?? '',
                      ) && (
                        <div className="supervisor-reply-actions">
                          <InternalActionLink
                            to={
                              item.error_code === 'MODEL_NOT_CONFIGURED'
                                ? '/config?section=models'
                                : item.error_code === 'MODEL_NOT_READY'
                                  ? '/config?section=provider'
                                  : '/config'
                            }
                            onNavigate={closeForNavigation}
                          >
                            {item.error_code === 'BUDGET_EXHAUSTED'
                              ? 'Review conversation configuration'
                              : item.error_code === 'MODEL_NOT_CONFIGURED'
                                ? 'Choose a model'
                                : 'Connect model provider'}
                            <ArrowUpRight size={13} aria-hidden="true" />
                          </InternalActionLink>
                        </div>
                      )}
                    </>
                  )}
                  {item.work_id && (
                    <div className="supervisor-reply-actions">
                      <InternalActionLink
                        to={`/work/${encodeURIComponent(item.work_id)}`}
                        onNavigate={closeForNavigation}
                      >
                        Open run <ArrowUpRight size={13} aria-hidden="true" />
                      </InternalActionLink>
                    </div>
                  )}
                  <RecordedSupervisorTools
                    api={api}
                    message={item}
                    onNavigate={closeForNavigation}
                    observe={index === conversation.length - 1}
                  />
                </div>
              </article>
            ))}
          </div>
          <form className="supervisor-composer" onSubmit={(event) => void send(event)}>
            <label className="supervisor-compose">
              Message
              <Textarea
                ref={composer}
                rows={3}
                maxLength={12000}
                required
                value={message}
                disabled={busy}
                onChange={(event) => setDrafts((prior) => ({ ...prior, [scope]: event.target.value }))}
                placeholder="Watch out: preserve the existing public API…"
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    if (!busy && !disconnected && message.trim()) event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </label>
            <details className="supervisor-grants">
              <summary>
                Allow actions for this message{' '}
                <span className="muted">· {grants.length ? `${grants.length} authorized` : 'Read-only'}</span>
              </summary>
              <p>
                Read-only by default. Select only the actions you authorize; the Supervisor must still follow
                policy.
              </p>
              {actions
                .filter((action) => !scope || action.run)
                .map((action) => (
                  <label key={action.id}>
                    <Input
                      type="checkbox"
                      disabled={busy}
                      checked={grants.includes(action.id)}
                      onChange={(event) =>
                        setGrants((prior) =>
                          event.target.checked
                            ? [...prior, action.id]
                            : prior.filter((id) => id !== action.id),
                        )
                      }
                    />
                    {action.label}
                  </label>
                ))}
            </details>
            <div className="supervisor-sendbar">
              <small>
                {grants.length ? `${grants.length} actions authorized` : 'Read-only by default'} · Ctrl / ⌘ +
                Enter
              </small>
              <Button
                type="submit"
                className="button primary"
                data-submitting={busy}
                disabled={busy || disconnected || !message.trim()}
              >
                {busy ? (
                  <LoaderCircle size={15} aria-hidden="true" />
                ) : (
                  <ArrowUp size={15} aria-hidden="true" />
                )}
                {busy ? 'Submitting…' : 'Send message'}
              </Button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}

import Button from './components/Button';
import Textarea from './components/Textarea';
import MessageContent from './components/MessageContent';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery, WIDE_SCREEN } from './lib/useMediaQuery';
import { Link, useInRouterContext } from 'react-router';
import { ArrowUp, ArrowUpRight, LoaderCircle, Wrench, X } from 'lucide-react';
import SupervisorAvatar from './features/supervisor/SupervisorAvatar';
import { DOCK_MAX, DOCK_MIN, useSupervisorDock } from './features/supervisor/dock';
import './features/supervisor/dock.css';
import Disclosure from './components/Disclosure';
import Notice from './components/Notice';
import CheckField from './components/CheckField';
import { Eyebrow } from './components/PageHeader';
import { buttonVariants } from './components/ui/button';
import { cn } from './lib/utils';
import {
  DONE_WINDOW_MS,
  presenceFor,
  presenceLabels,
  useStablePresence,
  type Presence,
} from './features/supervisor/presence';
import type { Api, OperatorMessageView, OperatorAction, WorkOrder } from './api';
import Select from './components/Select';
import { pendingQuestions } from './runState';

const noMessages: OperatorMessageView[] = [];

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

const presenceTones: Partial<Record<Presence, string>> = {
  offline: 'border-danger-border bg-danger-bg text-danger',
  blocked: 'border-danger-border bg-danger-bg text-danger',
  working: 'border-info-border bg-info-bg text-info',
  'using-tool': 'border-info-border bg-info-bg text-info',
  queued: 'border-neutral-border bg-neutral-bg text-neutral',
  'needs-you': 'border-warning-border bg-warning-bg text-warning',
  done: 'border-success-border bg-success-bg text-success',
  listening: 'border-primary/50 bg-accent text-primary',
};
const messageTones: Record<string, string> = {
  queued: 'border-neutral-border bg-neutral-bg text-neutral',
  running: 'border-info-border bg-info-bg text-info',
  completed: 'border-success-border bg-success-bg text-success',
  blocked: 'border-danger-border bg-danger-bg text-danger',
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
  const className = buttonVariants({ size: 'sm' });
  return routed ? (
    <Link className={className} to={to} onClick={onNavigate}>
      {children}
    </Link>
  ) : (
    <a className={className} href={to} onClick={onNavigate}>
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
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span role="status" className="flex items-center gap-1.5 text-info">
        <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{' '}
        Processing message
      </span>
      <small aria-live="off" className="text-xs tabular-nums">
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
  onActiveTool,
}: {
  api: Api;
  message: OperatorMessageView;
  onNavigate: () => void;
  observe: boolean;
  /** Receives the name of the tool this message is running now, or null. */
  onActiveTool?: (name: string | null) => void;
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
  // Report the tool this message is using right now, for the Supervisor's presence.
  const pendingTool = active
    ? (page?.tools.findLast((tool) => tool.status === 'pending')?.name ?? null)
    : null;
  useEffect(() => {
    onActiveTool?.(pendingTool);
  }, [onActiveTool, pendingTool]);
  useEffect(() => () => onActiveTool?.(null), [onActiveTool]);
  return (
    <>
      {destinations.length > 0 && (
        <div
          aria-label="Observed setup actions"
          className="grid gap-2 rounded-lg border border-primary/40 bg-accent/60 p-3"
        >
          <p className="text-sm font-medium">Continue setup</p>
          <div className="flex flex-wrap gap-2">
            {destinations.map((destination) => (
              <InternalActionLink key={destination.id} to={destination.to} onNavigate={onNavigate}>
                {destination.label}
                <ArrowUpRight size={13} aria-hidden="true" />
              </InternalActionLink>
            ))}
          </div>
          <small className="text-xs text-muted-foreground">
            Opens the matching factory screen. No settings are changed automatically.
          </small>
        </div>
      )}
      <details
        data-testid="supervisor-tools"
        className="group/tools rounded-lg border border-border bg-code text-xs"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex min-h-9 cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <Wrench size={14} aria-hidden="true" className="text-muted-foreground" />
          <span>Recorded tool invocations{page ? ` · ${page.tools.length}` : ''}</span>
          <span className="ml-auto text-link group-open/tools:hidden">Inspect</span>
          {page?.available && page.tools.length > 0 && !open && (
            <span className="basis-full truncate font-mono text-muted-foreground">
              {page.tools.at(-1)!.name} · {page.tools.at(-1)!.status}
            </span>
          )}
        </summary>
        {open && (
          <div className="grid gap-2 px-3 pb-3">
            {error && (
              <p role="alert" className="flex flex-wrap items-center gap-2 text-danger">
                {error}{' '}
                <Button type="button" size="sm" onClick={() => setRevision((value) => value + 1)}>
                  Retry recorded tools
                </Button>
              </p>
            )}
            {!page && !error && (
              <p role="status" className="text-muted-foreground">
                Loading retained tool records…
              </p>
            )}
            {page && !page.available && (
              <p className="text-muted-foreground">
                No retained checkpoint is available for this message. Tool activity cannot be reconstructed.
              </p>
            )}
            {page?.available && (
              <>
                <p className="text-muted-foreground">
                  Recorded checkpoint · {page.checkpoint_id ?? 'Not identified'}. Refreshes while this message
                  is active.
                </p>
                {!page.tools.length && (
                  <p className="text-muted-foreground">No tool calls recorded for this message.</p>
                )}
                {page.tools.map((tool) => (
                  <details
                    key={tool.call_id}
                    data-testid="supervisor-tool"
                    className="rounded-md border border-border bg-background/50"
                  >
                    <summary className="cursor-pointer px-3 py-2 font-mono">
                      {tool.name} · {tool.status}
                    </summary>
                    <div className="grid gap-1.5 px-3 pb-3">
                      <p className="text-muted-foreground">Call {tool.call_id}</p>
                      <strong className="font-medium">Input</strong>
                      <pre className="max-h-48 overflow-auto rounded-sm bg-code p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {tool.input}
                      </pre>
                      <strong className="font-medium">Result</strong>
                      <pre className="max-h-48 overflow-auto rounded-sm bg-code p-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {tool.output ?? 'No result recorded.'}
                      </pre>
                      {(tool.redacted || tool.truncated) && (
                        <p className="text-muted-foreground">
                          {tool.redacted ? 'Sensitive content redacted. ' : ''}
                          {tool.truncated ? 'Content truncated to the inspection limit.' : ''}
                        </p>
                      )}
                    </div>
                  </details>
                ))}
                {page.truncated && (
                  <p className="text-muted-foreground">Only the bounded retained tool records are shown.</p>
                )}
              </>
            )}
          </div>
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
  headerSlot = null,
}: {
  api: Api;
  orders: Pick<WorkOrder, 'id' | 'objective' | 'questions' | 'plan_revision' | 'status' | 'error_code'>[];
  selectedId: string | null;
  disconnected: boolean;
  /** Header element for the launcher on wide screens, so it never floats over content. */
  headerSlot?: HTMLElement | null;
}) {
  const wide = useMediaQuery(WIDE_SCREEN);
  const inHeader = wide && headerSlot !== null;
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
  const dock = useSupervisorDock(open && !expanded);
  useEffect(() => {
    if (open) composer.current?.focus();
  }, [open]);
  const conversation = useMemo(() => history[scope] ?? noMessages, [history, scope]);
  const message = drafts[scope] ?? '';
  const [justReplied, setJustReplied] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const pendingIds = useRef(new Set<string>());
  const repliedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(repliedTimer.current), []);
  /** Marks a reply that settled while the owner watched; shown briefly as "Replied". */
  const noteSettled = (items: OperatorMessageView[]) => {
    let settled = false;
    for (const item of items) {
      if (item.state === 'queued' || item.state === 'running') pendingIds.current.add(item.id);
      else if (pendingIds.current.delete(item.id) && item.state === 'completed') settled = true;
    }
    if (!settled) return;
    setJustReplied(true);
    clearTimeout(repliedTimer.current);
    repliedTimer.current = setTimeout(() => setJustReplied(false), DONE_WINDOW_MS);
  };
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
        noteSettled(page.items);
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
    .map((order) => ({ order, questions: pendingQuestions(order) }))
    .filter(({ order, questions }) => questions.length > 0 || ['blocked', 'failed'].includes(order.status));
  const presence = useStablePresence(
    presenceFor({
      disconnected,
      messages: conversation,
      attention: attention.length,
      drafting: open && message.trim().length > 0,
      settledAgoMs: justReplied ? 0 : null,
      activeTool,
    }),
  );
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
  const docked = open && !expanded;
  const launcherButton = (
    <Button
      type="button"
      ref={launcher}
      variant="secondary"
      className={cn(
        inHeader
          ? 'h-9 gap-2 rounded-full border-primary/50 bg-accent pr-3.5 pl-1 text-sm aria-expanded:border-primary'
          : 'fixed right-4 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-40 h-12 gap-2.5 rounded-full border-primary/60 bg-accent pr-4 pl-2 shadow-xl lg:right-6 lg:bottom-6',
        docked && !inHeader && 'lg:hidden',
      )}
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
      <SupervisorAvatar presence={presence} size={inHeader ? 28 : 32} />
      Supervisor
      {attention.length > 0 && (
        <span
          className="min-w-5 rounded-full bg-primary px-1.5 text-center text-xs leading-5 font-semibold text-primary-foreground"
          aria-hidden="true"
        >
          {attention.length}
        </span>
      )}
    </Button>
  );
  return (
    <>
      {inHeader && headerSlot ? createPortal(launcherButton, headerSlot) : launcherButton}
      {open && (
        <section
          ref={drawer}
          id="supervisor-conversation"
          data-expanded={expanded || undefined}
          className={cn(
            'fixed inset-2 z-50 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card/95 px-3 shadow-2xl backdrop-blur-xl sm:px-5',
            !expanded &&
              'lg:inset-auto lg:top-[4.75rem] lg:right-5 lg:bottom-20 lg:w-[38.75rem] lg:max-w-[calc(100vw-2rem)]',
            expanded && 'sm:inset-4 z-[90] bg-card',
            docked &&
              'lg:top-0 lg:right-0 lg:bottom-0 lg:z-[35] lg:w-[var(--supervisor-dock-width,440px)] lg:max-w-none lg:rounded-none lg:border-y-0 lg:border-r-0 lg:bg-card lg:shadow-none lg:backdrop-blur-none',
          )}
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
          {!expanded && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize supervisor panel"
              aria-valuemin={DOCK_MIN}
              aria-valuemax={DOCK_MAX}
              aria-valuenow={dock.width}
              tabIndex={0}
              onPointerDown={dock.startResize}
              onKeyDown={dock.resizeWithKeys}
              className="group absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize touch-none lg:block"
            >
              <span className="absolute top-1/2 left-[3px] h-10 w-0.5 -translate-y-1/2 rounded-full bg-input opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </div>
          )}
          <div className="flex shrink-0 items-center justify-between gap-2.5 pt-3 pb-3 sm:pt-4">
            <div className="flex min-w-0 items-center gap-3">
              <SupervisorAvatar presence={presence} size={44} labelled />
              <div className="grid min-w-0 gap-0.5">
                <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                  Supervisor{' '}
                  <span
                    data-offline={disconnected}
                    data-presence={presence}
                    role="status"
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-xs font-medium',
                      presenceTones[presence] ?? 'border-border text-muted-foreground',
                    )}
                  >
                    {presenceLabels[presence]}
                    {presence === 'using-tool' && activeTool ? ` · ${activeTool}` : ''}
                  </span>
                </h2>
                <Eyebrow className="hidden normal-case sm:block">Your factory coordination agent</Eyebrow>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                ref={expansionControl}
                type="button"
                size="sm"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? 'Restore chat' : 'Expand chat'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close supervisor"
                onClick={() => {
                  setExpanded(false);
                  setOpen(false);
                  launcher.current?.focus();
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          </div>
          <label className="mb-1.5 grid shrink-0 gap-1.5 text-xs font-medium text-muted-foreground">
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
          <div className="grid shrink-0 gap-0.5 border-b border-border pb-2">
            <Disclosure variant="plain" summary="Context and permissions" className="text-xs">
              <p className="text-xs text-muted-foreground">
                {scope
                  ? 'Run-scoped supervision. Other runs are outside this conversation.'
                  : 'Factory-wide coordination. Identify a run explicitly before requesting changes.'}{' '}
                Execution budgets and permissions cannot be increased through these tools.
              </p>
            </Disclosure>
            <Disclosure
              variant="plain"
              className="text-xs"
              summary={`Attention inbox · ${attention.length} ${attention.length === 1 ? 'run' : 'runs'}`}
            >
              <div className="grid max-h-56 gap-2 overflow-auto">
                {!attention.length && (
                  <p className="text-xs text-muted-foreground">
                    No pending questions or blocked runs in the current run list.
                  </p>
                )}
                {attention.map(({ order, questions }) => (
                  <article key={order.id} className="grid gap-1 rounded-md border border-border bg-code p-3">
                    <strong className="text-sm font-medium">{order.objective}</strong>
                    <small className="text-xs text-muted-foreground">
                      {order.status.replaceAll('_', ' ')}
                      {order.error_code ? ` · ${order.error_code}` : ''} · {questions.length} pending{' '}
                      {questions.length === 1 ? 'question' : 'questions'}
                    </small>
                    {questions.map((question) => (
                      <p key={question.id} className="text-sm">
                        {question.prompt}
                      </p>
                    ))}
                    <Button
                      type="button"
                      size="sm"
                      className="justify-self-start"
                      disabled={busy}
                      onClick={() => chooseScope(order.id)}
                    >
                      Discuss run · {order.id.slice(-8)}
                    </Button>
                  </article>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Based on the loaded run states. Selecting a run changes chat context; it does not answer,
                resume or resolve it.
              </p>
            </Disclosure>
          </div>
          {disconnected && (
            <Notice tone="warning" className="mt-2 max-h-24 shrink-0 overflow-auto text-xs">
              Connection interrupted. Stored messages remain available when the factory reconnects.
            </Notice>
          )}
          {error && (
            <Notice tone="danger" role="alert" className="mt-2 max-h-24 shrink-0 overflow-auto text-xs">
              {error}
            </Notice>
          )}
          {loadError && (
            <Notice tone="danger" role="alert" className="mt-2 max-h-24 shrink-0 overflow-auto text-xs">
              {loadError}
            </Notice>
          )}
          <div
            ref={historyPanel}
            className="min-h-20 flex-1 overflow-auto overscroll-contain py-4 pr-1.5 [scrollbar-gutter:stable] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
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
              <div className="flex min-h-full flex-col items-center justify-center gap-3 px-3 py-6 text-center">
                <SupervisorAvatar presence={presence} size={64} />
                <h3 className="text-xl font-medium tracking-tight">What should we work on?</h3>
                <p className="max-w-90 text-sm text-muted-foreground">
                  Ask about recorded progress, flag a concern or plan the next run. You stay in control.
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {['What needs my attention?', 'Summarize active runs', 'Help me plan a run'].map(
                    (prompt) => (
                      <Button
                        key={prompt}
                        type="button"
                        size="sm"
                        variant="outline"
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
            {truncated && (
              <p className="mb-3 text-xs text-muted-foreground">Showing the latest 100 messages.</p>
            )}
            {conversation.map((item, index) => (
              <article key={item.id} className="mx-auto mb-6 grid max-w-[55rem] gap-3">
                <div className="ml-6 grid gap-1 justify-self-end rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3 sm:ml-14">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                    <strong className="font-medium">You · {item.source === 'mcp' ? 'MCP' : 'Console'}</strong>
                    <time className="text-muted-foreground" dateTime={item.created_at}>
                      {new Date(item.created_at).toLocaleString()}
                    </time>
                  </div>
                  <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</p>
                  <small className="text-xs text-muted-foreground">
                    {item.allowed_actions.length
                      ? `Authorized tools: ${item.allowed_actions.join(', ')}`
                      : 'Read-only message'}
                  </small>
                </div>
                <div className="grid min-w-0 gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <SupervisorAvatar
                      presence={
                        item.state === 'running'
                          ? 'working'
                          : item.state === 'queued'
                            ? 'queued'
                            : item.state === 'blocked'
                              ? 'blocked'
                              : 'idle'
                      }
                      size={24}
                    />
                    <strong className="flex items-center gap-2 text-sm font-semibold">
                      Supervisor{' '}
                      <span
                        data-state={item.state}
                        className={cn(
                          'rounded-full border px-2 py-0.5 text-xs font-medium',
                          messageTones[item.state] ?? 'border-border text-muted-foreground',
                        )}
                      >
                        {item.state}
                      </span>
                    </strong>
                  </div>
                  {item.reply ? (
                    <MessageContent text={item.reply} />
                  ) : (
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
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
                        size="sm"
                        className="justify-self-start"
                        disabled={busy || disconnected}
                        onClick={() => void resume(item)}
                      >
                        Reconcile and resume message
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        Resumes this message with its original action grants. A model invocation may consume
                        the separately configured conversation budget.
                      </p>
                      {['MODEL_NOT_READY', 'MODEL_NOT_CONFIGURED', 'BUDGET_EXHAUSTED'].includes(
                        item.error_code ?? '',
                      ) && (
                        <div className="flex flex-wrap gap-2">
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
                    <div className="flex flex-wrap gap-2">
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
                    onActiveTool={index === conversation.length - 1 ? setActiveTool : undefined}
                  />
                </div>
              </article>
            ))}
          </div>
          <form
            className="grid shrink-0 gap-2 border-t border-border py-3"
            onSubmit={(event) => void send(event)}
          >
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Message
              <Textarea
                ref={composer}
                rows={3}
                maxLength={12000}
                required
                value={message}
                disabled={busy}
                className="max-h-56 field-sizing-content resize-none text-foreground"
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
            <Disclosure
              variant="plain"
              className="text-xs"
              summary={
                <>
                  Allow actions for this message{' '}
                  <span className="text-muted-foreground">
                    · {grants.length ? `${grants.length} authorized` : 'Read-only'}
                  </span>
                </>
              }
            >
              <p className="text-xs text-muted-foreground">
                Read-only by default. Select only the actions you authorize; the Supervisor must still follow
                policy.
              </p>
              {actions
                .filter((action) => !scope || action.run)
                .map((action) => (
                  <CheckField
                    key={action.id}
                    disabled={busy}
                    checked={grants.includes(action.id)}
                    onChange={(event) =>
                      setGrants((prior) =>
                        event.target.checked ? [...prior, action.id] : prior.filter((id) => id !== action.id),
                      )
                    }
                    label={action.label}
                  />
                ))}
            </Disclosure>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <small className="text-xs text-muted-foreground">
                {grants.length ? `${grants.length} actions authorized` : 'Read-only by default'} · Ctrl / ⌘ +
                Enter
              </small>
              <Button
                type="submit"
                variant="primary"
                data-submitting={busy}
                disabled={busy || disconnected || !message.trim()}
              >
                {busy ? (
                  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                ) : (
                  <ArrowUp aria-hidden="true" />
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

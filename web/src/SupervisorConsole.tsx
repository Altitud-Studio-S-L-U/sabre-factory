import { useEffect, useRef, useState, type FormEvent } from 'react';
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

export default function SupervisorConsole({
  api,
  orders,
  selectedId,
  disconnected,
}: {
  api: Api;
  orders: WorkOrder[];
  selectedId: string | null;
  disconnected: boolean;
}) {
  const [open, setOpen] = useState(false);
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
  const scopeChosen = useRef(false);
  useEffect(() => {
    if (open) composer.current?.focus();
  }, [open]);
  const conversation = history[scope] ?? [];
  const message = drafts[scope] ?? '';
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
      <button
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
        }}
      >
        Supervisor <span aria-hidden="true">↗</span>
      </button>
      {open && (
        <section
          id="supervisor-conversation"
          className="supervisor-drawer"
          aria-label="Supervisor conversation"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              launcher.current?.focus();
            }
          }}
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">Authenticated owner</span>
              <h2>Supervisor</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close supervisor"
              onClick={() => {
                setOpen(false);
                launcher.current?.focus();
              }}
            >
              ×
            </button>
          </div>
          <label className="supervisor-scope">
            Conversation context
            <Select
              value={scope}
              disabled={busy}
              onChange={(event) => {
                setScope(event.target.value);
                scopeChosen.current = true;
                setGrants([]);
                setError('');
              }}
            >
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
          <div className="supervisor-history" aria-live="polite" aria-relevant="additions text">
            {!conversation.length && (
              <p>
                No messages yet. Ask about recorded progress, flag a concern or discuss the process. The
                worker replies independently of run execution.
              </p>
            )}
            {truncated && <p className="hint">Showing the latest 100 messages.</p>}
            {conversation.map((item) => (
              <article className="supervisor-exchange" key={item.id}>
                <strong>Operator · {item.source === 'mcp' ? 'MCP' : 'Console'}</strong>
                <time className="supervisor-message-time" dateTime={item.created_at}>
                  {new Date(item.created_at).toLocaleString()}
                </time>
                <p>{item.text}</p>
                <small>
                  {item.allowed_actions.length
                    ? `Authorized tools: ${item.allowed_actions.join(', ')}`
                    : 'Read-only message'}
                </small>
                <div className="supervisor-reply">
                  <strong>Supervisor</strong>
                  {item.reply ? (
                    <p>{item.reply}</p>
                  ) : (
                    <p>
                      {item.state === 'blocked'
                        ? `Blocked · ${item.error_code ?? 'Inspect configuration before retrying'}. ${blockedReasons[item.error_code ?? ''] ?? 'Inspect the recorded outcome before resuming.'}`
                        : item.state === 'running'
                          ? 'Preparing a response…'
                          : 'Message queued. No action has been confirmed.'}
                    </p>
                  )}
                  {item.state === 'blocked' && (
                    <>
                      <button
                        type="button"
                        className="button small"
                        disabled={busy || disconnected}
                        onClick={() => void resume(item)}
                      >
                        Reconcile and resume message
                      </button>
                      <p className="hint">
                        Resumes this message with its original action grants. A model invocation may consume
                        the separately configured conversation budget.
                      </p>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
          <form onSubmit={(event) => void send(event)}>
            <label className="supervisor-compose">
              Message
              <textarea
                ref={composer}
                rows={3}
                maxLength={12000}
                required
                value={message}
                disabled={busy}
                onChange={(event) => setDrafts((prior) => ({ ...prior, [scope]: event.target.value }))}
                placeholder="Watch out: preserve the existing public API…"
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
                    <input
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
            <button
              type="submit"
              className="button primary"
              disabled={busy || disconnected || !message.trim()}
            >
              {busy ? 'Submitting…' : 'Send message'}
            </button>
          </form>
        </section>
      )}
    </>
  );
}

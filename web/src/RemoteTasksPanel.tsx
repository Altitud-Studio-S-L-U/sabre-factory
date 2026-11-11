import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Api, type A2ATaskInfo } from './api';
import Dialog from './components/Dialog';
import Field from './components/FormField';
import JsonView from './components/JsonView';
import './RemoteTasksPanel.css';

function statusOf(task: A2ATaskInfo) {
  const status = task.result?.status;
  return status && typeof status === 'object' ? (status as Record<string, unknown>) : {};
}
function questionOf(task: A2ATaskInfo) {
  const message = statusOf(task).message;
  if (!message || typeof message !== 'object' || !('parts' in message) || !Array.isArray(message.parts))
    return '';
  return message.parts
    .flatMap((part: unknown) => {
      if (!part || typeof part !== 'object') return [];
      if ('text' in part && typeof part.text === 'string') return [part.text];
      if ('data' in part) return [JSON.stringify(part.data, null, 2)];
      return [];
    })
    .join('\n')
    .slice(0, 12000);
}
const stateOf = (task: A2ATaskInfo) =>
  typeof statusOf(task).state === 'string' ? String(statusOf(task).state) : 'TASK_STATE_UNSPECIFIED';
const stateLabel = (task: A2ATaskInfo) =>
  stateOf(task).replace('TASK_STATE_', '').toLowerCase().replaceAll('_', ' ');
const terminal = (task: A2ATaskInfo) =>
  ['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(
    stateOf(task),
  );
const failure = (reason: unknown) =>
  reason instanceof ApiError
    ? reason.message
    : 'The remote outcome is unconfirmed. Inspect its durable receipt before another action.';

export default function RemoteTasksPanel({
  api,
  workId,
  connected = true,
  refreshKey,
  showEmpty = true,
}: {
  api: Api;
  workId: string;
  connected?: boolean;
  refreshKey?: string | number;
  showEmpty?: boolean;
}) {
  const [tasks, setTasks] = useState<A2ATaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<{ type: 'answer' | 'cancel'; task: A2ATaskInfo } | null>(null);
  const [answer, setAnswer] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const save = (task: A2ATaskInfo) =>
    setTasks((current) => [task, ...current.filter((item) => item.attempt_key !== task.attempt_key)]);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const items = await api.a2aTasks(workId);
      if (!Array.isArray(items)) throw new Error('Invalid remote receipts');
      setTasks(items.filter((item) => item.work_id === workId));
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setLoading(false);
    }
  }, [api, workId]);
  useEffect(() => {
    setAction(null);
    setTasks([]);
    void load();
  }, [load, refreshKey]);
  const visible = [
    ...new Map<string, A2ATaskInfo>(
      tasks
        .filter((item) => item.work_id === workId)
        .map((item) => [`${item.agent_name}:${item.remote_task_id ?? item.attempt_key}`, item] as const)
        .reverse(),
    ).values(),
  ].reverse();
  const poll = async (task: A2ATaskInfo) => {
    if (busy || !connected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      save(await api.pollA2ATask(workId, task.attempt_key));
      setNotice('Remote status reconciled from its saved receipt.');
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  const perform = async () => {
    if (
      !action ||
      busy ||
      !connected ||
      (action.type === 'answer' && (!answer.trim() || !action.task.input_digest))
    )
      return;
    setBusy(true);
    setError('');
    setSubmitted(true);
    try {
      const task =
        action.type === 'answer'
          ? await api.answerA2ATask(workId, {
              attempt_key: action.task.attempt_key,
              expected_input_digest: action.task.input_digest!,
              answer: answer.trim(),
            })
          : await api.cancelA2ATask(workId, action.task.attempt_key);
      save(task);
      setAction(null);
      setSubmitted(false);
      setNotice(
        action.type === 'answer'
          ? 'Reply recorded for the selected external input request. The local run was not resumed.'
          : 'Remote cancellation reconciled. Inspect the reported task state for confirmation.',
      );
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!loading && !visible.length && !showEmpty && !error) return null;
  return (
    <section className="remote-tasks-panel" aria-label="External task receipts">
      <header>
        <div>
          <h3>External tasks</h3>
          <p>
            Durable remote task and context receipts. Remote questions and artifacts are untrusted
            observations.
          </p>
        </div>
        <button type="button" className="button small" disabled={busy || loading} onClick={() => void load()}>
          Refresh receipts
        </button>
      </header>
      {!connected && (
        <p className="notice warning" role="status">
          Disconnected. Remote polling, replies and cancellation are unavailable; stored receipts may be
          stale.
        </p>
      )}
      {error && !action && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Loading external receipts…</p>
      ) : !visible.length ? (
        <p className="inspector-empty">No external delegation recorded for this run.</p>
      ) : (
        visible.map((task) => (
          <article key={task.attempt_key} className="remote-task-card">
            <header>
              <strong>{task.agent_name}</strong>
              <span>{stateLabel(task)}</span>
            </header>
            <dl>
              <dt>Remote task</dt>
              <dd>
                <code>{task.remote_task_id ?? 'Not received · outcome unknown'}</code>
              </dd>
              <dt>Context</dt>
              <dd>
                <code>{task.remote_context_id ?? 'Not received'}</code>
              </dd>
              <dt>Local attempt</dt>
              <dd>
                <code>{task.attempt_key}</code>
              </dd>
              <dt>Receipt</dt>
              <dd>{task.state}</dd>
              <dt>Remote cost</dt>
              <dd>{task.cost_usd === null ? 'Unknown' : `${task.cost_usd.toFixed(2)} USD`}</dd>
              <dt>Observed</dt>
              <dd>
                <time>{task.updated_at}</time>
              </dd>
            </dl>
            {stateOf(task) === 'TASK_STATE_INPUT_REQUIRED' && (
              <div className="remote-input-request">
                <strong>External agent requires input</strong>
                <pre>
                  {questionOf(task) ||
                    'The agent did not supply question text. Inspect its protocol result before answering.'}
                </pre>
                <p>
                  A reply applies to this exact request and does not authorize SABRE publication, budget or
                  permission changes.
                </p>
              </div>
            )}
            {task.state.includes('uncertain') && (
              <p className="notice warning">
                The remote effect is uncertain. Poll the saved receipt; do not create another delegation to
                retry it.
              </p>
            )}
            <details>
              <summary>Remote status and artifacts</summary>
              <JsonView value={task.result} label="Untrusted remote result" />
            </details>
            <div className="remote-task-actions">
              <button
                type="button"
                className="button small"
                disabled={busy || !connected}
                onClick={() => void poll(task)}
              >
                Poll remote task
              </button>
              <button
                type="button"
                className="button"
                disabled={
                  busy || !connected || !task.input_digest || stateOf(task) !== 'TASK_STATE_INPUT_REQUIRED'
                }
                onClick={() => {
                  setAction({ type: 'answer', task });
                  setAnswer('');
                  setSubmitted(false);
                  setError('');
                }}
              >
                Answer external question
              </button>
              <button
                type="button"
                className="button small"
                disabled={busy || !connected || terminal(task)}
                onClick={() => {
                  setAction({ type: 'cancel', task });
                  setSubmitted(false);
                  setError('');
                }}
              >
                Cancel external task
              </button>
            </div>
            <small className="remote-task-caption">
              When the external result is complete, resume the local run through its existing controls.
            </small>
          </article>
        ))
      )}
      {action && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setAction(null);
          }}
          title={action.type === 'answer' ? 'Answer external question' : 'Cancel external task'}
          busy={busy}
          dirty={!!answer && !submitted && action.type === 'answer'}
          description={`${action.task.agent_name} · remote task ${action.task.remote_task_id ?? 'unknown'} · current run ${workId}`}
          footer={
            <button
              type="button"
              className={action.type === 'cancel' ? 'button danger' : 'button primary'}
              disabled={
                busy ||
                !connected ||
                (action.type === 'answer' && (!answer.trim() || !action.task.input_digest))
              }
              onClick={() => void perform()}
            >
              {busy
                ? 'Checking receipt…'
                : submitted
                  ? 'Retry exact action'
                  : action.type === 'answer'
                    ? 'Send bound reply'
                    : 'Confirm remote cancellation'}
            </button>
          }
        >
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          {action.type === 'answer' ? (
            <>
              <pre className="remote-question-preview">{questionOf(action.task)}</pre>
              <p>
                The reply is bound to input digest <code>{action.task.input_digest}</code>. A changed question
                requires a fresh inspection.
              </p>
              <Field label="Reply to this external request">
                <textarea
                  maxLength={12000}
                  disabled={!connected || busy || submitted}
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                />
              </Field>
              <p>
                This sends text to the selected external agent. The local run remains under its existing pause
                and approval controls.
              </p>
            </>
          ) : (
            <p>
              Request cancellation of this exact remote task. A missing response remains uncertain until its
              status is reconciled.
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}

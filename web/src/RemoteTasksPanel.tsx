import { useEffect, useState } from 'react';
import { ApiError, type Api, type A2ATaskInfo } from './api';
import Button from './components/Button';
import CodeBlock from './components/CodeBlock';
import DescriptionList from './components/DescriptionList';
import Dialog from './components/Dialog';
import Disclosure from './components/Disclosure';
import Field from './components/FormField';
import JsonView from './components/JsonView';
import LoadingState from './components/LoadingState';
import Notice from './components/Notice';
import { SectionHeading } from './components/PageHeader';
import Textarea from './components/Textarea';
import { Badge } from './components/ui/badge';
import { Card } from './components/ui/card';

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
async function receipts(api: Api, workId: string) {
  const items = await api.a2aTasks(workId);
  if (!Array.isArray(items)) throw new Error('Invalid remote receipts');
  return items.filter((item) => item.work_id === workId);
}
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
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setTasks(await receipts(api, workId));
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setLoading(false);
    }
  };
  // A different run, client or refresh key starts from an empty list before its receipts load.
  const [source, setSource] = useState({ api, workId, refreshKey });
  if (source.api !== api || source.workId !== workId || source.refreshKey !== refreshKey) {
    setSource({ api, workId, refreshKey });
    setAction(null);
    setTasks([]);
    setLoading(true);
    setError('');
  }
  useEffect(() => {
    let live = true;
    receipts(api, workId)
      .then((items) => {
        if (live) setTasks(items);
      })
      .catch((reason) => {
        if (live) setError(failure(reason));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, workId, refreshKey]);
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
    <Card className="gap-4" aria-label="External task receipts">
      <SectionHeading
        className="items-start [&>:first-child]:flex-1 [&>:first-child]:basis-72"
        as="h3"
        title="External tasks"
        description="Durable remote task and context receipts. Remote questions and artifacts are untrusted observations."
        actions={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            Refresh receipts
          </Button>
        }
      />
      {!connected && (
        <Notice tone="warning" role="status">
          Disconnected. Remote polling, replies and cancellation are unavailable; stored receipts may be
          stale.
        </Notice>
      )}
      {error && !action && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {notice && (
        <Notice tone="neutral" role="status">
          {notice}
        </Notice>
      )}
      {loading ? (
        <LoadingState label="Loading external receipts…" />
      ) : !visible.length ? (
        <p className="text-sm text-muted-foreground">No external delegation recorded for this run.</p>
      ) : (
        visible.map((task) => (
          <article
            key={task.attempt_key}
            className="grid min-w-0 gap-4 rounded-lg border border-border bg-secondary/40 p-4"
          >
            <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <strong className="text-sm font-semibold [overflow-wrap:anywhere]">{task.agent_name}</strong>
              <Badge variant="outline" className="capitalize">
                {stateLabel(task)}
              </Badge>
            </header>
            <DescriptionList
              termWidth="7.5rem"
              items={[
                [
                  'Remote task',
                  <code key="task" className="font-mono text-xs">
                    {task.remote_task_id ?? 'Not received · outcome unknown'}
                  </code>,
                ],
                [
                  'Context',
                  <code key="context" className="font-mono text-xs">
                    {task.remote_context_id ?? 'Not received'}
                  </code>,
                ],
                [
                  'Local attempt',
                  <code key="attempt" className="font-mono text-xs">
                    {task.attempt_key}
                  </code>,
                ],
                ['Receipt', task.state],
                ['Remote cost', task.cost_usd === null ? 'Unknown' : `${task.cost_usd.toFixed(2)} USD`],
                ['Observed', <time key="observed">{task.updated_at}</time>],
              ]}
            />
            {stateOf(task) === 'TASK_STATE_INPUT_REQUIRED' && (
              <div className="grid min-w-0 gap-2 rounded-md border border-warning-border bg-warning-bg p-3">
                <strong className="text-sm font-semibold text-warning">External agent requires input</strong>
                <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
                  {questionOf(task) ||
                    'The agent did not supply question text. Inspect its protocol result before answering.'}
                </pre>
                <p className="text-xs text-muted-foreground">
                  A reply applies to this exact request and does not authorize SABRE publication, budget or
                  permission changes.
                </p>
              </div>
            )}
            {task.state.includes('uncertain') && (
              <Notice tone="warning">
                The remote effect is uncertain. Poll the saved receipt; do not create another delegation to
                retry it.
              </Notice>
            )}
            <Disclosure summary="Remote status and artifacts" variant="plain">
              <JsonView value={task.result} label="Untrusted remote result" />
            </Disclosure>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy || !connected}
                onClick={() => void poll(task)}
              >
                Poll remote task
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
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
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                disabled={busy || !connected || terminal(task)}
                onClick={() => {
                  setAction({ type: 'cancel', task });
                  setSubmitted(false);
                  setError('');
                }}
              >
                Cancel external task
              </Button>
            </div>
            <small className="text-xs text-muted-foreground">
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
            <Button
              type="button"
              variant={action.type === 'cancel' ? 'danger' : 'primary'}
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
            </Button>
          }
        >
          <div className="grid min-w-0 gap-4">
            {error && (
              <Notice tone="danger" role="alert">
                {error}
              </Notice>
            )}
            {action.type === 'answer' ? (
              <>
                <CodeBlock label="External question">{questionOf(action.task)}</CodeBlock>
                <p className="text-sm text-muted-foreground">
                  The reply is bound to input digest{' '}
                  <code className="font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                    {action.task.input_digest}
                  </code>
                  . A changed question requires a fresh inspection.
                </p>
                <Field label="Reply to this external request">
                  <Textarea
                    rows={5}
                    maxLength={12000}
                    disabled={!connected || busy || submitted}
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                  />
                </Field>
                <p className="text-sm text-muted-foreground">
                  This sends text to the selected external agent. The local run remains under its existing
                  pause and approval controls.
                </p>
              </>
            ) : (
              <p className="text-sm">
                Request cancellation of this exact remote task. A missing response remains uncertain until its
                status is reconciled.
              </p>
            )}
          </div>
        </Dialog>
      )}
    </Card>
  );
}

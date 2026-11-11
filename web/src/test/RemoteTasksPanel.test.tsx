import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import RemoteTasksPanel from '../RemoteTasksPanel';
import { createApi, type A2ATaskInfo } from '../api';

const task: A2ATaskInfo = {
  attempt_key: 'a2a:synthetic-local-step',
  work_id: 'synthetic-work',
  agent_name: 'synthetic-remote',
  remote_task_id: 'synthetic-remote-task',
  remote_context_id: 'synthetic-remote-context',
  state: 'received',
  result: {
    id: 'synthetic-remote-task',
    contextId: 'synthetic-remote-context',
    status: {
      state: 'TASK_STATE_INPUT_REQUIRED',
      message: {
        messageId: 'synthetic-question-1',
        parts: [{ text: 'Keep the original synthetic format?' }],
      },
    },
  },
  cost_usd: null,
  updated_at: '2026-11-11T13:00:00Z',
  input_digest: 'a'.repeat(64),
};
function connect(options: { lostAnswer?: boolean; changedQuestion?: boolean } = {}) {
  const writes: { path: string; body: unknown }[] = [];
  let answerCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, request: RequestInit = {}) => {
      if (!request.method) return Response.json([task]);
      const body = JSON.parse(String(request.body)) as unknown;
      writes.push({ path, body });
      if (path.endsWith('/answer')) {
        answerCalls += 1;
        if (options.lostAnswer && answerCalls === 1) throw new TypeError('Synthetic lost reply response');
        if (options.changedQuestion)
          return Response.json(
            { message: 'The external input request changed. Inspect the current question before answering.' },
            { status: 409 },
          );
      }
      return Response.json({
        ...task,
        state: path.endsWith('/cancel') ? 'cancel_requested' : 'received',
        input_digest: null,
        result: {
          ...task.result,
          status: { state: path.endsWith('/cancel') ? 'TASK_STATE_CANCELED' : 'TASK_STATE_COMPLETED' },
        },
      });
    }),
  );
  return { api: createApi('synthetic-csrf'), writes };
}

it('shows the untrusted input request, remote identity and unknown cost', async () => {
  const { api } = connect();
  render(<RemoteTasksPanel api={api} workId="synthetic-work" />);
  await screen.findByText('External agent requires input');
  expect(screen.getByText('Keep the original synthetic format?')).toBeInTheDocument();
  expect(screen.getByText('synthetic-remote-task')).toBeInTheDocument();
  expect(screen.getByText('synthetic-remote-context')).toBeInTheDocument();
  expect(screen.getByText('Unknown')).toBeInTheDocument();
  expect(
    screen.getByText(/does not authorize SABRE publication, budget or permission changes/),
  ).toBeInTheDocument();
});

it('retries an exact digest-bound reply after a lost response without resuming the local run', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect({ lostAnswer: true });
  render(<RemoteTasksPanel api={api} workId="synthetic-work" />);
  await user.click(await screen.findByRole('button', { name: 'Answer external question' }));
  const dialog = screen.getByRole('dialog', { name: 'Answer external question' });
  await user.type(
    within(dialog).getByLabelText('Reply to this external request'),
    'Keep the original fixture format',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Send bound reply' }));
  const retry = await within(dialog).findByRole('button', { name: 'Retry exact action' });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(within(dialog).getByLabelText('Reply to this external request')).toBeDisabled();
  await user.click(retry);
  await screen.findByText(
    'Reply recorded for the selected external input request. The local run was not resumed.',
  );
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0]).toEqual({
    path: '/api/v1/work/synthetic-work/a2a-tasks/answer',
    body: {
      attempt_key: task.attempt_key,
      expected_input_digest: task.input_digest,
      answer: 'Keep the original fixture format',
    },
  });
});

it('requires fresh inspection when the remote question changes', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect({ changedQuestion: true });
  render(<RemoteTasksPanel api={api} workId="synthetic-work" />);
  await user.click(await screen.findByRole('button', { name: 'Answer external question' }));
  const dialog = screen.getByRole('dialog', { name: 'Answer external question' });
  await user.type(
    within(dialog).getByLabelText('Reply to this external request'),
    'A reply to the inspected question',
  );
  await user.click(within(dialog).getByRole('button', { name: 'Send bound reply' }));
  await within(dialog).findByText(
    'The external input request changed. Inspect the current question before answering.',
  );
  expect(writes).toHaveLength(1);
});

it('confirms cancellation of the selected remote receipt and disables controls when disconnected', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect();
  const view = render(<RemoteTasksPanel api={api} workId="synthetic-work" />);
  await user.click(await screen.findByRole('button', { name: 'Cancel external task' }));
  const dialog = screen.getByRole('dialog', { name: 'Cancel external task' });
  view.rerender(<RemoteTasksPanel api={api} workId="synthetic-work" connected={false} />);
  expect(within(dialog).getByRole('button', { name: 'Confirm remote cancellation' })).toBeDisabled();
  expect(writes).toHaveLength(0);
  view.rerender(<RemoteTasksPanel api={api} workId="synthetic-work" connected />);
  await user.click(within(dialog).getByRole('button', { name: 'Confirm remote cancellation' }));
  await screen.findByText(
    'Remote cancellation reconciled. Inspect the reported task state for confirmation.',
  );
  expect(writes[0]).toEqual({
    path: '/api/v1/work/synthetic-work/a2a-tasks/cancel',
    body: { attempt_key: task.attempt_key },
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { createApi, type OperatorMessageRequest, type WorkOrder } from '../api';
import SupervisorConsole from '../SupervisorConsole';

test('chat expands without losing its draft and opens only recorded tool details on demand', async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      paths.push(path);
      if (path.endsWith('/tools'))
        return Response.json({
          version: 1,
          message_id: 'message-recorded',
          available: true,
          checkpoint_id: 'checkpoint-retained',
          truncated: false,
          tools: [
            {
              call_id: 'call-recorded',
              name: 'read_file',
              input: '{"path":"README.md"}',
              output: 'Recorded source excerpt',
              status: 'completed',
              redacted: false,
              truncated: false,
            },
          ],
        });
      return Response.json({
        items: [
          {
            version: 1,
            id: 'message-recorded',
            work_id: null,
            text: 'Inspect the project',
            source: 'web',
            allowed_actions: [],
            state: 'completed',
            reply: 'The recorded inspection is available.',
            error_code: null,
            created_at: '2026-11-11T10:00:00Z',
          },
        ],
        truncated: false,
      });
    }),
  );
  render(
    <>
      <button>Outside chat</button>
      <SupervisorConsole
        api={createApi('synthetic-csrf')}
        orders={[]}
        selectedId={null}
        disconnected={false}
      />
    </>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Supervisor/ }));
  await screen.findByText('The recorded inspection is available.');
  expect(paths.some((path) => path.endsWith('/tools'))).toBe(false);
  expect(screen.getByText('Allow actions for this message').closest('details')).not.toHaveAttribute('open');
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this unsent concern');
  await user.click(screen.getByRole('button', { name: 'Expand chat' }));
  expect(screen.getByRole('dialog', { name: 'Supervisor conversation' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Outside chat' }).inert).toBe(true);
  await user.click(screen.getByText('Recorded tool invocations'));
  await screen.findByText('read_file · completed');
  await user.click(screen.getByText('read_file · completed'));
  expect(screen.getByText('Recorded source excerpt')).toBeVisible();
  expect(screen.getByText('{"path":"README.md"}')).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Expand chat' })).toHaveFocus();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this unsent concern');
  expect(screen.getByRole('button', { name: 'Outside chat' }).inert).toBeFalsy();
});

test('attention inbox retains per-run drafts and excludes answered or superseded questions', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [], truncated: false })),
  );
  const question = {
    id: 'question-current',
    work_id: 'run-attention',
    plan_revision: 2,
    prompt: 'Choose the architecture',
    kind: 'architecture' as const,
    options: [],
    subject_digest: null,
    answer: null,
    answered_at: null,
  };
  const run: Pick<WorkOrder, 'id' | 'objective' | 'questions' | 'plan_revision' | 'status' | 'error_code'> = {
    id: 'run-attention',
    objective: 'Review the checkout',
    status: 'blocked',
    plan_revision: 2,
    error_code: 'BUDGET_EXHAUSTED',
    questions: [
      question,
      { ...question, id: 'answered', prompt: 'Already answered', answer: 'Yes' },
      { ...question, id: 'old', prompt: 'Superseded question', plan_revision: 1 },
    ],
  };
  render(
    <SupervisorConsole
      api={createApi('synthetic-csrf')}
      orders={[run]}
      selectedId={null}
      disconnected={false}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Supervisor/ }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Factory draft');
  await user.click(screen.getByText('Attention inbox · 1 run'));
  expect(screen.getByText('Choose the architecture')).toBeVisible();
  expect(screen.queryByText('Already answered')).not.toBeInTheDocument();
  expect(screen.queryByText('Superseded question')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /Discuss run/ }));
  expect(screen.getByRole('combobox', { name: 'Conversation context' })).toHaveValue('run-attention');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Run-specific draft');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Conversation context' }), '');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Factory draft');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Conversation context' }), 'run-attention');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Run-specific draft');
  expect(screen.getByText('Choose the architecture')).toBeVisible();
});

test('owner messages default to read-only and run scope exposes only run-specific action grants', async () => {
  const writes: OperatorMessageRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as OperatorMessageRequest;
        writes.push(body);
        return Response.json({
          version: 1,
          id: 'message-1',
          work_id: body.work_id,
          text: body.text,
          allowed_actions: body.allowed_actions,
          state: 'queued',
          reply: null,
          error_code: null,
          created_at: '2026-11-11T10:00:00Z',
        });
      }
      return Response.json({ items: [], truncated: false });
    }),
  );
  render(
    <SupervisorConsole
      api={createApi('synthetic-csrf')}
      orders={[]}
      selectedId="run-a"
      disconnected={false}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Supervisor/ }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Watch out: preserve the public API');
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ version: 1, work_id: 'run-a', allowed_actions: [] });
  expect(writes[0]).not.toHaveProperty('principal');
  await user.click(screen.getByText('Allow actions for this message'));
  expect(screen.queryByRole('checkbox', { name: /Start runs/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /Pause, resume or cancel/ }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Pause this run');
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].allowed_actions).toEqual(['control_work']);
  expect(screen.getByText(/No action has been confirmed/)).toBeVisible();
});

test('unconfirmed submissions retain their key for an unchanged explicit retry', async () => {
  const writes: OperatorMessageRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init: RequestInit = {}) => {
      if (init.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        throw new Error('synthetic disconnected response');
      }
      return Response.json({ items: [], truncated: false });
    }),
  );
  render(
    <SupervisorConsole
      api={createApi('synthetic-csrf')}
      orders={[]}
      selectedId={null}
      disconnected={false}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Supervisor/ }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Inspect factory readiness');
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[0].idempotency_key).toBe(writes[1].idempotency_key);
});

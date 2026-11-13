import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { createApi, type OperatorMessageRequest, type WorkOrder } from '../api';
import SupervisorConsole from '../SupervisorConsole';

test('observed setup actions accept only registered destinations and never model-supplied URLs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      Response.json(
        path.endsWith('/tools')
          ? {
              version: 1,
              message_id: 'setup-message',
              available: true,
              checkpoint_id: 'setup-record',
              truncated: false,
              tools: [],
              actions: [
                {
                  id: 'connect-github-read',
                  kind: 'open_tool',
                  target: 'github.read',
                  label: 'Connect GitHub repositories',
                },
                {
                  id: 'connect-provider',
                  kind: 'open_models',
                  target: 'model',
                  label: 'Connect model provider',
                },
                { id: 'add-mcp-connection', kind: 'open_tools', target: 'mcp', label: 'Add MCP connection' },
                {
                  id: 'connect-github-publish',
                  kind: 'open_tool',
                  target: 'https://untrusted.example',
                  label: 'Injected action',
                },
              ],
            }
          : {
              items: [
                {
                  version: 1,
                  id: 'setup-message',
                  work_id: null,
                  text: 'Check readiness',
                  source: 'web',
                  allowed_actions: [],
                  state: 'completed',
                  reply: 'Review the recorded connection state.',
                  error_code: null,
                  created_at: '2026-11-11T10:00:00Z',
                },
              ],
              truncated: false,
            },
      ),
    ),
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
  expect(await screen.findByRole('link', { name: 'Connect GitHub repositories' })).toHaveAttribute(
    'href',
    '/tools?connection=github.read',
  );
  expect(screen.getByRole('link', { name: 'Connect model provider' })).toHaveAttribute(
    'href',
    '/config?section=provider',
  );
  expect(screen.getByRole('link', { name: 'Add MCP connection' })).toHaveAttribute(
    'href',
    '/tools?setup=mcp',
  );
  expect(screen.queryByRole('link', { name: 'Injected action' })).not.toBeInTheDocument();
});

test('active replies show elapsed submission time and only retained tool activity', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-11T10:01:05Z'));
  try {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) =>
        Response.json(
          path.endsWith('/tools')
            ? {
                version: 1,
                message_id: 'active-message',
                available: true,
                checkpoint_id: 'retained',
                truncated: false,
                actions: [],
                tools: [
                  {
                    call_id: 'active-tool',
                    name: 'get_work',
                    input: '{"work_id":"run-a"}',
                    output: null,
                    status: 'pending',
                    redacted: false,
                    truncated: false,
                  },
                ],
              }
            : {
                items: [
                  {
                    version: 1,
                    id: 'active-message',
                    work_id: 'run-a',
                    text: 'Inspect the current run',
                    source: 'web',
                    allowed_actions: [],
                    state: 'running',
                    reply: null,
                    error_code: null,
                    created_at: '2026-11-11T10:00:00Z',
                  },
                ],
                truncated: false,
              },
        ),
      ),
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
    expect(await screen.findByText('1:05 since sent · includes queue time')).toBeVisible();
    expect(screen.getByText('Processing message')).toBeVisible();
    expect(await screen.findByText('get_work · pending')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', '/work/run-a');
    await user.click(screen.getByText('Recorded tool invocations · 1'));
    await user.click(screen.getByText('get_work · pending'));
    expect(screen.getByText('No result recorded.')).toBeVisible();
    expect(screen.getByText('{"work_id":"run-a"}')).toBeVisible();
  } finally {
    clock.mockRestore();
  }
});

test('chat expands without losing its draft and keeps prefetched tool details folded until inspected', async () => {
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
  await waitFor(() => expect(paths.some((path) => path.endsWith('/tools'))).toBe(true));
  expect(screen.queryByText('Recorded source excerpt')).not.toBeInTheDocument();
  expect(screen.getByText('Allow actions for this message').closest('details')).not.toHaveAttribute('open');
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this unsent concern');
  await user.click(screen.getByRole('button', { name: 'Expand chat' }));
  expect(screen.getByRole('dialog', { name: 'Supervisor conversation' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Outside chat' }).inert).toBe(true);
  await user.click(screen.getByText(/Recorded tool invocations/));
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

test('requests and refused decisions are signalled on the launcher and decided in the panel', async () => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [], truncated: false })),
  );
  const request = {
    version: 1 as const,
    id: 'confirmation-1',
    kind: 'budget.amend' as const,
    work_id: null,
    source: 'mcp' as const,
    state: 'pending' as const,
    summary: 'Change the token budget to 800,000, then resume the run',
    request: { metric: 'tokens' },
    request_digest: 'a'.repeat(64),
    created_at: '2026-11-13T09:00:00Z',
    expires_at: '2026-11-14T09:00:00Z',
    decided_at: null,
    error_code: null,
    error_message: null,
  };
  const refused = {
    ...request,
    id: 'confirmation-0',
    state: 'failed' as const,
    summary: 'Raise the token limit from 100,000 to 800,000',
    error_code: 'VERSIONED_BUDGET_REQUIRED',
    error_message: 'Use a revision-checked metric amendment for this run',
  };
  const user = userEvent.setup();
  const view = render(
    <SupervisorConsole
      api={createApi('synthetic-csrf')}
      orders={[]}
      selectedId={null}
      disconnected={false}
      confirmations={[request, refused]}
    />,
  );
  const launcher = screen.getByRole('button', { name: 'Supervisor' });
  expect(launcher).toHaveAccessibleDescription(
    '2 items need you, including a decision that did not take effect',
  );
  expect(launcher).toHaveAttribute('data-attention', 'danger');
  // The new request is announced once without moving the page; reviewing it opens the inbox.
  await user.click(await screen.findByRole('button', { name: 'Review' }));
  const panel = screen.getByRole('region', { name: 'Supervisor conversation' });
  expect(panel).toContainElement(
    screen.getByRole('region', { name: 'A request is waiting for your confirmation' }),
  );
  expect(screen.getByRole('button', { name: /^Confirm: Change the token budget/ })).toBeEnabled();
  await user.click(
    screen.getByRole('button', { name: 'Dismiss: Raise the token limit from 100,000 to 800,000' }),
  );
  expect(screen.queryByTestId('unresolved-confirmation')).not.toBeInTheDocument();
  expect(launcher).toHaveAccessibleDescription('1 item needs you');
  expect(launcher).toHaveAttribute('data-attention', 'warning');
  // After a reload the dismissed refusal stays dismissed and the request is not announced again.
  view.unmount();
  render(
    <SupervisorConsole
      api={createApi('synthetic-csrf')}
      orders={[]}
      selectedId={null}
      disconnected={false}
      confirmations={[request, refused]}
    />,
  );
  expect(screen.getByRole('button', { name: 'Supervisor' })).toHaveAccessibleDescription('1 item needs you');
  expect(screen.queryByTestId('attention-toast')).not.toBeInTheDocument();
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

test('the launcher moves into the header on wide screens and floats over the page otherwise', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [], truncated: false })),
  );
  const header = document.createElement('div');
  document.body.append(header);
  const props = {
    api: createApi('synthetic-csrf'),
    orders: [],
    selectedId: null,
    disconnected: false,
    headerSlot: header,
  };
  const narrow = render(<SupervisorConsole {...props} />);
  expect(header).toBeEmptyDOMElement();
  expect(screen.getByRole('button', { name: /Supervisor/ })).toHaveClass('fixed');
  narrow.unmount();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(min-width: 64rem)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  render(<SupervisorConsole {...props} />);
  const launcher = screen.getByRole('button', { name: /Supervisor/ });
  expect(header).toContainElement(launcher);
  expect(launcher).not.toHaveClass('fixed');
  header.remove();
});

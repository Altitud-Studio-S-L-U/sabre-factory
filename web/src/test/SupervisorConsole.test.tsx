import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { createApi, type OperatorMessageRequest } from '../api';
import SupervisorConsole from '../SupervisorConsole';

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

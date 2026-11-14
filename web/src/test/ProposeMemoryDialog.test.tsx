import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createApi } from '../api';
import ProposeMemoryDialog from '../features/memory/ProposeMemoryDialog';
import { memoryItem } from './memoryFixture';

const newest = '5be10d7'.padEnd(40, '0');
const older = 'a41c9e2'.padEnd(40, '0');
const commits = [
  { commit: newest, readAt: '2026-11-10T07:40:00Z' },
  { commit: older, readAt: '2026-11-08T07:40:00Z' },
];

function stub(response: () => Response) {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string, request: RequestInit = {}) => {
      bodies.push(JSON.parse(String(request.body)));
      return response();
    }),
  );
  return bodies;
}

it('records the owner’s knowledge against the newest indexed commit with the files it cites', async () => {
  const user = userEvent.setup();
  const bodies = stub(() =>
    Response.json(memoryItem({ id: 'm40', state: 'pending', active: false }), { status: 201 }),
  );
  const onProposed = vi.fn();
  render(
    <ProposeMemoryDialog
      api={createApi('synthetic-csrf', () => undefined)}
      projectId="synthetic-project"
      commits={commits}
      open
      connected
      onClose={vi.fn()}
      onProposed={onProposed}
    />,
  );
  const save = screen.getByRole('button', { name: 'Save proposal' });
  expect(save).toBeDisabled();
  expect(screen.getByLabelText('Indexed commit')).toHaveValue(newest);
  expect(screen.queryByLabelText('Source run')).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('Content'), 'Prices are stored in cents.');
  await user.type(
    screen.getByLabelText('Cited files'),
    'src/pricing/catalog.py#L3{Enter}src/pricing/rounding.py',
  );
  await user.click(save);
  await vi.waitFor(() => expect(onProposed).toHaveBeenCalledWith(expect.objectContaining({ id: 'm40' })));
  expect(bodies).toEqual([
    {
      project_id: 'synthetic-project',
      kind: 'lesson',
      content: 'Prices are stored in cents.',
      source_commit: newest,
      scope: 'project',
      citations: ['src/pricing/catalog.py#L3', 'src/pricing/rounding.py'],
    },
  ]);
});

it('keeps the proposal and shows the reason when the service refuses it', async () => {
  const user = userEvent.setup();
  stub(() =>
    Response.json(
      {
        code: 'MEMORY_CITATION_UNKNOWN',
        message: 'Cited files must exist in the repository index at the source commit: src/missing.py',
      },
      { status: 422 },
    ),
  );
  const onProposed = vi.fn();
  render(
    <ProposeMemoryDialog
      api={createApi('synthetic-csrf', () => undefined)}
      projectId="synthetic-project"
      commits={commits}
      open
      connected
      onClose={vi.fn()}
      onProposed={onProposed}
    />,
  );
  await user.selectOptions(screen.getByLabelText('Indexed commit'), older);
  await user.type(screen.getByLabelText('Content'), 'Prices are stored in cents.');
  await user.click(screen.getByRole('button', { name: 'Save proposal' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /Cited files must exist in the repository index/,
  );
  expect(screen.getByLabelText('Content')).toHaveValue('Prices are stored in cents.');
  expect(onProposed).not.toHaveBeenCalled();
});

it('asks for the repository to be read first when no commit is indexed', async () => {
  const user = userEvent.setup();
  render(
    <ProposeMemoryDialog
      api={createApi('synthetic-csrf', () => undefined)}
      projectId="synthetic-project"
      commits={[]}
      open
      connected
      onClose={vi.fn()}
      onProposed={vi.fn()}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent(/Read the repository first/);
  await user.type(screen.getByLabelText('Content'), 'Prices are stored in cents.');
  expect(screen.getByRole('button', { name: 'Save proposal' })).toBeDisabled();
});

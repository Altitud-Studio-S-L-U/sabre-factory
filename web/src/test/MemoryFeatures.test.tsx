import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { createApi } from '../api';
import KnowledgeMap from '../features/memory/KnowledgeMap';
import MemoryInspector from '../features/memory/MemoryInspector';
import ReviewQueue from '../features/memory/ReviewQueue';
import RecallLog from '../features/memory/RecallLog';
import { memoryDetail, memoryGraph, memoryItem, memoryRecalls, memoryReview } from './memoryFixture';

function stub(routes: Record<string, unknown>) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      const path = input.replace('/api/v1', '');
      calls.push({
        path,
        method: request.method ?? 'GET',
        body: request.body ? JSON.parse(String(request.body)) : null,
      });
      const match = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
      return match ? Response.json(match[1]) : Response.json({ message: 'Not prepared' }, { status: 404 });
    }),
  );
  return calls;
}

const api = () => createApi('synthetic-csrf', () => undefined);

it('maps memories with their run, commit, files and proposer and re-centres on a selected memory', async () => {
  const user = userEvent.setup();
  const calls = stub({ '/projects/synthetic-project/memory/graph': memoryGraph() });
  const onFocus = vi.fn();
  render(
    <KnowledgeMap api={api()} projectId="synthetic-project" focus={null} refreshKey={0} onFocus={onFocus} />,
  );
  const map = await screen.findByRole('group', { name: /Knowledge map with 7 nodes and 6 links/ });
  expect(within(map).getByText('src/pricing/discount.py')).toBeInTheDocument();
  await user.click(within(map).getByRole('button', { name: 'Memory: Discount rounds half up' }));
  expect(onFocus).toHaveBeenCalledWith('p41');
  expect(calls[0].path).toBe('/projects/synthetic-project/memory/graph?depth=2&limit=120');
  await user.click(screen.getByRole('button', { name: 'Direct links' }));
  expect(calls.at(-1)!.path).toBe('/projects/synthetic-project/memory/graph?depth=1&limit=120');
});

it('explains a memory: provenance chain, recall counts, whether it holds and what it links to', async () => {
  const user = userEvent.setup();
  stub({ '/memory/m27': memoryDetail() });
  const onFocus = vi.fn();
  render(
    <MemoryRouter>
      <MemoryInspector
        api={api()}
        memoryId="m27"
        connected
        refreshKey={0}
        onChanged={vi.fn()}
        onFocus={onFocus}
      />
    </MemoryRouter>,
  );
  const inspector = await screen.findByRole('complementary', { name: 'Memory inspector' });
  expect(await within(inspector).findByText('Proposed by Factory · developer')).toBeVisible();
  expect(within(inspector).getByRole('link', { name: 'Correct the synthetic example' })).toHaveAttribute(
    'href',
    '/runs/synthetic-run',
  );
  expect(within(inspector).getByText(/14 times/)).toBeVisible();
  expect(within(inspector).getByText(/1 calls stopped because it had changed/)).toBeVisible();
  expect(within(inspector).getByText(/Cited files unchanged/)).toBeVisible();
  expect(within(inspector).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  await user.click(within(inspector).getByRole('button', { name: /related/ }));
  expect(onFocus).toHaveBeenCalledWith('l05');
});

it('offers carry forward for a memory whose cited files changed', async () => {
  const user = userEvent.setup();
  const stale = memoryItem({
    validity: {
      commit: 'b'.repeat(40),
      state: 'stale',
      reason: 'citations_changed',
      changed_paths: [{ path: 'src/pricing/discount.py', change: 'changed' }],
      checked_at: null,
    },
  });
  const calls = stub({
    '/memory/m27/carry-forward': {
      commit: 'b'.repeat(40),
      state: 'valid',
      basis: 'owner',
      changed_paths: [],
      checked_at: null,
    },
    '/memory/m27': memoryDetail(stale),
  });
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <MemoryInspector
        api={api()}
        memoryId="m27"
        connected
        refreshKey={0}
        onChanged={onChanged}
        onFocus={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Cited files changed')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Carry forward' }));
  expect(calls.at(-1)).toEqual({
    path: '/memory/m27/carry-forward',
    method: 'POST',
    body: { commit: 'b'.repeat(40) },
  });
  expect(onChanged).toHaveBeenCalled();
});

it('compares a proposal with the memory it overlaps and approves it as a replacement', async () => {
  const user = userEvent.setup();
  const calls = stub({ '/memory/p41/approve': memoryItem({ id: 'p41' }) });
  const onChanged = vi.fn();
  render(
    <ReviewQueue api={api()} review={memoryReview()} connected onChanged={onChanged} onInspect={vi.fn()} />,
  );
  const comparison = screen.getByRole('region', { name: 'Proposal comparison' });
  expect(within(comparison).getByText(/Overlap 62% · wording 62% · no embeddings configured/)).toBeVisible();
  expect(within(comparison).getByText('round_half_even')).toBeVisible();
  expect(within(comparison).getByText(/does not decide whether two memories conflict/)).toBeVisible();
  await user.click(within(comparison).getByRole('button', { name: 'Approve and supersede m27' }));
  expect(calls.at(-1)).toEqual({ path: '/memory/p41/approve', method: 'POST', body: { supersedes: 'm27' } });
  expect(onChanged).toHaveBeenCalledWith(expect.stringContaining('superseded'));
  const stale = screen.getByRole('region', { name: /Needs revalidation/ });
  expect(within(stale).getByText(/src\/limits.py changed/)).toBeVisible();
});

it('keeps every review decision disabled while disconnected', () => {
  stub({});
  render(
    <ReviewQueue
      api={api()}
      review={memoryReview()}
      connected={false}
      onChanged={vi.fn()}
      onInspect={vi.fn()}
    />,
  );
  for (const name of ['Approve', 'Reject', 'Approve as related', 'Carry forward', 'Invalidate'])
    expect(screen.getByRole('button', { name })).toBeDisabled();
});

it('lists what each station recalled with its ranks and marks refused calls', async () => {
  const user = userEvent.setup();
  stub({ '/projects/synthetic-project/memory/recalls': memoryRecalls() });
  const onInspect = vi.fn();
  render(
    <MemoryRouter>
      <RecallLog api={api()} projectId="synthetic-project" refreshKey={0} onInspect={onInspect} />
    </MemoryRouter>,
  );
  const table = await screen.findByRole('table', { name: 'Recall log' });
  expect(within(table).getByText('#1 / #2 · #2 / —')).toBeVisible();
  expect(within(table).getByText('Refused · MEMORY_CONTEXT_CHANGED')).toBeVisible();
  expect(within(table).getByText('Recalled · 3 candidates')).toBeVisible();
  await user.click(within(table).getByRole('button', { name: 'm09' }));
  expect(onInspect).toHaveBeenCalledWith('m09');
});

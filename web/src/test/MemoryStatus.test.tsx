import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import MemoryStatus, { readOutcome } from '../features/memory/MemoryStatus';
import {
  memoryItem,
  memoryRecalls,
  memoryReview,
  repositoryRead,
  repositoryStatement,
} from './memoryFixture';

const NOW = new Date('2026-11-12T10:00:00Z').getTime();

function show(overrides: Partial<ComponentProps<typeof MemoryStatus>> = {}) {
  const onRead = vi.fn();
  const onReview = vi.fn();
  render(
    <MemoryStatus
      ingestion={{ version: 1, project_id: 'synthetic-project', jobs: [], latest: null }}
      items={[]}
      review={null}
      recalls={null}
      now={NOW}
      loading={false}
      connected
      busy={false}
      error=""
      onRead={onRead}
      onReview={onReview}
      {...overrides}
    />,
  );
  return { onRead, onReview };
}

it('names the cause of an empty memory and offers the one action that fills it', async () => {
  const user = userEvent.setup();
  const { onRead } = show();
  expect(screen.getByRole('heading', { name: 'Memory status' })).toBeVisible();
  expect(
    screen.getByText(/has not been read yet, so the factory knows nothing about this project/),
  ).toBeVisible();
  expect(
    screen.getByText(/It makes no model call, and nothing is used by a run until you approve it/),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: /^Review/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Read the repository' }));
  expect(onRead).toHaveBeenCalledOnce();
});

it('says that a repository indexed before statements were read still has to be read', () => {
  show({ ingestion: repositoryRead(null) });
  expect(screen.getByText(/is indexed, but what it says has not been read into memory yet/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Read the repository' })).toBeEnabled();
  expect(screen.getByText(/Index v1 · 22 file references · 0 omitted/)).toBeVisible();
});

it('sums up the records, the last write and recall and what the last read did', async () => {
  const user = userEvent.setup();
  const { onReview } = show({
    ingestion: repositoryRead({ proposed: 3, replaced: 1, unchanged: 12 }),
    items: [memoryItem(), repositoryStatement()],
    review: memoryReview(),
    recalls: memoryRecalls(),
  });
  expect(screen.getByText('1 approved record · 1 waiting for your review · 1 to revalidate')).toBeVisible();
  expect(screen.getByText(/Last written .+ · last recalled by a run 2 h ago/)).toBeVisible();
  // The commit sits in its own element, so the sentence is read from the paragraph as a whole.
  expect(screen.getByText(/3 proposed · 1 proposed with changed text · 12 unchanged/)).toHaveTextContent(
    /^Last read at 5be10d70 · .+: 3 proposed · 1 proposed with changed text · 12 unchanged\.$/,
  );
  expect(screen.getByRole('button', { name: 'Read the repository again' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Review 1 proposal' }));
  expect(onReview).toHaveBeenCalledOnce();
});

it('explains a read that found nothing instead of showing an empty page', () => {
  show({ ingestion: repositoryRead({ proposed: 0 }) });
  expect(
    screen.getByText(/Nothing is approved or waiting\. Memory grows from what the repository says/),
  ).toBeVisible();
  expect(screen.getByText(/it states nothing the factory recognizes\./)).toBeVisible();
  expect(
    readOutcome({
      proposed: 0,
      replaced: 0,
      unchanged: 0,
      declined: 2,
      withdrawn: 1,
      refused: 0,
      omitted: 4,
    }),
  ).toBe('2 declined by you before · 1 withdrawn · 4 left out by the limit of one read');
});

it('does not offer a second read while one is queued, and shows why a read stopped', () => {
  const report = repositoryRead();
  const queued = {
    ...report.jobs[0],
    id: 'queued',
    state: 'queued' as const,
    finished_at: null,
    imported: null,
  };
  const view = render(
    <MemoryStatus
      ingestion={{ ...report, jobs: [queued, ...report.jobs] }}
      items={[]}
      review={null}
      recalls={null}
      now={NOW}
      loading={false}
      connected
      busy={false}
      error=""
      onRead={vi.fn()}
      onReview={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Reading…' })).toBeDisabled();
  expect(
    screen.getByText(/Reading the repository\. Admission scanning runs before anything is kept/),
  ).toBeVisible();
  const failed = {
    ...report.jobs[0],
    id: 'failed',
    state: 'failed' as const,
    imported: null,
    error_code: 'INGESTION_FAILED',
    error_message: 'Repository indexing failed.',
  };
  view.rerender(
    <MemoryStatus
      ingestion={{ ...report, jobs: [failed, ...report.jobs] }}
      items={[]}
      review={null}
      recalls={null}
      now={NOW}
      loading={false}
      connected={false}
      busy={false}
      error="The request could not be sent."
      onRead={vi.fn()}
      onReview={vi.fn()}
    />,
  );
  expect(screen.getByText('INGESTION_FAILED')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('The request could not be sent.');
  expect(screen.getByRole('button', { name: 'Read the repository again' })).toBeDisabled();
});

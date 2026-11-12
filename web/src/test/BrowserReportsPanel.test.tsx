import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createApi, type BrowserReport } from '../api';
import BrowserReportsPanel from '../BrowserReportsPanel';

const report: BrowserReport = {
  version: 1,
  evaluator: 'playwright-1.64.0+axe-core-4.11.0',
  work_id: 'synthetic-work',
  snapshot_digest: 'a'.repeat(64),
  passed: false,
  results: [
    {
      viewport: 'mobile',
      passed: false,
      overflow: true,
      failedRequests: [{ status: 404 }],
      accessibility: [],
    },
  ],
  visual_review: 'unavailable',
  artifacts: [
    {
      kind: 'screenshot',
      digest: 'b'.repeat(64),
      viewport: 'mobile',
      media_type: 'image/png',
      size: 100,
      review_required: false,
    },
    {
      kind: 'trace',
      digest: 'c'.repeat(64),
      viewport: 'mobile',
      media_type: 'application/zip',
      size: 200,
      review_required: true,
    },
  ],
};

it('shows source-bound failure evidence and never exposes quarantined trace links', async () => {
  const api = { ...createApi('synthetic-csrf'), browserReports: vi.fn(async () => [report]) };
  render(<BrowserReportsPanel api={api} workId="synthetic-work" sourceDigest={'d'.repeat(64)} />);
  await screen.findByText('Recorded checks failed');
  expect(screen.getByText('Historical snapshot')).toBeInTheDocument();
  expect(screen.getByText('Horizontal overflow detected')).toBeInTheDocument();
  expect(screen.getByText('Failed requests or routes: 1')).toBeInTheDocument();
  expect(screen.getByText(report.evaluator)).toBeInTheDocument();
  expect(screen.getByText('Visual model review unavailable')).toBeInTheDocument();
  expect(screen.getByText(/Quarantined: inspection and redaction required/)).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('loads screenshots through the authorized API and releases their local object URLs', async () => {
  const user = userEvent.setup();
  const createObjectURL = vi.fn(() => 'blob:synthetic-preview');
  const revokeObjectURL = vi.fn();
  class LocalURL extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal('URL', LocalURL);
  const api = {
    ...createApi('synthetic-csrf'),
    browserReports: vi.fn(async () => [report]),
    browserArtifact: vi.fn(async () => new Blob(['synthetic-image-fixture'], { type: 'image/png' })),
  };
  const view = render(<BrowserReportsPanel api={api} workId="synthetic-work" />);
  await user.click(await screen.findByRole('button', { name: 'Show screenshot' }));
  await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:synthetic-preview'));
  expect(api.browserArtifact).toHaveBeenCalledWith('synthetic-work', 'b'.repeat(64));
  expect(api.browserArtifact).not.toHaveBeenCalledWith('synthetic-work', 'c'.repeat(64));
  view.unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-preview');
});

it('labels absent evidence without inventing a pass', async () => {
  const api = { ...createApi('synthetic-csrf'), browserReports: vi.fn(async () => []) };
  render(<BrowserReportsPanel api={api} workId="synthetic-work" />);
  await screen.findByText(/No browser verification recorded for this run/);
  expect(screen.queryByText('Recorded checks passed')).not.toBeInTheDocument();
});

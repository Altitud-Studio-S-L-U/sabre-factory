import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import RunReport from '../RunReport';

const work: ComponentProps<typeof RunReport>['work'] = {
  status: 'blocked',
  mode: 'audit',
  summary: 'Waiting for verification',
  updated_at: '2026-11-11T12:00:00Z',
  error_code: 'BUDGET_EXHAUSTED',
  findings: [],
  evidence: null,
  security_snapshot_digest: null,
  security_rules_version: null,
};

it('keeps an incomplete audit and absent security evidence explicit', () => {
  render(<RunReport work={work} />);
  expect(screen.getByText(/not a completed report/)).toBeInTheDocument();
  expect(screen.getByText(/Zero findings does not establish/)).toBeInTheDocument();
  expect(screen.getByText(/a draft PR is not expected/)).toBeInTheDocument();
  expect(screen.queryByText('Passed')).not.toBeInTheDocument();
});

it('reports a cancelled run as cancelled instead of blocked while keeping its recorded error', () => {
  render(<RunReport work={{ ...work, status: 'cancelled', summary: 'Work order cancelled' }} />);
  expect(screen.queryByText(/Progress is blocked/)).not.toBeInTheDocument();
  const note = screen.getByText(/This run was cancelled after/);
  expect(note).toHaveTextContent('This run was cancelled after BUDGET_EXHAUSTED was recorded.');
  expect(note).toHaveTextContent('not a completed report');
});

it('does not count a successful check from another snapshot as passed', () => {
  render(
    <RunReport
      work={{
        ...work,
        evidence: {
          commit: 'a'.repeat(40),
          snapshot_digest: 'b'.repeat(64),
          profile_digest: 'c'.repeat(64),
          rules_version: '1',
          review: 'Review recorded with limitations',
          findings: [],
          security_policy_digest: '',
          security_exception_ids: [],
          source_digest: null,
          branch: null,
          pr_url: null,
          gates: [
            {
              command: ['npm', 'test'],
              exit_code: 0,
              output_digest: 'd'.repeat(64),
              snapshot_digest: 'e'.repeat(64),
            },
          ],
        },
      }}
    />,
  );
  expect(screen.getByText('0 / 1 passed on delivery snapshot')).toBeInTheDocument();
  expect(screen.getByText('Snapshot mismatch')).toBeInTheDocument();
});

it('retains excepted findings in the security report', () => {
  render(
    <RunReport
      work={{
        ...work,
        findings: [
          {
            fingerprint: 'finding-1',
            scanner: 'synthetic-scanner',
            category: 'configuration',
            severity: 'high',
            title: 'Synthetic exposure',
            path: 'example.yml',
            reference: null,
            line: 4,
            remediation: 'Restrict access',
            baseline: false,
            exception_id: 'exception-1',
          },
        ],
      }}
    />,
  );
  const results = screen.getByRole('region', { name: 'Security results' });
  expect(within(results).getByText('Synthetic exposure')).toBeInTheDocument();
  expect(within(results).getByText(/This finding remains part of the evidence/)).toBeInTheDocument();
});

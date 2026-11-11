import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import ReleasesPanel from '../ReleasesPanel';
import { createApi, type ReleaseCandidate } from '../api';

const original: ReleaseCandidate = {
  version: 1,
  id: 'synthetic-release-candidate',
  revision: 1,
  digest: 'a'.repeat(64),
  project_id: 'synthetic-project',
  work_id: 'synthetic-work',
  commit: 'b'.repeat(40),
  snapshot_digest: 'c'.repeat(64),
  package_version: '1.2.3',
  tag: 'v1.2.3',
  changelog: 'Synthetic checked correction',
  artifacts: [
    {
      version: 1,
      id: 'synthetic-source',
      name: 'source.tar.gz',
      digest: 'd'.repeat(64),
      media_type: 'application/gzip',
      size_bytes: 250,
    },
  ],
  required_checks: ['tests', 'security'],
  status: 'prepared',
  blockers: [],
  release_url: null,
  authorization_expires_at: null,
};
function connect(
  options: { empty?: boolean; blocked?: boolean; losePublish?: boolean; expired?: boolean } = {},
) {
  let current: ReleaseCandidate = {
    ...original,
    blockers: options.blocked
      ? ['Required CI tests are not successful on the exact commit']
      : options.expired
        ? ['RELEASE_AUTHORIZATION_EXPIRED: Authorize this candidate again before publication']
        : [],
    status: options.expired ? 'authorized' : original.status,
  };
  let publicationCalls = 0;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, request: RequestInit = {}) => {
      if (!request.method)
        return path.endsWith('/releases')
          ? Response.json({
              version: 1,
              items: options.empty && !writes.length ? [] : [current],
              truncated: false,
            })
          : Response.json(current);
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      writes.push({ path, body });
      if (path.endsWith('/authorize'))
        current = {
          ...current,
          revision: 2,
          status: 'authorized',
          authorization_expires_at: '2026-11-11T14:00:00Z',
          blockers: [],
        };
      if (path.endsWith('/publish')) {
        publicationCalls += 1;
        if (options.losePublish && publicationCalls === 1)
          throw new TypeError('Synthetic lost publication response');
        current = {
          ...current,
          revision: 3,
          status: 'published',
          release_url: 'https://github.com/example/synthetic/releases/tag/v1.2.3',
        };
      }
      return Response.json(current);
    }),
  );
  return { api: createApi('synthetic-csrf'), writes };
}

it('prepares a checked candidate with explicit required CI and no publication action', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect({ empty: true });
  render(<ReleasesPanel api={api} work={{ id: 'synthetic-work', status: 'completed' }} />);
  await screen.findByText('No release candidate recorded for this run.');
  await user.click(screen.getByRole('button', { name: 'Prepare candidate' }));
  const dialog = screen.getByRole('dialog', { name: 'Prepare release candidate' });
  expect(within(dialog).getByRole('button', { name: 'Prepare immutable candidate' })).toBeDisabled();
  await user.type(within(dialog).getByLabelText('Package version'), '1.2.3');
  await user.type(within(dialog).getByLabelText('Required CI check names'), 'tests\nsecurity');
  await user.click(within(dialog).getByRole('button', { name: 'Prepare immutable candidate' }));
  await screen.findByText(/Immutable candidate prepared/);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    path: '/api/v1/releases',
    body: {
      version: 1,
      work_id: 'synthetic-work',
      package_version: '1.2.3',
      required_checks: ['tests', 'security'],
    },
  });
  expect(writes[0].body.idempotency_key).toEqual(expect.stringMatching(/^release-prepare:/));
});

it('authorizes the inspected digest separately and preserves publication receipt on a lost response', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect({ losePublish: true });
  render(<ReleasesPanel api={api} work={{ id: 'synthetic-work', status: 'completed' }} />);
  await user.click(await screen.findByRole('button', { name: 'Authorize exact candidate' }));
  const authorization = screen.getByRole('dialog', { name: 'Authorize exact release candidate' });
  expect(within(authorization).getByText(original.digest)).toBeInTheDocument();
  await user.click(
    within(authorization).getByRole('checkbox', {
      name: 'I authorize publication of this exact candidate digest.',
    }),
  );
  await user.click(within(authorization).getByRole('button', { name: 'Authorize this digest' }));
  await screen.findByText(/This exact candidate is authorized/);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    path: expect.stringMatching(/\/authorize$/),
    body: {
      version: 1,
      expected_revision: 1,
      candidate_digest: original.digest,
      authorize_publication: true,
      expires_seconds: 3600,
    },
  });
  await user.click(screen.getByRole('button', { name: 'Publish authorized candidate' }));
  const publication = screen.getByRole('dialog', { name: 'Publish release candidate' });
  expect(within(publication).getByRole('button', { name: 'Confirm publication' })).toBeDisabled();
  await user.type(within(publication).getByLabelText('Type v1.2.3 to confirm publication'), 'v1.2.3');
  await user.click(within(publication).getByRole('button', { name: 'Confirm publication' }));
  const retry = await within(publication).findByRole('button', { name: 'Retry exact publication' });
  await waitFor(() => expect(retry).toBeEnabled());
  await user.click(retry);
  await screen.findByText('Publication receipt confirmed for this candidate.');
  expect(writes).toHaveLength(3);
  expect(writes[1]).toEqual(writes[2]);
  expect(writes[1].body).toMatchObject({
    version: 1,
    expected_revision: 2,
    candidate_digest: original.digest,
  });
  expect(screen.getByRole('link', { name: 'Open recorded release' })).toHaveAttribute(
    'href',
    'https://github.com/example/synthetic/releases/tag/v1.2.3',
  );
});

it('keeps missing or failed commit checks as publication blockers', async () => {
  const { api, writes } = connect({ blocked: true });
  render(<ReleasesPanel api={api} work={{ id: 'synthetic-work', status: 'completed' }} />);
  await screen.findByText('Required CI tests are not successful on the exact commit');
  expect(screen.getByRole('button', { name: 'Authorize exact candidate' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Publish authorized candidate' })).toBeDisabled();
  expect(screen.getByText(original.commit)).toBeInTheDocument();
  expect(writes).toHaveLength(0);
});

it('does not prepare release artifacts from an active run', async () => {
  const { api } = connect({ empty: true });
  render(<ReleasesPanel api={api} work={{ id: 'synthetic-work', status: 'running' }} />);
  expect(screen.getByRole('button', { name: 'Prepare candidate' })).toBeDisabled();
  await screen.findByText('No release candidate recorded for this run.');
});

it('keeps candidate inspection while disconnect blocks pending owner authorization', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect();
  const work = { id: 'synthetic-work', status: 'completed' as const };
  const view = render(<ReleasesPanel api={api} work={work} connected />);
  await user.click(await screen.findByRole('button', { name: 'Authorize exact candidate' }));
  const dialog = screen.getByRole('dialog', { name: 'Authorize exact release candidate' });
  await user.click(
    within(dialog).getByRole('checkbox', { name: 'I authorize publication of this exact candidate digest.' }),
  );
  view.rerender(<ReleasesPanel api={api} work={work} connected={false} />);
  expect(within(dialog).getByRole('button', { name: 'Authorize this digest' })).toBeDisabled();
  expect(
    screen.getByText(/Disconnected. Candidate mutations and publication are unavailable/),
  ).toBeInTheDocument();
  expect(writes).toHaveLength(0);
});

it('allows explicit renewal of an expired grant while publication remains blocked', async () => {
  const user = userEvent.setup();
  const { api, writes } = connect({ expired: true });
  render(<ReleasesPanel api={api} work={{ id: 'synthetic-work', status: 'completed' }} />);
  const renew = await screen.findByRole('button', { name: 'Authorize exact candidate' });
  expect(renew).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Publish authorized candidate' })).toBeDisabled();
  await user.click(renew);
  const dialog = screen.getByRole('dialog', { name: 'Authorize exact release candidate' });
  await user.click(
    within(dialog).getByRole('checkbox', { name: 'I authorize publication of this exact candidate digest.' }),
  );
  await user.click(within(dialog).getByRole('button', { name: 'Authorize this digest' }));
  await screen.findByText(/This exact candidate is authorized/);
  expect(writes).toHaveLength(1);
  expect(writes[0].path).toMatch(/\/authorize$/);
});

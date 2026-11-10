import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import RepoCreations from '../RepoCreations';
import { createApi, type RepoCreationProposal } from '../api';

const proposal: RepoCreationProposal = {
  id: 'proposal-fixture',
  request: {
    owner_type: 'org',
    owner: 'fixture',
    name: 'example',
    description: 'Reviewed repository',
    visibility: 'public',
    initialize: false,
    idempotency_key: 'synthetic-request-id',
  },
  request_digest: 'b'.repeat(64),
  revision: 0,
  status: 'proposed',
  created_at: '2026-11-07T12:00:00Z',
  updated_at: '2026-11-07T12:00:00Z',
  approved_at: null,
  started_at: null,
  receipt: null,
  candidate: null,
  error_code: null,
};

function fixture(
  initial: RepoCreationProposal[] = [],
  options: { lostProposalResponse?: boolean; staleDecision?: boolean } = {},
) {
  let items = initial;
  let proposalCalls = 0;
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
      if (!init.method && path === '/repository-proposals') return Response.json({ items, truncated: false });
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ path, body });
      if (path === '/repository-proposals') {
        proposalCalls += 1;
        if (options.lostProposalResponse && proposalCalls === 1) throw new Error('Synthetic response loss');
        const next = {
          ...proposal,
          id: proposalCalls === 1 ? proposal.id : `${proposal.id}-${proposalCalls}`,
          request: body,
        } as RepoCreationProposal;
        items = [next];
        return Response.json(next);
      }
      if (path.endsWith('/decision'))
        return options.staleDecision
          ? Response.json({ message: 'La propuesta cambió o ya fue resuelta.' }, { status: 409 })
          : Response.json({
              ...proposal,
              status: body?.decision === 'reject' ? 'rejected' : 'approved',
              revision: 1,
              approved_at: body?.decision === 'reject' ? null : '2026-11-07T12:01:00Z',
            });
      if (path.endsWith('/reconcile'))
        return Response.json({
          ...proposal,
          status: 'reconciliation_required',
          revision: 4,
          candidate: {
            id: 42,
            full_name: 'fixture/example',
            url: 'https://github.com/fixture/example',
            visibility: 'public',
            created_at: '2026-11-07T12:01:00Z',
          },
        });
      throw new Error(`Unexpected fixture request ${path}`);
    }),
  );
  render(<RepoCreations api={createApi('synthetic-csrf')} />);
  return { user: userEvent.setup(), calls };
}

async function fillProposal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Propose repository' }));
  await user.type(screen.getByLabelText('GitHub owner'), 'fixture');
  await user.type(screen.getByLabelText('Repository name'), 'example');
  await user.selectOptions(screen.getByLabelText('Visibility'), 'public');
  await user.type(screen.getByLabelText('Description'), 'Reviewed repository');
}

it('separa propuesta local y aprobación vinculada al contenido y revision exactos', async () => {
  const { user, calls } = fixture();
  await fillProposal(user);
  await user.click(screen.getByRole('button', { name: 'Save proposal for review' }));
  const article = await screen.findByRole('article', { name: 'Propuesta fixture/example' });
  expect(within(article).getByText('Public')).toBeInTheDocument();
  expect(within(article).getByText('Reviewed repository')).toBeInTheDocument();
  expect(within(article).getByRole('button', { name: 'Approve and create' })).toBeDisabled();
  expect(calls).toHaveLength(1);
  await user.click(within(article).getByRole('checkbox', { name: /I reviewed these details/ }));
  await user.click(within(article).getByRole('button', { name: 'Approve and create' }));
  expect(await screen.findByText('Approved · queued')).toBeInTheDocument();
  expect(calls[1]).toEqual({
    path: '/repository-proposals/proposal-fixture/decision',
    body: { expected_revision: 0, request_digest: proposal.request_digest, decision: 'approve' },
  });
  expect(screen.queryByRole('link', { name: 'Open created repository' })).not.toBeInTheDocument();
});

it('reutiliza la clave de propuesta cuando se pierde la respuesta sin aprobar automáticamente', async () => {
  const { user, calls } = fixture([], { lostProposalResponse: true });
  await fillProposal(user);
  await user.click(screen.getByRole('button', { name: 'Save proposal for review' }));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button', { name: 'Save proposal for review' }));
  await screen.findByRole('article', { name: 'Propuesta fixture/example' });
  expect(calls).toHaveLength(2);
  expect(calls[0].body?.idempotency_key).toBe(calls[1].body?.idempotency_key);
  expect(calls.every((call) => call.path === '/repository-proposals')).toBe(true);
});

it('usa una nueva clave para otra propuesta explícita tras confirmar y rechazar la anterior', async () => {
  const { user, calls } = fixture();
  await fillProposal(user);
  await user.click(screen.getByRole('button', { name: 'Save proposal for review' }));
  await user.click(await screen.findByRole('button', { name: 'Reject proposal' }));
  await screen.findByText('Rejected');
  await user.click(screen.getByRole('button', { name: 'Propose repository' }));
  await user.click(screen.getByRole('button', { name: 'Save proposal for review' }));
  await screen.findByText('Awaiting your decision');
  const proposals = calls.filter((call) => call.path === '/repository-proposals');
  expect(proposals).toHaveLength(2);
  expect(proposals[0].body?.idempotency_key).not.toBe(proposals[1].body?.idempotency_key);
  expect(proposals[1].body).toEqual({
    ...proposals[0].body,
    idempotency_key: expect.any(String),
  });
  expect(screen.getAllByRole('article', { name: 'Propuesta fixture/example' })).toHaveLength(2);
});

it('rechaza la aprobación obsoleta y exige revisar de nuevo', async () => {
  const { user, calls } = fixture([proposal], { staleDecision: true });
  const checkbox = await screen.findByRole('checkbox', { name: /I reviewed these details/ });
  await user.click(checkbox);
  await user.click(screen.getByRole('button', { name: 'Approve and create' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('La propuesta cambió');
  expect(checkbox).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Approve and create' })).toBeDisabled();
  expect(calls).toHaveLength(1);
});

it('reconciliar conserva la incertidumbre y no convierte un candidato en éxito', async () => {
  const { user, calls } = fixture([{ ...proposal, status: 'reconciliation_required', revision: 3 }]);
  await user.click(await screen.findByRole('button', { name: 'Verify result on GitHub' }));
  await waitFor(() => expect(screen.getByText(/Observed fixture\/example/)).toBeInTheDocument());
  expect(screen.getByText('Unconfirmed result')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Approve and create' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Open created repository' })).not.toBeInTheDocument();
  expect(calls).toEqual([{ path: '/repository-proposals/proposal-fixture/reconcile', body: null }]);
});

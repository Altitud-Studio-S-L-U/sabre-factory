import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createApi, type DelegationCreate, type DelegationGrant, type Project } from '../api';
import InboundAccessPanel from '../InboundAccessPanel';

const project: Project = {
  id: 'synthetic-project',
  name: 'Synthetic project',
  repository: 'https://github.com/example/synthetic',
  profile: 'node',
  default_branch: 'main',
  gate_commands: [['npm', 'test']],
  allowed_mcp_servers: [],
  approved_baseline: [],
  browser_preview: null,
  created_at: '2026-11-11T12:00:00Z',
};
const secret = 'sabre_d_synthetic-one-time-test-secret';
const expires = '2099-11-11T13:00:00Z';
const limits = {
  principal: 'review-partner',
  projects: [project.id],
  operations: ['work.query' as const],
  expires_in: 3600,
  max_calls: 10,
  max_tokens: 20000,
  max_cost_usd: 0,
  active_seconds: 600,
  max_runs: 1,
};
const grant: DelegationGrant = {
  version: 1,
  id: 'synthetic-grant',
  principal: limits.principal,
  data: limits,
  expires_at: expires,
  revoked_at: null,
  created_at: '2026-11-11T12:00:00Z',
};
function setup({ lostResponse = false, existing = false, failedRevoke = false } = {}) {
  const writes: { path: string; method: string; body: DelegationCreate | null }[] = [];
  let issued = existing;
  let revoked = false;
  const fetch = vi.fn(async (input: string, request: RequestInit = {}) => {
    if (!request.method)
      return Response.json(issued ? [{ ...grant, revoked_at: revoked ? '2026-11-11T14:00:00Z' : null }] : []);
    if (request.method === 'POST') {
      const body = JSON.parse(String(request.body)) as DelegationCreate;
      writes.push({ path: input, method: request.method, body });
      const recovered = issued;
      issued = true;
      if (lostResponse && !recovered) throw new Error(`Synthetic lost response ${secret}`);
      return Response.json({
        version: 1,
        id: grant.id,
        principal: body.principal,
        token: recovered ? null : secret,
        expires_at: expires,
        recovered,
      });
    }
    writes.push({ path: input, method: request.method, body: null });
    if (failedRevoke) return Response.json({ message: `Synthetic rejected ${secret}` }, { status: 503 });
    revoked = true;
    return Response.json({ version: 1, id: grant.id, revoked: true, revoked_at: '2026-11-11T14:00:00Z' });
  });
  vi.stubGlobal('fetch', fetch);
  return { writes, fetch, api: createApi('synthetic-csrf') };
}
async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Issue access' }));
  const dialog = screen.getByRole('dialog', { name: 'Issue delegated access' });
  expect(within(dialog).getByRole('button', { name: 'Issue scoped credential' })).toBeDisabled();
  await user.type(within(dialog).getByLabelText('External principal'), limits.principal);
  await user.click(within(dialog).getByRole('checkbox', { name: project.name }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Inspect assigned runs' }));
  await user.click(within(dialog).getByRole('checkbox', { name: /I authorize/ }));
  return dialog;
}

it('issues only explicitly scoped finite access and clears the masked one-time secret on close and remount', async () => {
  const user = userEvent.setup();
  const { api, writes } = setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const view = render(<InboundAccessPanel api={api} projects={[project]} />);
  const dialog = await fill(user);
  expect(writes).toEqual([]);
  fireEvent.change(within(dialog).getByLabelText('Maximum admitted runs'), { target: { value: '0' } });
  expect(within(dialog).getByRole('button', { name: 'Issue scoped credential' })).toBeDisabled();
  fireEvent.change(within(dialog).getByLabelText('Maximum admitted runs'), { target: { value: '1' } });
  await user.click(within(dialog).getByRole('button', { name: 'Issue scoped credential' }));
  const receipt = await screen.findByRole('dialog', { name: 'Save the delegated credential' });
  const input = within(receipt).getByLabelText('New delegated credential');
  expect(input).toHaveAttribute('type', 'password');
  expect(input).toHaveValue(secret);
  expect(receipt.textContent).not.toContain(secret);
  expect(clipboard).not.toHaveBeenCalled();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({ version: 1, idempotency_key: expect.any(String), ...limits });
  await user.click(within(receipt).getByRole('button', { name: 'Reveal credential' }));
  expect(input).toHaveAttribute('type', 'text');
  await user.click(within(receipt).getByRole('button', { name: 'Copy credential' }));
  expect(clipboard).toHaveBeenCalledExactlyOnceWith(secret);
  await user.click(within(receipt).getByRole('button', { name: 'Close Save the delegated credential' }));
  expect(document.querySelector(`input[value="${secret}"]`)).toBeNull();
  expect(storage).not.toHaveBeenCalled();
  view.unmount();
  render(<InboundAccessPanel api={api} projects={[project]} />);
  await screen.findByText(limits.principal);
  expect(screen.queryByLabelText('New delegated credential')).not.toBeInTheDocument();
  expect(writes).toHaveLength(1);
});

it('retains the same request identity after an uncertain response and recovers metadata without reminting a credential', async () => {
  const user = userEvent.setup();
  const { api, writes } = setup({ lostResponse: true });
  render(<InboundAccessPanel api={api} projects={[project]} />);
  const dialog = await fill(user);
  await user.click(within(dialog).getByRole('button', { name: 'Issue scoped credential' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('A grant may already exist');
  expect(within(dialog).getByLabelText('External principal')).toBeDisabled();
  expect(dialog.textContent).not.toContain(secret);
  expect(writes).toHaveLength(1);
  await user.click(within(dialog).getByRole('button', { name: 'Retry same issuance request' }));
  const receipt = await screen.findByRole('dialog', { name: 'Save the delegated credential' });
  expect(await within(receipt).findByRole('status')).toHaveTextContent('original grant was recovered');
  expect(within(receipt).queryByLabelText('New delegated credential')).not.toBeInTheDocument();
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toEqual(writes[0].body);
  await user.click(within(receipt).getByRole('button', { name: 'Close Save the delegated credential' }));
  await user.click(screen.getByRole('button', { name: 'Revoke review-partner' }));
  const revoke = screen.getByRole('dialog', { name: 'Revoke delegated access?' });
  expect(writes).toHaveLength(2);
  await user.click(within(revoke).getByRole('button', { name: 'Confirm revocation' }));
  await screen.findByText('Revoked');
  expect(writes[2]).toEqual({ path: '/api/v1/delegations/synthetic-grant', method: 'DELETE', body: null });
});

it('retains a disconnected draft and blocks issuance and already-open revocation until reconnected', async () => {
  const user = userEvent.setup();
  const { api, writes } = setup();
  const view = render(<InboundAccessPanel api={api} projects={[project]} />);
  const dialog = await fill(user);
  view.rerender(<InboundAccessPanel api={api} projects={[project]} connected={false} />);
  expect(within(dialog).getByLabelText('External principal')).toHaveValue(limits.principal);
  expect(within(dialog).getByLabelText('External principal')).toBeDisabled();
  fireEvent.submit(within(dialog).getByRole('button', { name: 'Issue scoped credential' }).closest('form')!);
  expect(writes).toEqual([]);
  view.rerender(<InboundAccessPanel api={api} projects={[project]} connected />);
  await user.click(within(dialog).getByRole('button', { name: 'Issue scoped credential' }));
  const receipt = await screen.findByRole('dialog', { name: 'Save the delegated credential' });
  await user.click(within(receipt).getByRole('button', { name: 'Close Save the delegated credential' }));
  await user.click(screen.getByRole('button', { name: 'Revoke review-partner' }));
  view.rerender(<InboundAccessPanel api={api} projects={[project]} connected={false} />);
  const revoke = screen.getByRole('dialog', { name: 'Revoke delegated access?' });
  expect(within(revoke).getByRole('button', { name: 'Confirm revocation' })).toBeDisabled();
  fireEvent.click(within(revoke).getByRole('button', { name: 'Confirm revocation' }));
  expect(writes).toHaveLength(1);
  view.rerender(<InboundAccessPanel api={api} projects={[project]} connected />);
  await user.click(within(revoke).getByRole('button', { name: 'Confirm revocation' }));
  await screen.findByText('Revoked');
  expect(writes).toHaveLength(2);
});

it('keeps the original metadata on failed revocation and never echoes sensitive diagnostics', async () => {
  const user = userEvent.setup();
  const { api, writes } = setup({ existing: true, failedRevoke: true });
  render(<InboundAccessPanel api={api} projects={[project]} />);
  await user.click(await screen.findByRole('button', { name: 'Revoke review-partner' }));
  const dialog = screen.getByRole('dialog', { name: 'Revoke delegated access?' });
  await user.click(within(dialog).getByRole('button', { name: 'Confirm revocation' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be confirmed');
  expect(dialog.textContent).not.toContain(secret);
  expect(screen.getByText('Active until expiry')).toBeVisible();
  expect(writes).toHaveLength(1);
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Confirm revocation' })).toBeEnabled(),
  );
});

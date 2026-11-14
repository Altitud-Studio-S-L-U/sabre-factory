import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, type Api, type ConnectedRepositories, type GitHubConnectionView } from '../api';
import GitHubConnection from '../features/tools/GitHubConnection';
import GitHubRepositories from '../features/tools/GitHubRepositories';

const notConnected: GitHubConnectionView = {
  version: 1,
  state: 'not_connected',
  app: null,
  account: null,
  install_url: null,
  manage_url: null,
};
const app = {
  slug: 'sabre-factory-a1b2c3',
  name: 'SABRE Factory a1b2c3',
  url: 'https://github.com/apps/sabre-factory-a1b2c3',
  owner: 'octo-fixture',
};
const registered: GitHubConnectionView = {
  ...notConnected,
  state: 'registered',
  app,
  install_url: 'https://github.com/apps/sabre-factory-a1b2c3/installations/new',
};
const connected: GitHubConnectionView = {
  ...registered,
  state: 'connected',
  account: { login: 'octo-fixture', type: 'Organization', repository_selection: 'selected' },
  manage_url: 'https://github.com/organizations/octo-fixture/settings/installations/7001',
};
const reachable: ConnectedRepositories = {
  page: 1,
  next_page: null,
  total: 2,
  items: [
    {
      id: 502,
      full_name: 'octo-fixture/gadgets',
      url: 'https://github.com/octo-fixture/gadgets',
      default_branch: 'trunk',
      visibility: 'public',
    },
    {
      id: 501,
      full_name: 'octo-fixture/widgets',
      url: 'https://github.com/octo-fixture/widgets',
      default_branch: 'main',
      visibility: 'private',
    },
  ],
};
const STATE = 's'.repeat(43);

function fake(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  return {
    githubConnection: vi.fn(async () => notConnected),
    githubManifest: vi.fn(async () => ({
      action: `https://github.com/settings/apps/new?state=${STATE}`,
      manifest: '{"name":"SABRE Factory a1b2c3"}',
      state: STATE,
    })),
    githubConversion: vi.fn(async () => registered),
    githubInstallation: vi.fn(async () => connected),
    githubDisconnect: vi.fn(async () => ({ ...notConnected, app, manage_url: connected.manage_url })),
    githubConnectedRepositories: vi.fn(async () => reachable),
    ...overrides,
  };
}

function show(api: ReturnType<typeof fake>, online = true) {
  const onChanged = vi.fn();
  render(<GitHubConnection api={api as unknown as Api} online={online} onChanged={onChanged} />);
  return onChanged;
}

let submitted: HTMLFormElement[] = [];
beforeEach(() => {
  submitted = [];
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
    submitted.push(this);
  });
  window.history.replaceState(null, '', '/tools');
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('body > form').forEach((form) => form.remove());
});

it('explains the connection and posts the manifest to GitHub from the browser, pasting nothing', async () => {
  const user = userEvent.setup();
  const api = fake();
  const onChanged = show(api);
  expect(await screen.findByText('Not connected')).toBeVisible();
  expect(screen.getByText(/Nothing\s+is pasted/)).toBeVisible();
  expect(onChanged).toHaveBeenCalledWith(notConnected);
  await user.click(screen.getByRole('button', { name: 'Connect GitHub' }));
  expect(api.githubManifest).toHaveBeenCalledWith({ account: 'personal', organization: null });
  // One form with one field, sent to github.com and nowhere else.
  await waitFor(() => expect(submitted).toHaveLength(1));
  const [form] = submitted;
  expect(form.method).toBe('post');
  expect(form.action).toBe(`https://github.com/settings/apps/new?state=${STATE}`);
  expect(
    [...form.elements].map((field) => [(field as HTMLInputElement).name, (field as HTMLInputElement).value]),
  ).toEqual([['manifest', '{"name":"SABRE Factory a1b2c3"}']]);
});

it('asks which organization owns the app and refuses a destination that is not GitHub', async () => {
  const user = userEvent.setup();
  const api = fake({
    githubManifest: vi.fn(async () => ({
      action: 'https://github.example/settings/apps/new',
      manifest: '{}',
      state: STATE,
    })),
  });
  show(api);
  await screen.findByText('Not connected');
  expect(screen.queryByRole('textbox', { name: 'Organization' })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Owner of the app' }), 'organization');
  await user.type(screen.getByRole('textbox', { name: 'Organization' }), 'octo-fixture');
  await user.click(screen.getByRole('button', { name: 'Connect GitHub' }));
  expect(api.githubManifest).toHaveBeenCalledWith({ account: 'organization', organization: 'octo-fixture' });
  expect(await screen.findByRole('alert')).toHaveTextContent('GitHub could not be reached');
  expect(submitted).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
});

it('exchanges the code GitHub returns once, takes it out of the address and sends the owner to install the app', async () => {
  const user = userEvent.setup();
  window.history.replaceState(null, '', `/tools?github=registered&code=one-time-code&state=${STATE}`);
  const api = fake();
  const onChanged = show(api);
  expect(await screen.findByText('Not installed yet')).toBeVisible();
  expect(api.githubConversion).toHaveBeenCalledTimes(1);
  expect(api.githubConversion).toHaveBeenCalledWith({ code: 'one-time-code', state: STATE });
  expect(api.githubConnection).not.toHaveBeenCalled();
  // A reload or a copied link cannot replay the code.
  expect(window.location.pathname + window.location.search).toBe('/tools');
  expect(onChanged).toHaveBeenLastCalledWith(registered);
  expect(screen.getByRole('link', { name: 'Choose repositories on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/apps/sabre-factory-a1b2c3/installations/new',
  );
  await user.click(screen.getByRole('button', { name: 'I installed it' }));
  expect(api.githubInstallation).toHaveBeenCalledWith();
  expect(await screen.findByText('Connected')).toBeVisible();
});

it('checks the installation GitHub names on return and shows what the connection reaches', async () => {
  window.history.replaceState(null, '', '/tools?github=installed&installation_id=7001&setup_action=install');
  const api = fake();
  show(api);
  expect(await screen.findByText('Connected')).toBeVisible();
  expect(api.githubInstallation).toHaveBeenCalledWith({ installation_id: 7001 });
  expect(window.location.search).toBe('');
  const facts = screen.getByLabelText('GitHub connection', { selector: 'dl' });
  expect(within(facts).getByText('Account').closest('div')).toHaveTextContent('octo-fixture · organization');
  expect(within(facts).getByText('App').closest('div')).toHaveTextContent('SABRE Factory a1b2c3');
  await waitFor(() =>
    expect(within(facts).getByText('Repositories').closest('div')).toHaveTextContent(
      '2 repositories · selected on GitHub',
    ),
  );
  expect(
    within(screen.getByRole('list', { name: 'Repositories the connection reaches' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['octo-fixture/gadgets', 'octo-fixture/widgets']);
  expect(screen.getByRole('link', { name: 'Manage on GitHub' })).toHaveAttribute(
    'href',
    connected.manage_url,
  );
});

it('ignores an installation identifier that is not a number and lets the factory find the installation', async () => {
  window.history.replaceState(null, '', '/tools?github=installed&installation_id=7001%20OR%201');
  const api = fake();
  show(api);
  await screen.findByText('Connected');
  expect(api.githubInstallation).toHaveBeenCalledWith(undefined);
});

it('shows why a step failed and where the connection actually stands', async () => {
  window.history.replaceState(null, '', `/tools?github=registered&code=spent-code&state=${STATE}`);
  const api = fake({
    githubConversion: vi.fn(async () => {
      throw new ApiError(409, 'The registration code expired or was already used; connect again');
    }),
  });
  show(api);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The registration code expired or was already used',
  );
  expect(await screen.findByText('Not connected')).toBeVisible();
  expect(api.githubConnection).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe('');
});

it('disconnects after a confirmation that says nothing is revoked on GitHub', async () => {
  const user = userEvent.setup();
  const api = fake({ githubConnection: vi.fn(async () => connected) });
  const onChanged = show(api);
  await screen.findByText('Connected');
  await user.click(screen.getByRole('button', { name: 'Disconnect' }));
  const dialog = screen.getByRole('dialog', { name: 'Disconnect GitHub' });
  expect(dialog).toHaveTextContent('Nothing is revoked on GitHub');
  expect(api.githubDisconnect).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
  expect(api.githubDisconnect).toHaveBeenCalledTimes(1);
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent('Disconnected from this factory.');
  expect(within(status).getByRole('link', { name: 'Open it on GitHub' })).toHaveAttribute(
    'href',
    connected.manage_url,
  );
  expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeEnabled();
  expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'not_connected' }));
});

it('offers no change while the console is disconnected from the factory', async () => {
  show(fake(), false);
  await screen.findByText('Not connected');
  expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeDisabled();
});

it('lists the repositories the connection reaches for import instead of searching an account', async () => {
  const user = userEvent.setup();
  const api = {
    githubConnectedRepositories: vi.fn(async () => reachable),
    githubRepositories: vi.fn(),
    importGitHubRepository: vi.fn(async () => ({ name: 'Widgets' })),
  };
  render(
    <GitHubRepositories api={api as unknown as Api} enabled installed onChanged={async () => undefined} />,
  );
  expect(await screen.findByText(/2 repositories through the GitHub\s+connection/)).toBeVisible();
  // The account search belongs to the token path; with the connection it is not offered.
  expect(screen.queryByRole('button', { name: 'Search repositories' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Import octo-fixture/widgets' }));
  await user.type(screen.getByRole('textbox', { name: 'Delivery checks' }), '[["python", "-m", "unittest"]');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Project environment' }), 'python');
  await user.click(screen.getByRole('button', { name: 'Register project' }));
  expect(api.importGitHubRepository).toHaveBeenCalledWith({
    owner: 'octo-fixture',
    repository: 'widgets',
    name: 'widgets',
    profile: 'python',
    gate_commands: [['python', '-m', 'unittest']],
  });
  expect(api.githubRepositories).not.toHaveBeenCalled();
});

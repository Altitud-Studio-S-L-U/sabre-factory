import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createApi, type AgentDraftSave } from '../api';
import AgentsConsole from '../AgentsConsole';
import { agentCatalog } from './agentCatalogFixture';
import { configuration } from './modelConfigurationFixture';

function setup(conflict = false) {
  const catalog = agentCatalog();
  const writes: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, request: RequestInit = {}) => {
      if (input.endsWith('/model-configuration')) return Response.json(configuration());
      if (input.endsWith('/tools/catalog'))
        return Response.json({
          version: 1,
          items: [
            {
              name: 'read_source',
              description: 'Synthetic bounded source read',
              effect: 'read',
              roles: ['developer'],
              scope: 'workspace',
              source: 'builtin',
            },
            {
              name: 'security_report',
              description: 'Security specialist only',
              effect: 'read',
              roles: ['security'],
              scope: 'workspace',
              source: 'builtin',
            },
          ],
        });
      if (
        input.endsWith('/mcp-connections') ||
        input.endsWith('/a2a/agents') ||
        input.endsWith('/delegations')
      )
        return Response.json([]);
      if (request.method) {
        const body = JSON.parse(String(request.body));
        writes.push({ path: input, body });
        if (input.endsWith('/validate')) return Response.json({ valid: true, errors: [] });
        const entry = catalog.agents.find((item) => item.id === 'developer')!;
        if (input.endsWith('/publish')) {
          entry.revision++;
          entry.published = {
            version: entry.published.version + 1,
            digest: 'b'.repeat(64),
            definition: structuredClone(entry.draft),
          };
          entry.versions.push(entry.published);
          return Response.json(entry);
        }
        if (conflict)
          return Response.json(
            { message: 'The specialist changed. Your unsaved procedure must be compared.' },
            { status: 409 },
          );
        const change = body as AgentDraftSave;
        entry.revision++;
        entry.draft = {
          ...change.definition,
          skills: change.definition.skills ?? [],
          model: change.definition.model ?? null,
          tools: change.definition.tools ?? null,
          context: {
            max_input_bytes: change.definition.context?.max_input_bytes ?? 98304,
            visual_review: change.definition.context?.visual_review ?? false,
          },
        };
        return Response.json(entry);
      }
      return Response.json(catalog);
    }),
  );
  const api = createApi('synthetic-csrf');
  const view = render(<AgentsConsole api={api} projects={[]} />);
  return { catalog, writes, api, view };
}

it('shows all seven registered specialties, keyboard tabs and the developer architecture / implementation chain', async () => {
  setup();
  const user = userEvent.setup();
  const list = await screen.findByRole('complementary', { name: 'Local specialists' });
  expect(within(list).getAllByRole('button')).toHaveLength(7);
  for (const name of ['PM', 'Designer', 'Developer', 'QA', 'Supervisor', 'DevOps', 'CISO'])
    expect(within(list).getByRole('button', { name: new RegExp(name) })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: 'Chain' }));
  expect(screen.getByRole('heading', { name: 'architecture' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'implementation' })).toBeVisible();
  const tab = screen.getByRole('tab', { name: 'Chain' });
  tab.focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('tab', { name: 'Instructions & skills' })).toHaveFocus();
  expect(screen.getByRole('tab', { name: 'Instructions & skills' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('Instructions')).toHaveAttribute('readonly');
});

it('keeps a saved draft separate from the immutable published procedure until explicit publication', async () => {
  const { writes, catalog } = setup();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit Developer draft' });
  const instructions = within(dialog).getByLabelText('Instructions');
  await user.clear(instructions);
  await user.type(instructions, 'Synthetic changed handoff with evidence.');
  await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
  await screen.findByText(/Draft saved/);
  expect(catalog.agents.find((item) => item.id === 'developer')!.published.definition.instructions).toBe(
    'Synthetic published procedure for Developer.',
  );
  await user.click(screen.getByRole('tab', { name: 'Instructions & skills' }));
  expect(
    within(screen.getByRole('tabpanel', { name: 'Instructions & skills' })).getByLabelText('Instructions'),
  ).toHaveValue('Synthetic published procedure for Developer.');
  await user.click(screen.getByRole('tab', { name: 'Versions' }));
  await user.click(screen.getByRole('button', { name: 'Validate draft' }));
  await screen.findByText('Draft validation passed.');
  await user.click(screen.getByRole('button', { name: 'Publish version' }));
  await screen.findByText(/New immutable version published/);
  expect(screen.getByRole('button', { name: /Version 1/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /Version 2/ })).toBeVisible();
  await user.click(screen.getByRole('tab', { name: 'Instructions & skills' }));
  expect(
    within(screen.getByRole('tabpanel', { name: 'Instructions & skills' })).getByLabelText('Instructions'),
  ).toHaveValue('Synthetic changed handoff with evidence.');
  expect(writes).toHaveLength(3);
  expect((writes[0].body as AgentDraftSave).expected_revision).toBe(0);
});

it('retains a conflicting draft in its dialog and cannot grant tools outside the selected specialist roles', async () => {
  const { writes } = setup(true);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Edit draft' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit Developer draft' });
  await user.click(within(dialog).getByRole('checkbox', { name: 'Inherit runtime-authorized tools' }));
  expect(within(dialog).queryByRole('checkbox', { name: 'security_report' })).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('checkbox', { name: 'read_source' }));
  const instructions = within(dialog).getByLabelText('Instructions');
  await user.type(instructions, ' Retained synthetic draft.');
  await user.click(within(dialog).getByRole('button', { name: 'Save draft' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('unsaved procedure');
  expect(instructions).toHaveValue('Synthetic published procedure for Developer. Retained synthetic draft.');
  expect((writes[0].body as AgentDraftSave).definition.tools).toEqual(['read_source']);
  expect(writes).toHaveLength(1);
});

it('disables local mutations while disconnected and mounts the external specialist registry', async () => {
  const { view, api } = setup();
  const user = userEvent.setup();
  await screen.findByRole('button', { name: 'Edit draft' });
  view.rerender(<AgentsConsole api={api} projects={[]} connected={false} />);
  expect(screen.getByRole('button', { name: 'Edit draft' })).toBeDisabled();
  await user.click(screen.getByRole('tab', { name: 'External · MCP / A2A' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'External specialists' })).toBeVisible());
  expect(screen.getByRole('button', { name: 'Register A2A agent' })).toBeDisabled();
});

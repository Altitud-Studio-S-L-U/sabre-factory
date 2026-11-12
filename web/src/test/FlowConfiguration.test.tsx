import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createApi, type FlowConfiguration as Configuration } from '../api';
import FlowConfiguration from '../FlowConfiguration';
import { configuration } from './modelConfigurationFixture';
import { agentCatalog } from './agentCatalogFixture';

function setup(value: Configuration = { version: 1, repair_cycles: 2 }, published = true) {
  const models = configuration();
  models.default.name = 'synthetic-default';
  const role = models.roles.find((item) => item.role === 'developer')!;
  role.override = { ...models.default, name: 'synthetic-role' };
  role.effective = role.override;
  const catalog = agentCatalog();
  const developer = catalog.agents.find((item) => item.id === 'developer')!;
  developer.published.definition.model = published
    ? { ...models.default, name: 'synthetic-published' }
    : null;
  developer.draft.model = { ...models.default, name: 'synthetic-unpublished-draft' };
  const designer = catalog.agents.find((item) => item.id === 'designer')!;
  designer.published.definition.model = { ...models.default, name: 'synthetic-designer' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => Response.json(input.endsWith('/agents') ? catalog : models)),
  );
  const changed = vi.fn();
  const api = createApi('synthetic-csrf');
  const view = render(<FlowConfiguration api={api} mode="patch" value={value} onChange={changed} />);
  return { view, api, models, changed };
}

it('previews run, flow, published specialist and configured role precedence without using unpublished drafts', async () => {
  const { view, api, models, changed } = setup();
  const user = userEvent.setup();
  const summary = await screen.findByText('synthetic-published', { exact: false, selector: 'summary span' });
  const phase = summary.closest('details')!;
  expect(summary).toHaveTextContent('synthetic-published');
  expect(screen.queryByText(/synthetic-unpublished-draft/)).not.toBeInTheDocument();
  const flow = { ...models.default, name: 'synthetic-flow' };
  const run = { ...models.default, name: 'synthetic-run' };
  view.rerender(
    <FlowConfiguration
      api={api}
      mode="patch"
      value={{ version: 1, repair_cycles: 2, phases: { implementation: { model: flow, skills: [] } } }}
      onChange={changed}
    />,
  );
  expect(within(phase).getByText(/synthetic-flow/, { selector: 'summary span' })).toBeVisible();
  await user.click(within(phase).getByText('implementation', { selector: 'summary strong' }));
  await user.click(within(phase).getByRole('checkbox', { name: 'Override this phase for this run' }));
  expect(changed).toHaveBeenLastCalledWith({
    version: 1,
    repair_cycles: 2,
    phases: { implementation: { model: flow, skills: [] } },
    phase_models: { implementation: flow },
  });
  view.rerender(
    <FlowConfiguration
      api={api}
      mode="patch"
      value={{
        version: 1,
        repair_cycles: 2,
        phases: { implementation: { model: flow, skills: [] } },
        phase_models: { implementation: run },
      }}
      onChange={changed}
    />,
  );
  expect(within(phase).getByText(/synthetic-run/, { selector: 'summary span' })).toBeVisible();
  expect(within(phase).getByText(/Model source: Run phase override/)).toBeVisible();
});

it('falls back to the configured role then default and includes exact designer and delivery bindings only in applicable modes', async () => {
  const { view, api, changed } = setup(undefined, false);
  await screen.findByText(/synthetic-role/, { selector: 'summary span' });
  const verification = screen.getByText('verification', { selector: 'summary strong' }).closest('details')!;
  expect(
    within(verification).getByText(/synthetic-default/, { selector: 'summary span' }),
  ).toBeInTheDocument();
  expect(screen.getByText(/synthetic-designer/, { selector: 'summary span' })).toBeInTheDocument();
  expect(screen.getByText('delivery_preparation', { selector: 'summary strong' })).toBeInTheDocument();
  view.rerender(
    <FlowConfiguration api={api} mode="audit" value={{ version: 1, repair_cycles: 2 }} onChange={changed} />,
  );
  expect(screen.queryByText('ux', { selector: 'summary strong' })).not.toBeInTheDocument();
  expect(screen.queryByText('delivery_preparation', { selector: 'summary strong' })).not.toBeInTheDocument();
});

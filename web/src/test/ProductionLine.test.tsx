import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { createApi, type ProcessTopology, type WorkOrder } from '../api';
import ProductionLine, { runsAtStations } from '../features/agents/ProductionLine';
import topologies from '../../e2e/topology.json';

const lines = topologies as unknown as Record<string, ProcessTopology>;

function order(overrides: Partial<WorkOrder>): WorkOrder {
  return {
    id: 'run-one',
    objective: 'Synthetic objective',
    project_id: 'p',
    mode: 'patch',
    status: 'running',
    phase: 'implementation',
    ...overrides,
  } as WorkOrder;
}

function setup(orders: WorkOrder[]) {
  const reads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      reads.push(input);
      const mode = input.split('/').at(-2)!;
      return Response.json(lines[mode]);
    }),
  );
  render(
    <MemoryRouter>
      <ProductionLine api={createApi('csrf', () => undefined)} orders={orders} />
    </MemoryRouter>,
  );
  return reads;
}

it('places open runs at the station that owns their phase and ignores closed runs', () => {
  const stations = lines.patch.stations;
  const live = runsAtStations(stations, [
    order({ id: 'a', phase: 'task_clarification', status: 'waiting_input' }),
    order({ id: 'b', phase: 'review' }),
    order({ id: 'c', phase: 'review', status: 'completed' }),
  ]);
  expect(live.get('implement')?.map((item) => item.id)).toEqual(['a']);
  expect(live.get('review')?.map((item) => item.id)).toEqual(['b']);
});

it('draws the line for the mode of the open run and inspects the live station', async () => {
  const reads = setup([order({ mode: 'maintain', phase: 'implementation' })]);
  const list = await screen.findByRole('list', { name: 'Maintain stations' });
  expect(within(list).queryByRole('button', { name: /^Reproduce/ })).not.toBeInTheDocument();
  expect(within(list).getByRole('button', { name: /^Implement: Developer, 1 run here/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const inspector = screen.getByRole('complementary', { name: 'Station inspector' });
  expect(within(inspector).getByRole('heading', { name: 'Implement' })).toBeVisible();
  expect(within(inspector).getByRole('link', { name: 'Synthetic objective' })).toHaveAttribute(
    'href',
    '/runs/run-one',
  );
  expect(screen.getByText(/Repair loop · back to Implement/)).toBeInTheDocument();
  expect(reads).toEqual(['/api/v1/flows/maintain/topology']);
});

it('switches modes and explains deterministic stations without inventing a model', async () => {
  const user = userEvent.setup();
  setup([]);
  await screen.findByRole('list', { name: 'Patch stations' });
  await user.click(screen.getByRole('button', { name: 'Audit' }));
  const list = await screen.findByRole('list', { name: 'Audit stations' });
  expect(within(list).queryByRole('button', { name: /^Implement/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Repair loop/)).not.toBeInTheDocument();
  await user.click(within(list).getByRole('button', { name: /^Scope guard/ }));
  const inspector = screen.getByRole('complementary', { name: 'Station inspector' });
  expect(within(inspector).getByText('Deterministic code')).toBeVisible();
  expect(within(inspector).queryByText(/first match wins/)).not.toBeInTheDocument();
});

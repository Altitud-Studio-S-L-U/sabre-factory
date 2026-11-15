import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import type { BuiltinToolCatalog } from '../api';
import BuiltinTools from '../features/tools/BuiltinTools';

const tool = (
  name: string,
  roles: string[],
  changes: Partial<BuiltinToolCatalog['items'][number]> = {},
): BuiltinToolCatalog['items'][number] => ({
  name,
  description: `What ${name} does`,
  effect: 'read',
  roles,
  role_notes: {},
  scope: 'workspace',
  source: 'builtin',
  input_schema: {},
  ...changes,
});

// As the application answers: a tool three roles share, one only the developer has, and one that
// is defined differently for QA.
const items = [
  tool('read_context', ['analyst', 'developer', 'qa']),
  tool('edit_source', ['developer'], { effect: 'workspace_write' }),
  tool('execute', ['developer', 'qa'], {
    effect: 'workspace_write',
    description: 'Run an argv command in the isolated workspace.',
    role_notes: { qa: 'Run an approved check in a disposable copy.' },
  }),
];

const row = (name: string) => screen.getByRole('heading', { name }).closest('li')!;

it('lists every tool with who may call it, and what a tool is for a role that has its own definition', async () => {
  const user = userEvent.setup();
  render(<BuiltinTools items={items} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(within(row('read_context')).getByText('analyst · developer · qa')).toBeVisible();
  // With no specialist chosen, both definitions of the tool are shown.
  expect(within(row('execute')).getByText('Run an argv command in the isolated workspace.')).toBeVisible();
  expect(row('execute')).toHaveTextContent('For qa: Run an approved check in a disposable copy.');

  // For QA the list is what QA is given, and the tool reads as QA's.
  await user.selectOptions(screen.getByRole('combobox', { name: 'Specialist' }), 'qa');
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByRole('heading', { name: 'edit_source' })).not.toBeInTheDocument();
  expect(within(row('execute')).getByText('Run an approved check in a disposable copy.')).toBeVisible();
  expect(row('execute')).not.toHaveTextContent('Run an argv command');

  await user.selectOptions(screen.getByRole('combobox', { name: 'Specialist' }), 'developer');
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(within(row('execute')).getByText('Run an argv command in the isolated workspace.')).toBeVisible();
  expect(row('execute')).not.toHaveTextContent('approved check');
});

it('reads a catalog that carries no role notes', () => {
  const plain = items.map((item) => {
    const copy: Partial<typeof item> = { ...item };
    delete copy.role_notes;
    return copy as typeof item;
  });
  render(<BuiltinTools items={plain} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(row('execute')).not.toHaveTextContent('For qa');
});

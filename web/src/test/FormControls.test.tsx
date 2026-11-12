import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Field from '../components/FormField';
import Select from '../components/Select';

it('associates the label and hint with the native select and keeps its form behavior', async () => {
  const change = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <form aria-label="Configuration">
      <Field label="Ecosystem" hint="Choose the project stack.">
        <Select name="profile" defaultValue="node" onChange={change} required>
          <option value="node">JavaScript</option>
          <option value="python">Python</option>
        </Select>
      </Field>
    </form>,
  );
  const select = screen.getByRole('combobox', { name: 'Ecosystem' });
  expect(select).toHaveAccessibleDescription('Choose the project stack.');
  expect(select).toBeRequired();
  await user.selectOptions(select, 'python');
  expect(change).toHaveBeenCalledOnce();
  expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('profile')).toBe('python');
  rerender(
    <Field label="Ecosystem">
      <Select name="profile" disabled>
        <option>Python</option>
      </Select>
    </Field>,
  );
  expect(screen.getByLabelText('Ecosystem')).toBeDisabled();
});

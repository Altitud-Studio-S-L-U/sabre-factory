import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Field from '../components/FormField';
import Select from '../components/Select';

it('asocia etiqueta y ayuda con el select nativo y conserva su comportamiento de formulario', async () => {
  const change = vi.fn();
  const user = userEvent.setup();
  const { rerender } = render(
    <form aria-label="Configuration">
      <Field label="Ecosistema" hint="Elige el stack del proyecto.">
        <Select name="profile" defaultValue="node" onChange={change} required>
          <option value="node">JavaScript</option>
          <option value="python">Python</option>
        </Select>
      </Field>
    </form>,
  );
  const select = screen.getByRole('combobox', { name: 'Ecosistema' });
  expect(select).toHaveAccessibleDescription('Elige el stack del proyecto.');
  expect(select).toBeRequired();
  await user.selectOptions(select, 'python');
  expect(change).toHaveBeenCalledOnce();
  expect(new FormData(screen.getByRole('form') as HTMLFormElement).get('profile')).toBe('python');
  rerender(
    <Field label="Ecosistema">
      <Select name="profile" disabled>
        <option>Python</option>
      </Select>
    </Field>,
  );
  expect(screen.getByLabelText('Ecosistema')).toBeDisabled();
});

import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Button from '../components/Button';
import Input from '../components/Input';
import Textarea from '../components/Textarea';

it('shared controls preserve native form submission, refs and checkbox behavior', async () => {
  const submit = vi.fn();
  const input = createRef<HTMLInputElement>();
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit(new FormData(event.currentTarget));
      }}
    >
      <label>
        Objective
        <Input ref={input} name="objective" required />
      </label>
      <label>
        Notes
        <Textarea name="notes" rows={3} />
      </label>
      <label>
        Allow writes
        <Input name="writes" type="checkbox" />
      </label>
      <Button>Save controls</Button>
    </form>,
  );
  const user = userEvent.setup();
  input.current?.focus();
  expect(screen.getByRole('textbox', { name: 'Objective' })).toHaveFocus();
  await user.type(input.current!, 'Retain the contract');
  await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Recorded evidence');
  await user.click(screen.getByRole('checkbox', { name: 'Allow writes' }));
  await user.click(screen.getByRole('button', { name: 'Save controls' }));
  expect(submit).toHaveBeenCalledTimes(1);
  const payload = submit.mock.calls[0][0] as FormData;
  expect(payload.get('objective')).toBe('Retain the contract');
  expect(payload.get('notes')).toBe('Recorded evidence');
  expect(payload.get('writes')).toBe('on');
});

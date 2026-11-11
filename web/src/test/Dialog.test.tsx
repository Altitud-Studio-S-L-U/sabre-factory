import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Dialog from '../components/Dialog';

it('labels the native modal, protects a dirty draft and restores the launching focus', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const trigger = document.createElement('button');
  trigger.textContent = 'Launch';
  document.body.append(trigger);
  trigger.focus();
  const view = render(
    <Dialog open title="Edit connection" description="Review its destination" dirty onClose={close}>
      <input aria-label="Endpoint" />
    </Dialog>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Edit connection' });
  expect(dialog).toHaveAccessibleDescription('Review its destination');
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.queryByText('Discard your unsaved changes?')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Close Edit connection' }));
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(close).toHaveBeenCalledOnce();
  view.rerender(
    <Dialog open={false} title="Edit connection" onClose={close}>
      <input />
    </Dialog>,
  );
  expect(trigger).toHaveFocus();
  trigger.remove();
});

it('blocks Escape and backdrop dismissal while an operation is pending', () => {
  const close = vi.fn();
  render(
    <Dialog open title="Saving" busy onClose={close}>
      <p>Pending write</p>
    </Dialog>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Saving' });
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  fireEvent.click(dialog);
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Close Saving' })).toBeDisabled();
});

it('locks an existing discard confirmation when saving starts', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const view = render(
    <Dialog open title="Edit procedure" dirty onClose={close}>
      <p>Draft</p>
    </Dialog>,
  );
  await user.click(screen.getByRole('button', { name: 'Close Edit procedure' }));
  expect(screen.getByRole('button', { name: 'Discard changes' })).toBeEnabled();
  view.rerender(
    <Dialog open title="Edit procedure" dirty busy onClose={close}>
      <p>Saving draft</p>
    </Dialog>,
  );
  const discard = screen.getByRole('button', { name: 'Discard changes' });
  expect(discard).toBeDisabled();
  await user.click(discard);
  expect(close).not.toHaveBeenCalled();
});

it('captures the current launcher only when a previously closed dialog opens', () => {
  const old = document.createElement('button');
  const launcher = document.createElement('button');
  document.body.append(old, launcher);
  old.focus();
  const close = vi.fn();
  const view = render(
    <Dialog open={false} title="Connection" onClose={close}>
      <input aria-label="Destination" />
    </Dialog>,
  );
  launcher.focus();
  view.rerender(
    <Dialog open title="Connection" onClose={close}>
      <input aria-label="Destination" />
    </Dialog>,
  );
  screen.getByLabelText('Destination').focus();
  view.rerender(
    <Dialog open={false} title="Connection" onClose={close}>
      <input aria-label="Destination" />
    </Dialog>,
  );
  expect(launcher).toHaveFocus();
  old.remove();
  launcher.remove();
});

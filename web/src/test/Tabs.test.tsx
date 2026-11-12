import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import Tabs from '../components/Tabs';

it('emits one controlled value change for a pointer activation', async () => {
  const change = vi.fn();
  function Fixture() {
    const [value, setValue] = useState('one');
    return (
      <Tabs
        items={[
          { value: 'one', label: 'One' },
          { value: 'two', label: 'Two' },
        ]}
        value={value}
        onChange={(next) => {
          change(next);
          setValue(next);
        }}
        label="Controlled"
      >
        {(active) => active}
      </Tabs>
    );
  }
  render(<Fixture />);
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Two' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('two');
});

it('keeps one selected panel and keyboard focus through wrap, Home and End', async () => {
  function Fixture() {
    const [tab, setTab] = useState('Process');
    return (
      <Tabs
        items={['Process', 'Review', 'Limits'].map((value) => ({ value, label: value }))}
        value={tab}
        onChange={setTab}
        label="Run views"
      >
        {(active) => <h2>{active} content</h2>}
      </Tabs>
    );
  }
  render(<Fixture />);
  const user = userEvent.setup();
  const process = screen.getByRole('tab', { name: 'Process' });
  process.focus();
  await user.keyboard('{ArrowLeft}');
  expect(screen.getByRole('tab', { name: 'Limits' })).toHaveFocus();
  expect(screen.getByRole('tabpanel', { name: 'Limits' })).toHaveTextContent('Limits content');
  await user.keyboard('{Home}');
  expect(process).toHaveFocus();
  expect(process).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{End}');
  expect(screen.getByRole('tab', { name: 'Limits' })).toHaveFocus();
  await user.click(screen.getByRole('tab', { name: 'Review' }));
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  expect(screen.getByRole('tabpanel', { name: 'Review' })).toHaveTextContent('Review content');
  expect(screen.getByRole('tab', { name: 'Process' })).toHaveAttribute('tabindex', '-1');
});

import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import UsageMeter from '../components/UsageMeter';

test('meter retains its named quota and full recorded usage when consumption exceeds its ceiling', () => {
  render(<UsageMeter label="Tokens" value={1200} max={1000} />);
  const meter = screen.getByRole('meter', { name: 'Tokens' });
  expect(meter).toHaveAttribute('max', '1000');
  expect(meter).toHaveAttribute('value', '1000');
  expect(meter).toHaveAttribute('aria-valuetext', '1,200 used of 1,000');
  expect(screen.getByText('120% of run ceiling')).toBeVisible();
});

test('uncapped and zero allowances do not display a misleading consumption bar', () => {
  render(
    <>
      <UsageMeter label="Model calls" value={44} max={null} />
      <UsageMeter label="Recorded API cost" value={0} max={0} currency />
    </>,
  );
  expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  expect(screen.getByText('44')).toBeVisible();
  expect(screen.getByText('No cumulative ceiling')).toBeVisible();
  expect(screen.getByText('No allowance')).toBeVisible();
});

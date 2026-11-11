import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import BudgetBlockReason from '../BudgetBlockReason';

it('distinguishes an unconsumed next-call reservation from measured usage', () => {
  render(
    <BudgetBlockReason
      denial={{
        version: 1,
        metric: 'tokens',
        basis: 'next_reservation',
        used: 237197,
        reserved: 0,
        requested: 80000,
        required: 317197,
        limit: 300000,
      }}
    />,
  );
  expect(screen.getByText(/Next step does not fit/)).toBeInTheDocument();
  expect(screen.getByText(/not consumed usage/)).toBeInTheDocument();
  expect(screen.getByText('237,197')).toBeInTheDocument();
  expect(screen.getByText('80,000')).toBeInTheDocument();
  expect(screen.getByText('317,197')).toBeInTheDocument();
});

it('does not infer an old blocking request from current counters', () => {
  render(
    <BudgetBlockReason
      denial={{
        version: 1,
        metric: 'unknown',
        basis: 'historical_unknown',
        used: null,
        reserved: null,
        requested: null,
        required: null,
        limit: null,
      }}
    />,
  );
  expect(screen.getByText(/exact cause cannot be recovered/)).toBeInTheDocument();
  expect(screen.queryByText('Next step request')).not.toBeInTheDocument();
  expect(screen.queryByText(/ceiling reached/)).not.toBeInTheDocument();
});

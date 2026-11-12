import { useId, type ReactNode } from 'react';
import { cn } from '../lib/utils';

const integer = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Grid of meters; two columns once the container is wide enough. */
export function UsageMeterGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="@container">
      <div
        data-testid="usage-meter-grid"
        className={cn('grid grid-cols-1 gap-4 @[30rem]:grid-cols-2 @[30rem]:gap-6', className)}
      >
        {children}
      </div>
    </div>
  );
}

export default function UsageMeter({
  label,
  value,
  max,
  currency = false,
}: {
  label: string;
  value: number;
  max: number | null;
  currency?: boolean;
}) {
  const id = useId();
  const format = (amount: number) => (currency ? money.format(amount) : integer.format(amount));
  const bounded = max !== null && max > 0;
  const atLimit = bounded && value >= max;
  return (
    <div data-slot="usage-meter" className="min-w-0 rounded-lg border border-border bg-code p-4">
      <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 text-sm">
        <span id={id}>{label}</span>
        <strong className="text-base font-semibold tabular-nums [overflow-wrap:anywhere]">
          {format(value)}
          {max !== null && (
            <small className="text-xs font-normal text-muted-foreground"> / {format(max)}</small>
          )}
        </strong>
      </div>
      {bounded ? (
        <>
          <meter
            min={0}
            max={max}
            value={Math.min(value, max)}
            aria-labelledby={id}
            aria-valuetext={`${format(value)} used of ${format(max)}`}
            className={cn(
              'block h-3 w-full appearance-none overflow-hidden rounded-full border-0 bg-track',
              '[&::-webkit-meter-bar]:h-3 [&::-webkit-meter-bar]:rounded-full [&::-webkit-meter-bar]:border-0 [&::-webkit-meter-bar]:bg-track',
              '[&::-webkit-meter-optimum-value]:rounded-full [&::-moz-meter-bar]:rounded-full',
              atLimit
                ? '[&::-moz-meter-bar]:bg-danger [&::-webkit-meter-optimum-value]:bg-danger'
                : '[&::-moz-meter-bar]:bg-primary [&::-webkit-meter-optimum-value]:bg-primary',
            )}
          />
          <span className="mt-2.5 block text-xs text-muted-foreground">
            {Math.round((value / max) * 100)}% of run ceiling
          </span>
        </>
      ) : (
        <span className="mt-2.5 block text-xs text-muted-foreground">
          {max === null ? 'No cumulative ceiling' : 'No allowance'}
        </span>
      )}
    </div>
  );
}

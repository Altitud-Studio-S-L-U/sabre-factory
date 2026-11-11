import { useId } from 'react';
import './UsageMeter.css';

const integer = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

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
  return (
    <div className={`usage-meter${bounded && value >= max ? ' at-limit' : ''}`}>
      <div className="usage-meter-heading">
        <span id={id}>{label}</span>
        <strong>
          {format(value)}
          {max !== null && <small> / {format(max)}</small>}
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
          />
          <span className="usage-meter-caption">{Math.round((value / max) * 100)}% of run ceiling</span>
        </>
      ) : (
        <span className="usage-meter-caption">{max === null ? 'No cumulative ceiling' : 'No allowance'}</span>
      )}
    </div>
  );
}

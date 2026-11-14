import { useId, useState, type KeyboardEvent } from 'react';
import Disclosure from '../../components/Disclosure';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { cn } from '../../lib/utils';
import { OUTCOMES, countAxis, full, type Bucket } from './insights';

const sentence = (bucket: Bucket) =>
  `${bucket.label}: ${full(bucket.started)} ${bucket.started === 1 ? 'run' : 'runs'} created; ` +
  OUTCOMES.map((outcome) => `${full(bucket[outcome.key])} ${outcome.label.toLowerCase()}`).join(', ') +
  '.';

/**
 * Runs created in each period, stacked by what became of them. The row above the plot is the
 * legend and the readout in one: it names each series and shows the totals of the window, or of
 * the period under the pointer or the arrow keys. Every value is also in the table below.
 */
export default function OutcomeChart({ buckets, window }: { buckets: Bucket[]; window: string }) {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const largest = Math.max(0, ...buckets.map((bucket) => bucket.started));
  const { top, ticks } = countAxis(largest);
  const current = active === null ? null : buckets[active];
  const totals = OUTCOMES.map((outcome) => buckets.reduce((sum, bucket) => sum + bucket[outcome.key], 0));
  const weekly = buckets.some((bucket) => bucket.label.includes('–'));
  const marks = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].filter(
    (index, position, all) => index >= 0 && all.indexOf(index) === position,
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = buckets.length - 1;
    const from = active ?? last;
    const next =
      event.key === 'ArrowLeft'
        ? Math.max(0, from - 1)
        : event.key === 'ArrowRight'
          ? Math.min(last, from + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (event.key === 'Escape') setActive(null);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={titleId} className="text-base font-medium">
          Runs by outcome
        </h3>
        <p className="text-xs text-muted-foreground">
          {weekly ? 'Per week' : 'Per day'}, by the UTC day each run was created
        </p>
      </div>
      <div className="grid min-h-12 content-start gap-1">
        <p className="text-sm font-medium" data-testid="outcome-period">
          {current ? current.label : window}
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Series">
          {OUTCOMES.map((outcome, index) => (
            <li key={outcome.key} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-[3px]', outcome.swatch)} />
              <strong className="font-semibold tabular-nums">
                {full(current ? current[outcome.key] : totals[index])}
              </strong>
              <span className="text-muted-foreground">{outcome.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="sr-only" aria-live="polite">
        {current ? sentence(current) : ''}
      </p>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div
          className="relative h-44 w-7 text-right text-xs text-muted-foreground tabular-nums"
          aria-hidden="true"
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 leading-none"
              style={{ bottom: `${(tick / top) * 100}%` }}
            >
              {full(tick)}
            </span>
          ))}
        </div>
        <div
          role="group"
          tabIndex={0}
          aria-labelledby={titleId}
          aria-describedby={`${titleId}-keys`}
          data-testid="outcome-plot"
          className="relative h-44 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          onKeyDown={onKeyDown}
          onFocus={() => setActive((value) => value ?? buckets.length - 1)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              aria-hidden="true"
              className={cn(
                'absolute inset-x-0 border-t',
                tick === 0 ? 'border-border' : 'border-chart-grid',
              )}
              style={{ bottom: `${(tick / top) * 100}%` }}
            />
          ))}
          <div
            className="absolute inset-0 grid items-stretch"
            style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}
          >
            {buckets.map((bucket, index) => {
              const shown = OUTCOMES.filter((outcome) => bucket[outcome.key] > 0);
              return (
                <div
                  key={bucket.key}
                  data-active={index === active || undefined}
                  data-testid="outcome-column"
                  className="flex min-w-0 flex-col-reverse items-center px-px data-active:bg-hover/70"
                  onPointerEnter={() => setActive(index)}
                  onPointerDown={() => setActive(index)}
                >
                  {shown.map((outcome, position) => (
                    <span
                      key={outcome.key}
                      aria-hidden="true"
                      className={cn(
                        // The gap between segments is surface colour inside the box, so heights stay proportional.
                        'box-border w-full max-w-6 shrink-0 border-card',
                        outcome.swatch,
                        position > 0 && 'border-b-2',
                        position === shown.length - 1 && 'rounded-t-[4px]',
                      )}
                      style={{
                        height: `${(bucket[outcome.key] / top) * 100}%`,
                        minHeight: position > 0 ? 5 : 3,
                      }}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        <span />
        <div className="relative mt-1.5 h-4 text-xs text-muted-foreground" aria-hidden="true">
          {marks.map((index, position) => (
            <span
              key={index}
              className={cn(
                'absolute whitespace-nowrap',
                position === 0 && 'left-0',
                position > 0 && position < marks.length - 1 && 'left-1/2 -translate-x-1/2',
                position > 0 && position === marks.length - 1 && 'right-0',
              )}
            >
              {buckets[index].label}
            </span>
          ))}
        </div>
      </div>
      <p id={`${titleId}-keys`} className="sr-only">
        Use the left and right arrow keys to read each period. The table below lists every value.
      </p>
      <Disclosure summary="Show as a table" variant="plain">
        <Table label="Runs by outcome, as a table">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{weekly ? 'Week' : 'Day'}</TableHead>
              <TableHead scope="col" className="text-right">
                Created
              </TableHead>
              {OUTCOMES.map((outcome) => (
                <TableHead key={outcome.key} scope="col" className="text-right">
                  {outcome.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...buckets].reverse().map((bucket) => (
              <TableRow key={bucket.key}>
                <TableHead scope="row" className="font-normal whitespace-nowrap">
                  {bucket.label}
                </TableHead>
                <TableCell className="text-right tabular-nums">{full(bucket.started)}</TableCell>
                {OUTCOMES.map((outcome) => (
                  <TableCell key={outcome.key} className="text-right tabular-nums">
                    {full(bucket[outcome.key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Disclosure>
    </div>
  );
}

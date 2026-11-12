import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../lib/utils';

const columns = {
  never: 'grid-cols-[var(--term-width)_minmax(0,1fr)] gap-4',
  xs: '@xs:grid-cols-[var(--term-width)_minmax(0,1fr)] @xs:gap-4',
  sm: '@sm:grid-cols-[var(--term-width)_minmax(0,1fr)] @sm:gap-4',
  md: '@md:grid-cols-[var(--term-width)_minmax(0,1fr)] @md:gap-4',
};

export type Description = [term: ReactNode, value: ReactNode];

/** Term and value pairs; stacks on narrow containers. Empty values are skipped. */
export default function DescriptionList({
  items,
  className,
  termWidth = '9rem',
  label,
  stackBelow = 'md',
}: {
  items: (Description | false | null | undefined)[];
  className?: string;
  termWidth?: string;
  label?: string;
  /** Container width below which terms stack above values: xs 20rem, sm 24rem, md 28rem. */
  stackBelow?: 'xs' | 'sm' | 'md' | 'never';
}) {
  const rows = items.filter((item): item is Description => Boolean(item) && (item as Description)[1] != null);
  return (
    <dl
      aria-label={label}
      className={cn('@container grid min-w-0 gap-x-4 gap-y-2 text-sm', className)}
      style={{ '--term-width': termWidth } as CSSProperties}
    >
      {rows.map(([term, value], index) => (
        <div key={index} className={cn('grid min-w-0 gap-0.5', columns[stackBelow])}>
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

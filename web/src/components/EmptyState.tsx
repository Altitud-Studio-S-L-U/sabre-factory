import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export default function EmptyState({
  title,
  children,
  actions,
  className,
  as: Heading = 'h3',
}: {
  title: ReactNode;
  /** Heading level of the title within the page outline. */
  as?: 'h2' | 'h3' | 'h4';
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'grid justify-items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center',
        className,
      )}
    >
      <Heading className="text-base font-medium text-foreground">{title}</Heading>
      {children && <div className="max-w-[56ch] text-sm text-muted-foreground">{children}</div>}
      {actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

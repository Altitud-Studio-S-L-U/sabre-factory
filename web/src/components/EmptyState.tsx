import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export default function EmptyState({
  title,
  children,
  actions,
  className,
}: {
  title: ReactNode;
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
      <p className="text-base font-medium text-foreground">{title}</p>
      {children && <div className="max-w-[56ch] text-sm text-muted-foreground">{children}</div>}
      {actions && <div className="mt-3 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

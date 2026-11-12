import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export type StatTone = 'default' | 'primary' | 'warning' | 'success' | 'danger';

const valueTones: Record<StatTone, string> = {
  default: 'text-foreground',
  primary: 'text-primary',
  warning: 'text-warning',
  success: 'text-success',
  danger: 'text-danger',
};
const borderTones: Record<StatTone, string> = {
  default: 'border-border',
  primary: 'border-primary/40',
  warning: 'border-warning-border',
  success: 'border-border',
  danger: 'border-danger-border',
};

/** One summary figure: a label, a tabular value and an optional note. */
export default function StatTile({
  label,
  value,
  note,
  tone = 'default',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid min-w-0 content-start gap-1 rounded-xl border bg-card px-4 py-3.5',
        borderTones[tone],
        className,
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-[1.375rem] leading-tight font-semibold tabular-nums', valueTones[tone])}>
        {value}
      </span>
      {note && <span className="truncate text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/** Row of tiles that wraps by the space its container gets, not the viewport. */
export function StatGrid({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <section aria-label={label} className={cn('@container/stats', className)}>
      <div className="grid grid-cols-2 gap-3 @2xl/stats:grid-cols-4 @5xl/stats:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        {children}
      </div>
    </section>
  );
}

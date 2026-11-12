import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils';

export function Eyebrow({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('block text-xs font-medium tracking-wide text-muted-foreground uppercase', className)}
      {...props}
    />
  );
}

/** Top of a console section: one h1, an optional eyebrow, description and actions. */
export default function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
  titleId,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
}) {
  return (
    <header className={cn('flex min-w-0 flex-wrap items-start justify-between gap-4', className)}>
      <div className="grid min-w-0 gap-1.5">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 id={titleId} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
          {title}
        </h1>
        {description && <p className="max-w-[72ch] text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Heading inside a section, with an optional count or action on the right. */
export function SectionHeading({
  title,
  description,
  actions,
  as: Heading = 'h2',
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center justify-between gap-3', className)}>
      <div className="grid min-w-0 gap-1">
        <Heading id={id} className={cn('font-semibold', Heading === 'h2' ? 'text-lg' : 'text-base')}>
          {title}
        </Heading>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

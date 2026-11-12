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
  icon,
  iconTone = 'primary',
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  titleId?: string;
  /** Section mark shown in a chip beside the title. */
  icon?: ReactNode;
  iconTone?: 'primary' | 'memory';
}) {
  const heading = (
    <div className="grid min-w-0 gap-1.5">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h1 id={titleId} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
        {title}
      </h1>
      {description && <p className="max-w-[72ch] text-sm text-muted-foreground">{description}</p>}
    </div>
  );
  return (
    <header className={cn('flex min-w-0 flex-wrap items-start justify-between gap-4', className)}>
      {icon ? (
        <div className="flex min-w-0 items-center gap-3.5">
          <span
            aria-hidden="true"
            data-tone={iconTone}
            className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/40 bg-linear-to-br from-primary/25 to-primary/5 text-primary data-[tone=memory]:border-timeline-memory/45 data-[tone=memory]:from-timeline-memory/25 data-[tone=memory]:to-timeline-memory/5 data-[tone=memory]:text-timeline-memory [&_svg]:size-[1.375rem]"
          >
            {icon}
          </span>
          {heading}
        </div>
      ) : (
        heading
      )}
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
    <div className={cn('flex min-w-0 flex-wrap items-start justify-between gap-3', className)}>
      <div className="grid min-w-0 flex-1 basis-72 gap-1">
        <Heading id={id} className={cn('font-semibold', Heading === 'h2' ? 'text-lg' : 'text-base')}>
          {title}
        </Heading>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

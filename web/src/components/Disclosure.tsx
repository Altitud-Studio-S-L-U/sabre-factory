import type { ComponentProps, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Show-more content on the native <details> element: it works without script, is found by
 * the browser's find-in-page and announces its expanded state. One style for the console.
 */
export default function Disclosure({
  summary,
  meta,
  children,
  className,
  summaryClassName,
  contentClassName,
  variant = 'card',
  ...props
}: Omit<ComponentProps<'details'>, 'children'> & {
  summary: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  summaryClassName?: string;
  contentClassName?: string;
  /** card: bordered block; plain: inline, no frame. */
  variant?: 'card' | 'plain';
}) {
  return (
    <details
      data-slot="disclosure"
      className={cn('min-w-0', variant === 'card' && 'rounded-lg border border-border bg-card', className)}
      {...props}
    >
      <summary
        className={cn(
          'flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg text-sm font-medium select-none [&::-webkit-details-marker]:hidden',
          'hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          variant === 'card' ? 'px-4 py-2.5' : 'py-1.5',
          summaryClassName,
        )}
      >
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform [details[open]>summary>&]:rotate-90"
          aria-hidden="true"
        />
        {/* Direct child, so the summary text is the element's own text. */}
        {summary}
        {meta && (
          <span className="ml-auto shrink-0 pl-2 text-xs font-normal text-muted-foreground">{meta}</span>
        )}
      </summary>
      <div
        className={cn(
          'grid min-w-0 gap-3',
          variant === 'card' ? 'px-4 pt-1 pb-4' : 'pt-2 pl-6',
          contentClassName,
        )}
      >
        {children}
      </div>
    </details>
  );
}

import type { SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Native select with the console style. Native keeps long option lists, type-ahead,
 * mobile pickers and form semantics without a custom listbox.
 */
export default function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-grid w-full min-w-0 has-disabled:opacity-60">
      <select
        className={cn(
          'min-h-10 w-full min-w-0 appearance-none rounded-md border border-input bg-secondary py-2 pr-10 pl-3 text-sm text-foreground',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed',
          className,
        )}
        {...props}
      />
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
    </span>
  );
}

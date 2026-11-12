import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

/** Preformatted output: wraps long lines, scrolls past a height and is keyboard focusable. */
export default function CodeBlock({
  className,
  label,
  children,
  ...props
}: ComponentProps<'pre'> & { label?: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className={cn(
        'max-h-[28rem] min-w-0 overflow-auto rounded-md border border-border bg-code p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]',
        className,
      )}
      {...props}
    >
      {children}
    </pre>
  );
}

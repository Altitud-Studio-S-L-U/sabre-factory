import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/** Mutually exclusive filter buttons. Each option is a pressed/unpressed button in a named group. */
export default function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode; count?: number }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-lg border border-border bg-secondary/60 p-[3px]',
        className,
      )}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className="inline-flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[0.8125rem] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
        >
          {option.label}
          {option.count !== undefined && (
            <span
              aria-hidden="true"
              className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums"
            >
              {option.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

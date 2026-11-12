import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/utils';

/** Label, control and hint. The control receives the id and the hint reference. */
export default function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id: string; 'aria-describedby'?: string }>, {
        id,
        'aria-describedby': hint ? `${id}-hint` : undefined,
      })
    : children;
  return (
    <div data-slot="field" className={cn('grid min-w-0 content-start gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {control}
      {hint && (
        <small id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </small>
      )}
    </div>
  );
}

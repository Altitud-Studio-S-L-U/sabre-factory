import { useId, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../lib/utils';

/** A checkbox or radio with its label and an optional hint, as one large hit area. */
export default function CheckField({
  label,
  hint,
  className,
  type = 'checkbox',
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & {
  label: ReactNode;
  hint?: ReactNode;
  type?: 'checkbox' | 'radio';
}) {
  const hintId = useId();
  return (
    <label
      className={cn(
        'flex min-w-0 cursor-pointer items-start gap-2.5 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-60',
        className,
      )}
    >
      <input
        type={type}
        className="mt-0.5 size-4 shrink-0 accent-primary"
        aria-describedby={hint ? hintId : undefined}
        {...props}
      />
      <span className="grid min-w-0 gap-0.5">
        <span>{label}</span>
        {hint && (
          <small id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </small>
        )}
      </span>
    </label>
  );
}

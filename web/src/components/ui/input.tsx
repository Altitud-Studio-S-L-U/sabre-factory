// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
import * as React from 'react';

import { cn } from '../../lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'sf:flex sf:h-9 sf:w-full sf:rounded-md sf:border sf:border-input sf:bg-transparent sf:px-3 sf:py-1 sf:text-base sf:shadow-sm sf:transition-colors sf:file:border-0 sf:file:bg-transparent sf:file:text-sm sf:file:font-medium sf:file:text-foreground sf:placeholder:text-muted-foreground sf:focus-visible:outline-none sf:focus-visible:ring-1 sf:focus-visible:ring-ring sf:disabled:cursor-not-allowed sf:disabled:opacity-50 sf:md:text-sm',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };

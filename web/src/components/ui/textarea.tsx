// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
import * as React from 'react';

import { cn } from '../../lib/utils';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'sf:flex sf:min-h-[60px] sf:w-full sf:rounded-md sf:border sf:border-input sf:bg-transparent sf:px-3 sf:py-2 sf:text-base sf:shadow-sm sf:placeholder:text-muted-foreground sf:focus-visible:outline-none sf:focus-visible:ring-1 sf:focus-visible:ring-ring sf:disabled:cursor-not-allowed sf:disabled:opacity-50 sf:md:text-sm',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };

// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
import * as React from 'react';

import { cn } from '../../lib/utils';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-22 resize-y w-full min-w-0 rounded-md border border-input bg-secondary px-3 py-2 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-60',
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

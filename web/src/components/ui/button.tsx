// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'border-primary bg-primary font-semibold text-primary-foreground hover:enabled:bg-primary/90',
        destructive: 'border-danger-border bg-transparent text-danger hover:enabled:bg-danger-bg',
        outline: 'border-border bg-transparent text-foreground hover:enabled:bg-hover',
        secondary:
          'border-border bg-secondary text-foreground hover:enabled:border-input hover:enabled:bg-hover',
        ghost: 'border-transparent bg-transparent text-foreground hover:enabled:bg-hover',
        link: 'border-transparent bg-transparent text-link underline-offset-4 hover:enabled:underline',
      },
      size: {
        default: 'min-h-10 px-4 py-2',
        sm: 'min-h-8 px-3 py-1 text-xs',
        lg: 'min-h-11 px-6',
        icon: 'size-10 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };

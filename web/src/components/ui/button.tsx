// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'sf:inline-flex sf:items-center sf:justify-center sf:gap-2 sf:whitespace-nowrap sf:rounded-md sf:text-sm sf:font-medium sf:transition-colors sf:focus-visible:outline-none sf:focus-visible:ring-1 sf:focus-visible:ring-ring sf:disabled:pointer-events-none sf:disabled:opacity-50 sf:[&_svg]:pointer-events-none sf:[&_svg]:size-4 sf:[&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'sf:bg-primary sf:text-primary-foreground sf:shadow sf:hover:bg-primary/90',
        destructive:
          'sf:bg-destructive sf:text-destructive-foreground sf:shadow-sm sf:hover:bg-destructive/90',
        outline:
          'sf:border sf:border-input sf:bg-background sf:shadow-sm sf:hover:bg-accent sf:hover:text-accent-foreground',
        secondary: 'sf:bg-secondary sf:text-secondary-foreground sf:shadow-sm sf:hover:bg-secondary/80',
        ghost: 'sf:hover:bg-accent sf:hover:text-accent-foreground',
        link: 'sf:text-primary sf:underline-offset-4 sf:hover:underline',
      },
      size: {
        default: 'sf:h-9 sf:px-4 sf:py-2',
        sm: 'sf:h-8 sf:rounded-md sf:px-3 sf:text-xs',
        lg: 'sf:h-10 sf:rounded-md sf:px-8',
        icon: 'sf:h-9 sf:w-9',
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

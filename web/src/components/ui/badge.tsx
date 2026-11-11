// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'sf:inline-flex sf:items-center sf:rounded-md sf:border sf:px-2.5 sf:py-0.5 sf:text-xs sf:font-semibold sf:transition-colors sf:focus:outline-none sf:focus:ring-2 sf:focus:ring-ring sf:focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'sf:border-transparent sf:bg-primary sf:text-primary-foreground sf:shadow sf:hover:bg-primary/80',
        secondary:
          'sf:border-transparent sf:bg-secondary sf:text-secondary-foreground sf:hover:bg-secondary/80',
        destructive:
          'sf:border-transparent sf:bg-destructive sf:text-destructive-foreground sf:shadow sf:hover:bg-destructive/80',
        outline: 'sf:text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };

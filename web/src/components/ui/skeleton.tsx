// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
import { cn } from '../../lib/utils';

/**
 * One placeholder shape. A soft highlight sweeps across it; with reduced motion it stays still.
 * Shapes are decorative: the surrounding status region carries the accessible label.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-skeleton=""
      aria-hidden="true"
      className={cn(
        'relative overflow-hidden rounded-md bg-muted/80',
        'before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-linear-to-r before:from-transparent before:via-foreground/[0.07] before:to-transparent motion-reduce:before:hidden',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };

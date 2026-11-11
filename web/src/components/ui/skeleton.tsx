// Adapted from shadcn/ui New York registry (MIT). See infra/licenses/shadcn-ui.txt.
import { cn } from '../../lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-skeleton=""
      className={cn('sf:animate-pulse sf:rounded-md sf:bg-primary/10', className)}
      {...props}
    />
  );
}

export { Skeleton };

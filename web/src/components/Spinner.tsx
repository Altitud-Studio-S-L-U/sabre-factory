import { LoaderCircle } from 'lucide-react';
import { cn } from '../lib/utils';

/** Inline activity indicator. Decorative: pair it with visible or screen-reader text. */
export default function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn('size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none', className)}
    />
  );
}

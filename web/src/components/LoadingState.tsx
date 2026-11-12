import { LoaderCircle } from 'lucide-react';
import { Skeleton } from './ui/skeleton';

export default function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" data-slot="loading-state" className="grid gap-3.5 py-4 text-sm text-muted-foreground">
      <div className="flex items-center gap-2.5">
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <Skeleton aria-hidden="true" className="h-10 w-full max-w-90" />
    </div>
  );
}

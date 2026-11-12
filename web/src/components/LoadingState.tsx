import Spinner from './Spinner';

/**
 * Compact loading for a panel whose final shape is not known: a spinner and what is loading.
 * Screens with a known layout use the matching skeleton from components/Skeletons instead.
 */
export default function LoadingState({ label }: { label: string }) {
  return (
    <div
      role="status"
      data-slot="loading-state"
      className="flex min-h-12 items-center gap-2.5 py-3 text-sm text-muted-foreground"
    >
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

import { LoaderCircle } from 'lucide-react';
import { Skeleton } from './ui/skeleton';
import './LoadingState.css';

export default function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" className="loading-state">
      <div>
        <LoaderCircle size={16} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <Skeleton aria-hidden="true" className="loading-state-skeleton" />
    </div>
  );
}

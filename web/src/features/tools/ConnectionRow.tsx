import { useId, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import Button from '../../components/Button';
import { cn } from '../../lib/utils';

/**
 * One connection on the Tools page: what it is, its state and the actions that apply to it,
 * with its details on demand. Nothing has to be selected first to see or change a connection.
 */
export default function ConnectionRow({
  title,
  description,
  facts,
  badges,
  actions,
  open,
  onToggle,
  children,
}: {
  title: string;
  description: ReactNode;
  /** Short lines under the description: an endpoint, what a missing credential means. */
  facts?: ReactNode[];
  badges?: ReactNode;
  actions?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <li className="grid min-w-0 gap-3 px-4 py-4 sm:px-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 flex-1 basis-64 gap-1">
          <h3 className="text-base font-semibold [overflow-wrap:anywhere]">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
          {facts?.map(
            (fact, index) =>
              !!fact && (
                <p
                  key={index}
                  className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {fact}
                </p>
              ),
          )}
        </div>
        {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-label={`${open ? 'Hide details' : 'Details'} of ${title}`}
          onClick={onToggle}
        >
          {open ? 'Hide details' : 'Details'}
          <ChevronDown
            aria-hidden="true"
            className={cn('size-4 transition-transform', open && 'rotate-180')}
          />
        </Button>
      </div>
      {open && (
        <div
          id={id}
          role="group"
          aria-label={`${title} details`}
          className="grid min-w-0 gap-5 border-t border-border pt-4"
        >
          {children}
        </div>
      )}
    </li>
  );
}

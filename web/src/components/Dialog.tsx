import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import Button from './Button';
import { cn } from '../lib/utils';

/** Right-aligned row of dialog buttons, for forms that place actions in the body. */
export function DialogActions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap justify-end gap-2.5', className)}>{children}</div>;
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  dirty?: boolean;
  className?: string;
}

/** Native modal isolation keeps keyboard focus inside the active task. */
export default function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  busy = false,
  dirty = false,
  className = '',
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!open) {
      if (element.open) element.close();
      return;
    }
    const previous = document.activeElement;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open]);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscard(true);
    else {
      setDiscard(false);
      onClose();
    }
  };
  return (
    <dialog
      ref={ref}
      className={cn(
        'm-auto max-h-[calc(100dvh-1.25rem)] w-[min(45rem,calc(100vw-1.25rem))] overflow-auto rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-2xl sm:max-h-[calc(100dvh-3rem)] sm:w-[min(45rem,calc(100vw-2rem))]',
        'backdrop:bg-background/75 backdrop:backdrop-blur-sm',
        className,
      )}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy}
      onClose={() => setDiscard(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          requestClose();
          return;
        }
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button,input,textarea,select,a[href],[tabindex]',
          ),
        ).filter(
          (element) =>
            !element.matches(':disabled,[type="hidden"]') &&
            element.tabIndex >= 0 &&
            element.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (!first) {
          event.preventDefault();
          event.currentTarget.focus();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="grid">
        <header className="flex items-start justify-between gap-4 border-b border-border p-4.5 sm:gap-6 sm:p-6">
          <div className="grid min-w-0 gap-2">
            <h2 id={titleId} className="text-xl font-semibold">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="max-w-[55ch] text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Close ${title}`}
            disabled={busy}
            onClick={requestClose}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="min-w-0 p-4.5 sm:p-6">{children}</div>
        {discard && (
          <div
            className="mx-4.5 mb-4.5 flex flex-wrap items-center gap-2 rounded-lg border border-warning-border bg-warning-bg p-4 text-warning sm:mx-6 sm:mb-6"
            role="alert"
          >
            <p className="mr-auto">Discard your unsaved changes?</p>
            <Button disabled={busy} onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                setDiscard(false);
                onClose();
              }}
            >
              Discard changes
            </Button>
          </div>
        )}
        {footer && (
          <footer className="flex flex-wrap justify-end gap-2.5 border-t border-border bg-background/40 px-4.5 py-3.5 sm:px-6 sm:py-4">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}

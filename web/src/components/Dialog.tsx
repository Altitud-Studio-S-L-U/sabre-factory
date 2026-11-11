import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './Dialog.css';

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
      className={`console-dialog ${className}`}
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
      <div className="dialog-shell">
        <header className="dialog-heading">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button
            type="button"
            className="button small"
            aria-label={`Close ${title}`}
            disabled={busy}
            onClick={requestClose}
          >
            Close
          </button>
        </header>
        <div className="dialog-content">{children}</div>
        {discard && (
          <div className="dialog-discard" role="alert">
            <p>Discard your unsaved changes?</p>
            <button type="button" className="button" disabled={busy} onClick={() => setDiscard(false)}>
              Keep editing
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => {
                if (busy) return;
                setDiscard(false);
                onClose();
              }}
            >
              Discard changes
            </button>
          </div>
        )}
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </dialog>
  );
}

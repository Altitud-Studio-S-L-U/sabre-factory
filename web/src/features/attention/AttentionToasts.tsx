import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, OctagonAlert, X } from 'lucide-react';
import type { OwnerConfirmation, WorkOrder } from '../../api';
import Button from '../../components/Button';
import RoutedLink from '../../components/RoutedLink';
import { buttonVariants } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import { runPath } from '../runs/RunsTable';
import { remember, remembered, runTransition, type AttentionToast } from './attention';

/** How long a toast stays. Nothing is lost when it leaves: decisions stay in the inbox and runs in their list. */
export const TOAST_MS = 9000;
const VISIBLE = 3;

const tones = {
  success: { border: 'border-success-border', text: 'text-success', icon: CheckCircle2 },
  warning: { border: 'border-warning-border', text: 'text-warning', icon: AlertTriangle },
  danger: { border: 'border-danger-border', text: 'text-danger', icon: OctagonAlert },
};

/**
 * Turns what changed since the last look into toasts: a request an agent has just filed, and a
 * run that finished, failed, blocked or asked a question while the console was open. What was
 * already there when the console loaded is not announced again.
 */
export function useAttentionToasts({
  orders,
  confirmations,
  ready,
  inboxOpen,
}: {
  orders: Pick<WorkOrder, 'id' | 'objective' | 'status' | 'error_code'>[];
  confirmations: OwnerConfirmation[];
  ready: boolean;
  inboxOpen: boolean;
}) {
  const [toasts, setToasts] = useState<AttentionToast[]>([]);
  const statuses = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    if (!ready) return;
    const next: AttentionToast[] = [];
    const before = statuses.current;
    if (before)
      for (const order of orders)
        next.push(...[runTransition(order, before.get(order.id))].filter((toast) => toast !== null));
    statuses.current = new Map(orders.map((order) => [order.id, order.status]));

    const announced = remembered('announced');
    const fresh = confirmations.filter((item) => item.state === 'pending' && !announced.has(item.id));
    remember(
      'announced',
      fresh.map((item) => item.id),
    );
    if (!inboxOpen)
      for (const item of fresh)
        next.push({
          id: `confirmation:${item.id}`,
          tone: 'warning',
          title: 'An agent asks for your confirmation',
          text: item.summary,
          review: true,
        });
    // Deferred, so the effect itself never sets state synchronously.
    if (next.length)
      queueMicrotask(() =>
        setToasts((current) =>
          [...current.filter((toast) => !next.some((item) => item.id === toast.id)), ...next].slice(-VISIBLE),
        ),
      );
  }, [orders, confirmations, ready, inboxOpen]);

  const dismiss = (id: string) => setToasts((current) => current.filter((toast) => toast.id !== id));
  return { toasts, dismiss };
}

function Toast({
  toast,
  onDismiss,
  onReview,
}: {
  toast: AttentionToast;
  onDismiss: () => void;
  onReview: () => void;
}) {
  const [held, setHeld] = useState(false);
  const close = useRef(onDismiss);
  useEffect(() => {
    close.current = onDismiss;
  });
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => close.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [held]);
  const tone = tones[toast.tone];
  const Glyph = tone.icon;
  return (
    <li
      data-testid="attention-toast"
      data-tone={toast.tone}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-lg border bg-card px-3.5 py-3 text-sm shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2',
        tone.border,
      )}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <Glyph className={cn('mt-0.5 size-4 shrink-0', tone.text)} aria-hidden="true" />
      <div className="grid min-w-0 flex-1 gap-1">
        <strong className={cn('font-semibold', tone.text)}>{toast.title}</strong>
        <p className="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">{toast.text}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {toast.review && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                onReview();
                onDismiss();
              }}
            >
              Review
            </Button>
          )}
          {toast.run && (
            <RoutedLink
              className={buttonVariants({ variant: 'secondary', size: 'sm' })}
              to={runPath(toast.run)}
              onClick={onDismiss}
            >
              Open run
            </RoutedLink>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="-mt-1 -mr-1.5 size-7 shrink-0"
        aria-label={`Dismiss: ${toast.title}`}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </li>
  );
}

/** Short-lived notices in a corner of the screen. They never push the page and never hold a decision. */
export default function AttentionToasts({
  toasts,
  docked,
  onDismiss,
  onReview,
}: {
  toasts: AttentionToast[];
  /** The Supervisor panel is docked at the right edge: keep clear of it. */
  docked: boolean;
  onDismiss: (id: string) => void;
  onReview: () => void;
}) {
  return (
    <ul
      aria-label="Notifications"
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed inset-x-3 top-16 z-[70] grid gap-2 sm:left-auto sm:w-[23rem] lg:top-[4.75rem] lg:right-5',
        docked && 'lg:right-[calc(var(--supervisor-dock-width,440px)+1.25rem)]',
      )}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} onReview={onReview} />
      ))}
    </ul>
  );
}

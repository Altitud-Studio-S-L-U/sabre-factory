import type { ComponentProps, ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import { cn } from '../lib/utils';

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success' | 'neutral';

const tones: Record<NoticeTone, string> = {
  info: 'border-info-border bg-info-bg text-info',
  warning: 'border-warning-border bg-warning-bg text-warning',
  danger: 'border-danger-border bg-danger-bg text-danger',
  success: 'border-success-border bg-success-bg text-success',
  neutral: 'border-neutral-border bg-neutral-bg text-neutral',
};

const icons = {
  info: Info,
  warning: AlertTriangle,
  danger: OctagonAlert,
  success: CheckCircle2,
  neutral: Info,
};

/**
 * A status message. Pass `role="alert"` for errors that need immediate attention and
 * `role="status"` for polite updates; the default is a plain region of text.
 */
export default function Notice({
  tone = 'neutral',
  title,
  actions,
  icon = true,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
  tone?: NoticeTone;
  title?: ReactNode;
  actions?: ReactNode;
  icon?: boolean;
}) {
  const Glyph = icons[tone];
  return (
    <div
      data-slot="notice"
      data-tone={tone}
      className={cn(
        'flex min-w-0 items-start gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed',
        tones[tone],
        className,
      )}
      {...props}
    >
      {icon && <Glyph className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
      <div className="grid min-w-0 flex-1 gap-1 [overflow-wrap:anywhere]">
        {title && <strong className="font-semibold">{title}</strong>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

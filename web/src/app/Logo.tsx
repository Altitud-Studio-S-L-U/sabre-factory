/** SABRE mark: three slanted gold bars. Decorative; the wordmark carries the name. */
export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} aria-hidden="true" focusable="false">
      <g fill="var(--primary)">
        <path d="M7 4h4L6 24H2z" />
        <path d="M14 4h4l-5 20H9z" opacity="0.8" />
        <path d="M21 4h4l-5 20h-4z" opacity="0.6" />
      </g>
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark />
      <span className="flex flex-col leading-none">
        <span className="text-lg font-semibold tracking-[0.18em] text-foreground">SABRE</span>
        {!compact && <span className="mt-1 text-xs text-muted-foreground">Software factory</span>}
      </span>
    </span>
  );
}

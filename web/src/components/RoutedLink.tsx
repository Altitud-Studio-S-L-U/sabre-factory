import type { ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router';

/** A console link that also works where no router is mounted, as a plain anchor. */
export default function RoutedLink({
  to,
  state,
  className,
  onClick,
  children,
}: {
  to: string;
  /** What the destination should open with, such as a dialog. Carried only by the router. */
  state?: unknown;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return useInRouterContext() ? (
    <Link className={className} to={to} state={state} onClick={onClick}>
      {children}
    </Link>
  ) : (
    <a className={className} href={to} onClick={onClick}>
      {children}
    </a>
  );
}

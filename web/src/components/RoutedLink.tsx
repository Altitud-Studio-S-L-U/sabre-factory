import type { ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router';

/** A console link that also works where no router is mounted, as a plain anchor. */
export default function RoutedLink({
  to,
  className,
  onClick,
  children,
}: {
  to: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return useInRouterContext() ? (
    <Link className={className} to={to} onClick={onClick}>
      {children}
    </Link>
  ) : (
    <a className={className} href={to} onClick={onClick}>
      {children}
    </a>
  );
}

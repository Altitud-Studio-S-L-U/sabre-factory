import { Link } from 'react-router';
import { cn } from '../../lib/utils';
import { workAreas, type View } from '../../navigation';

const pages: { id: View; path: string; label: string }[] = [
  { id: 'work', path: '/runs', label: 'All runs' },
  ...workAreas,
];

/** Pages of the Runs area, styled like the console's tabs but navigating by address. */
export default function WorkAreaNav({ current }: { current: View }) {
  return (
    <nav aria-label="Runs area" className="mb-5">
      <ul className="flex w-full max-w-full items-stretch gap-0.5 overflow-x-auto overscroll-x-contain border-b border-border [scrollbar-width:thin]">
        {pages.map((page) => (
          <li key={page.id} className="flex">
            <Link
              to={page.path}
              aria-current={page.id === current ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex min-h-9 shrink-0 items-center whitespace-nowrap border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                page.id === current && 'border-primary text-foreground',
              )}
            >
              {page.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

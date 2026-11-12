import { useCallback, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import Icon from '../Icon';
import { cn } from '../lib/utils';
import type { NavigationItem, View } from '../navigation';
import CommandPalette, { usePaletteShortcut, type PaletteCommand } from './CommandPalette';
import { Logo } from './Logo';

export type Connection = 'connecting' | 'connected' | 'interrupted';

const connectionLabels: Record<Connection, string> = {
  connecting: 'Connecting',
  connected: 'Factory connected',
  interrupted: 'Connection interrupted',
};

const connectionDots: Record<Connection, string> = {
  connecting: 'bg-warning',
  connected: 'bg-success',
  interrupted: 'bg-danger',
};

const iconButton =
  'inline-flex size-10 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';

function shortBuild() {
  const build = import.meta.env.VITE_SABRE_BUILD as string | undefined;
  return build ? build.slice(0, 8) : null;
}

/**
 * Console frame. One navigation landmark: a sidebar from the lg breakpoint, a bottom tab
 * bar below it. The header carries the location, connection state and global actions.
 */
export default function AppShell({
  items,
  current,
  title,
  pending,
  connection,
  updated,
  refreshing,
  onRefresh,
  loggingOut,
  onLogout,
  onNavigate,
  commands,
  mainRef,
  actionSlot,
  children,
}: {
  items: NavigationItem[];
  current?: View;
  title: string;
  pending: number;
  connection: Connection;
  updated: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
  loggingOut: boolean;
  onLogout: () => void;
  onNavigate: () => void;
  commands: PaletteCommand[];
  mainRef: RefObject<HTMLElement | null>;
  /** Receives the header element where wide screens place the Supervisor launcher. */
  actionSlot?: (element: HTMLElement | null) => void;
  children: ReactNode;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  usePaletteShortcut(openPalette);
  const build = shortBuild();
  return (
    // The sidebar column keeps its surface below the sticky aside on long pages.
    <div className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:bg-[linear-gradient(to_right,var(--sidebar)_15rem,var(--background)_15rem)]">
      <a
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        href="#main-content"
      >
        Skip to content
      </a>
      <aside className="lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:border-r lg:border-sidebar-border lg:bg-sidebar">
        <div className="hidden px-5 pt-6 pb-5 lg:block">
          <Logo />
        </div>
        <nav
          aria-label="Main navigation"
          className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-sidebar-border bg-sidebar/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:static lg:flex lg:flex-col lg:gap-1 lg:border-0 lg:bg-transparent lg:px-3 lg:pb-0 lg:backdrop-blur-none"
        >
          {items.map((item) => {
            const active = current === item.id;
            return (
              <Link
                key={item.id}
                to={item.path}
                aria-current={active ? 'page' : undefined}
                onClick={onNavigate}
                className={cn(
                  'relative flex min-h-14 flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground lg:min-h-10 lg:flex-row lg:justify-start lg:gap-3 lg:rounded-md lg:px-3 lg:text-sm',
                  active && 'text-primary lg:bg-sidebar-accent lg:text-foreground',
                )}
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
                {item.id === 'work' && pending > 0 && (
                  <span className="absolute top-1.5 right-[calc(50%-1.5rem)] min-w-5 rounded-full bg-primary px-1.5 text-center text-xs leading-5 font-semibold text-primary-foreground lg:static lg:ml-auto">
                    {pending}
                    <span className="sr-only"> pending questions</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto hidden space-y-1 border-t border-sidebar-border px-5 py-4 text-xs text-muted-foreground lg:block">
          <p className="flex items-center gap-2">
            <span className={cn('size-2 rounded-full', connectionDots[connection])} aria-hidden="true" />
            {connectionLabels[connection]}
          </p>
          {build && <p className="font-mono">Build {build}</p>}
        </div>
      </aside>
      <div className="flex min-w-0 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0">
        <header className="sticky top-0 z-30 flex min-h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur lg:px-8">
          <span className="lg:hidden">
            <Logo compact />
          </span>
          <p className="hidden min-w-0 items-center gap-2 text-sm text-muted-foreground lg:flex">
            SABRE <span aria-hidden="true">/</span>
            <strong className="truncate font-semibold text-foreground">{title}</strong>
          </p>
          <div className="ml-auto flex items-center gap-1">
            <span
              className="mr-2 hidden items-center gap-2 text-xs text-muted-foreground md:flex"
              role="status"
            >
              <span
                className={cn('size-2 rounded-full lg:hidden', connectionDots[connection])}
                aria-hidden="true"
              />
              <span className="lg:hidden">{connectionLabels[connection]} · </span>
              {updated
                ? `Updated ${updated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
                : 'Synchronizing'}
            </span>
            {actionSlot && <div ref={actionSlot} className="contents" />}
            <button
              type="button"
              className="hidden min-h-9 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground sm:inline-flex"
              onClick={openPalette}
              aria-keyshortcuts="Control+K Meta+K"
            >
              <Icon name="search" size={15} />
              Search
              <kbd className="rounded border border-border px-1.5 font-mono text-xs">⌘K</kbd>
            </button>
            <button
              type="button"
              className={cn(iconButton, 'sm:hidden')}
              aria-label="Open command palette"
              onClick={openPalette}
            >
              <Icon name="search" size={17} />
            </button>
            <button
              type="button"
              className={iconButton}
              aria-label="Refresh data"
              title="Refresh data"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <Icon name="refresh" size={16} />
            </button>
            <button
              type="button"
              className={iconButton}
              aria-label="Sign out"
              title="Sign out"
              disabled={loggingOut}
              onClick={onLogout}
            >
              <Icon name="logout" size={17} />
            </button>
          </div>
        </header>
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="mx-auto w-full max-w-[98rem] min-w-0 flex-1 px-4 pt-5 pb-28 focus:outline-none sm:px-6 lg:px-8 lg:pt-3 lg:pb-24"
        >
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
    </div>
  );
}

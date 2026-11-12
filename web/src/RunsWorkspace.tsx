import { useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import type { Project, WorkOrder } from './api';
import Button from './components/Button';
import Select from './components/Select';
import { ACTIVE_STATUSES, ATTENTION_STATUSES, isClosed } from './runState';
import { cn } from './lib/utils';

const filters = [
  ['all', 'All'],
  ['active', 'Active'],
  ['attention', 'Attention'],
  ['finished', 'Closed'],
] as const;

const statusDots: Record<WorkOrder['status'], string> = {
  queued: 'bg-neutral',
  running: 'bg-info',
  waiting_input: 'bg-warning',
  paused: 'bg-warning',
  blocked: 'bg-warning',
  failed: 'bg-danger',
  cancelled: 'bg-neutral',
  completed: 'bg-success',
};

/**
 * Runs list beside the selected run. The layout follows the space the workspace gets (the
 * docked Supervisor narrows it): side by side from 60rem, stacked with a horizontal run strip below.
 */
export default function RunsWorkspace({
  orders,
  projects,
  selectedId,
  onOpen,
  onNew,
  connected = true,
  children,
}: {
  orders: WorkOrder[];
  projects: Project[];
  selectedId?: string | null;
  onOpen: (order: WorkOrder) => void;
  onNew: () => void;
  connected?: boolean;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  const [state, setState] = useState<(typeof filters)[number][0]>('all');
  const projectName = (order: WorkOrder) =>
    projects.find((project) => project.id === order.project_id)?.name ?? 'Project';
  const visible = orders.filter(
    (order) =>
      (!projectId || order.project_id === projectId) &&
      (!query ||
        `${order.objective} ${order.id} ${projectName(order)}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())) &&
      (state === 'all' ||
        (state === 'active' && ACTIVE_STATUSES.includes(order.status)) ||
        (state === 'attention' && ATTENTION_STATUSES.includes(order.status)) ||
        (state === 'finished' && isClosed(order))),
  );
  return (
    <div className="@container/runs">
      <div className="grid min-w-0 gap-6 @[60rem]/runs:grid-cols-[17.5rem_minmax(0,1fr)] @[60rem]/runs:gap-8">
        <aside
          aria-label="Runs"
          className="grid min-w-0 content-start gap-3 @[60rem]/runs:sticky @[60rem]/runs:top-20 @[60rem]/runs:max-h-[calc(100dvh-6rem)] @[60rem]/runs:grid-rows-[auto_auto_auto_auto_minmax(0,1fr)_auto]"
        >
          <header className="flex items-start justify-between gap-3">
            <div className="grid gap-0.5">
              <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
                Runs
              </h1>
              <span className="text-xs text-muted-foreground">{orders.length} recorded</span>
            </div>
            <Button type="button" size="sm" variant="primary" onClick={onNew} disabled={!connected}>
              + New run
            </Button>
          </header>
          <div className="relative">
            <label className="sr-only" htmlFor="run-search">
              Search runs
            </label>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              id="run-search"
              type="search"
              placeholder="Find a run or objective…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-h-10 w-full rounded-md border border-input bg-secondary py-2 pr-3 pl-9 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          </div>
          <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
            Project
            <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </label>
          <div
            role="group"
            aria-label="Filter runs"
            className="grid grid-cols-4 gap-1 rounded-md border border-border bg-secondary/60 p-1"
          >
            {filters.map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={state === value}
                onClick={() => setState(value)}
                className="min-h-8 cursor-pointer rounded-sm px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="-mx-1 grid auto-cols-[15rem] grid-flow-col gap-2 overflow-x-auto px-1 pb-1 @[60rem]/runs:auto-cols-auto @[60rem]/runs:grid-flow-row @[60rem]/runs:content-start @[60rem]/runs:overflow-x-visible @[60rem]/runs:overflow-y-auto">
            {visible.map((order) => (
              <button
                type="button"
                key={order.id}
                data-testid="run-card"
                aria-pressed={selectedId === order.id}
                onClick={() => onOpen(order)}
                className={cn(
                  'grid min-w-0 cursor-pointer gap-2 rounded-lg border border-border bg-card p-3.5 text-left transition-colors hover:bg-hover/50',
                  'aria-pressed:border-primary/70 aria-pressed:bg-accent',
                )}
              >
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <strong className="truncate text-sm font-semibold">{projectName(order)}</strong>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground uppercase">
                    {order.mode}
                  </span>
                </span>
                <span className="line-clamp-2 text-sm text-foreground/90">{order.objective}</span>
                <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5 capitalize">
                    <span
                      className={cn('size-1.5 rounded-full', statusDots[order.status])}
                      aria-hidden="true"
                    />
                    {order.status.replaceAll('_', ' ')}
                  </span>
                  <time dateTime={order.updated_at}>
                    {new Date(order.updated_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </span>
              </button>
            ))}
          </div>
          {!visible.length && (
            <div className="grid gap-1 rounded-lg border border-dashed border-border p-4 text-center">
              <strong className="text-sm font-medium">
                {orders.length ? 'No matching runs' : 'Your factory is ready for its first run'}
              </strong>
              <p className="text-xs text-muted-foreground">
                {orders.length
                  ? 'Change the filters to find another execution.'
                  : 'Connect a project, choose a flow and define its acceptance checks.'}
              </p>
            </div>
          )}
          <footer className="hidden gap-1 border-t border-border pt-3 text-xs text-muted-foreground @[60rem]/runs:grid">
            <span>One writer per project</span>
            <span>PR delivery requires verified evidence</span>
          </footer>
        </aside>
        <section className="@container/run min-w-0" aria-label="Selected run">
          {children}
        </section>
      </div>
    </div>
  );
}

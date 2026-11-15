import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, PanelsTopLeft, Search } from 'lucide-react';
import type { Api, Project, WorkOrder } from '../../api';
import Button from '../../components/Button';
import Select from '../../components/Select';
import PageHeader, { Eyebrow } from '../../components/PageHeader';
import SegmentedControl from '../../components/SegmentedControl';
import StatTile, { StatGrid } from '../../components/StatTile';
import { buttonVariants } from '../../components/ui/button';
import {
  ACTIVE_STATUSES,
  ATTENTION_STATUSES,
  isClosed,
  isMonitoring,
  pendingQuestions,
} from '../../runState';
import { cn } from '../../lib/utils';
import StageStrip from './StageStrip';
import { RunBadge, externalUrl, modeLabels, useAction } from './shared';

type Filter = 'all' | 'active' | 'attention' | 'finished';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const DAY = 86_400_000;

/** Wall clock for relative times, refreshed each minute; tests pass a fixed value instead. */
function useNow(fixed?: number) {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
}

export function runPath(id: string) {
  return `/runs/${encodeURIComponent(id)}`;
}

export function relativeTime(value: string, now = Date.now()) {
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(value).toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
}

function matches(order: WorkOrder, filter: Filter) {
  if (filter === 'active') return ACTIVE_STATUSES.includes(order.status);
  if (filter === 'attention') return ATTENTION_STATUSES.includes(order.status);
  if (filter === 'finished') return isClosed(order);
  return true;
}

/** Token use against the run's ceiling, or the measured total when the run has none. */
function Usage({ order }: { order: WorkOrder }) {
  const ceiling = order.budget.max_tokens;
  const ratio = ceiling ? Math.min(1, order.tokens_used / ceiling) : 0;
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="text-xs tabular-nums">
        <span className="font-medium text-foreground">{compact.format(order.tokens_used)}</span>
        <span className="text-muted-foreground">
          {ceiling ? ` / ${compact.format(ceiling)} tokens` : ' tokens · no ceiling'}
        </span>
      </span>
      {ceiling ? (
        <span
          role="meter"
          aria-label="Token budget used"
          aria-valuemin={0}
          aria-valuemax={ceiling}
          aria-valuenow={Math.min(order.tokens_used, ceiling)}
          className="h-1 w-24 overflow-hidden rounded-full bg-track"
        >
          <span
            className={cn('block h-full rounded-full', ratio >= 0.9 ? 'bg-warning' : 'bg-primary/80')}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}

function RowActions({
  api,
  order,
  connected,
  onChanged,
}: {
  api: Api;
  order: WorkOrder;
  connected: boolean;
  onChanged: () => Promise<void>;
}) {
  const action = useAction();
  const questions = pendingQuestions(order).length;
  const pr = externalUrl(order.evidence?.pr_url);
  const canPause = ACTIVE_STATUSES.includes(order.status) && !order.control && !isMonitoring(order);
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {questions > 0 && (
        <Link className={buttonVariants({ size: 'sm' })} to={runPath(order.id)}>
          Answer{questions > 1 ? ` (${questions})` : ''}
        </Link>
      )}
      {canPause && (
        <Button
          type="button"
          size="sm"
          disabled={!connected || action.busy}
          aria-label={`Pause run ${order.id.slice(0, 8)}`}
          onClick={() =>
            void action.run(async () => {
              await api.control(order.id, 'pause');
              await onChanged();
            })
          }
        >
          Pause
        </Button>
      )}
      {order.control && ACTIVE_STATUSES.includes(order.status) && (
        <span className="text-xs text-muted-foreground">
          {order.control === 'pause' ? 'Pause requested' : 'Cancellation requested'}
        </span>
      )}
      {pr && (
        <a
          className={buttonVariants({ size: 'sm', variant: 'secondary' })}
          href={pr}
          target="_blank"
          rel="noreferrer"
        >
          Review PR <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      )}
      <Link
        className={buttonVariants({ size: 'sm', variant: 'ghost' })}
        to={runPath(order.id)}
        aria-label={`Open run ${order.id.slice(0, 8)}`}
      >
        Open
      </Link>
      {action.error && (
        <span role="alert" className="basis-full text-right text-xs text-danger">
          {action.error}
        </span>
      )}
    </div>
  );
}

function FirstRun({ connected, onNew }: { connected: boolean; onNew: () => void }) {
  return (
    <div className="grid justify-items-start gap-4 rounded-xl border border-border bg-card p-8">
      <Eyebrow>Local software factory</Eyebrow>
      <h2 className="text-2xl font-semibold tracking-tight">Launch a verified process</h2>
      <p className="max-w-[60ch] text-sm text-muted-foreground">
        Choose a project, define acceptance checks and launch a registered process. Its phases, agents, tools,
        memory and evidence will appear here as the work progresses.
      </p>
      <ol className="flex flex-wrap items-center gap-1.5" aria-label="Process preview">
        {['Understand', 'Plan', 'Build', 'Verify', 'Review', 'Security', 'Deliver'].map((label, index) => (
          <li key={label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {index > 0 && <span aria-hidden="true">→</span>}
            <span className="rounded-md border border-dashed border-border px-2 py-1">{label}</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">Process preview only. No execution has started.</p>
      <Button type="button" variant="primary" disabled={!connected} onClick={onNew}>
        Create your first run
      </Button>
    </div>
  );
}

/**
 * Every run in one table: where it stands on the line, what it used and what it needs. On a narrow
 * container the same rows lay out as cards, so there is one DOM for every width.
 */
export default function RunsTable({
  api,
  orders,
  projects,
  connected = true,
  onNew,
  onChanged,
  now: fixedNow,
}: {
  api: Api;
  orders: WorkOrder[];
  projects: Project[];
  connected?: boolean;
  onNew: () => void;
  onChanged: () => Promise<void>;
  now?: number;
}) {
  const now = useNow(fixedNow);
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const projectName = (order: WorkOrder) =>
    projects.find((project) => project.id === order.project_id)?.name ?? 'Project';
  // Runs of an archived project leave the list; choosing that project in the filter brings them back.
  const archived = useMemo(
    () => new Set(projects.filter((project) => project.archived_at).map((project) => project.id)),
    [projects],
  );
  const listed = useMemo(() => orders.filter((order) => !archived.has(order.project_id)), [orders, archived]);
  const scoped = projectId ? orders.filter((order) => order.project_id === projectId) : listed;
  const visible = scoped.filter(
    (order) =>
      matches(order, filter) &&
      (!query ||
        `${order.objective} ${order.id} ${projectName(order)}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())),
  );
  const stats = useMemo(() => {
    const week = listed.filter((order) => now - new Date(order.updated_at).getTime() <= 7 * DAY);
    return {
      active: listed.filter((order) => ACTIVE_STATUSES.includes(order.status)).length,
      questions: listed.reduce((sum, order) => sum + pendingQuestions(order).length, 0),
      attention: listed.filter((order) => ATTENTION_STATUSES.includes(order.status)).length,
      // A security review that finished delivered nothing.
      delivered: week.filter((order) => order.status === 'completed' && !isMonitoring(order)).length,
      openPrs: week.filter((order) => order.status === 'completed' && externalUrl(order.evidence?.pr_url))
        .length,
      tokens: week.reduce((sum, order) => sum + order.tokens_used, 0),
      weekRuns: week.length,
    };
  }, [listed, now]);
  const filters = [
    { value: 'all' as const, label: 'All', count: scoped.length },
    { value: 'active' as const, label: 'Active', count: scoped.filter((o) => matches(o, 'active')).length },
    {
      value: 'attention' as const,
      label: 'Needs you',
      count: scoped.filter((o) => matches(o, 'attention')).length,
    },
    {
      value: 'finished' as const,
      label: 'Closed',
      count: scoped.filter((o) => matches(o, 'finished')).length,
    },
  ];

  return (
    <div className="grid min-w-0 gap-6">
      <PageHeader
        icon={<PanelsTopLeft />}
        title="Runs"
        description="Every run on the production line: where it stands, what it used and what needs you."
        actions={
          <Button type="button" variant="primary" onClick={onNew} disabled={!connected}>
            + New run
          </Button>
        }
      />
      {/* Until the owner launches a run, the way to start one stays above what the factory recorded by itself. */}
      {!orders.some((order) => !isMonitoring(order)) && <FirstRun connected={connected} onNew={onNew} />}
      {orders.length > 0 && (
        <>
          <StatGrid label="Runs summary">
            <StatTile
              label="On the line"
              value={stats.active}
              tone={stats.active ? 'primary' : 'default'}
              note={stats.active === 1 ? '1 run queued or running' : `${stats.active} queued or running`}
            />
            <StatTile
              label="Needs you"
              value={stats.attention}
              tone={stats.attention ? 'warning' : 'default'}
              note={
                stats.questions
                  ? `${stats.questions} question${stats.questions === 1 ? '' : 's'} waiting`
                  : 'No questions waiting'
              }
            />
            <StatTile
              label="Delivered · 7 days"
              value={stats.delivered}
              tone={stats.delivered ? 'success' : 'default'}
              note={`${stats.openPrs} with a draft PR`}
            />
            <StatTile
              label="Tokens · 7 days"
              value={compact.format(stats.tokens)}
              note={`Measured across ${stats.weekRuns} run${stats.weekRuns === 1 ? '' : 's'}`}
            />
          </StatGrid>

          <section aria-labelledby="runs-table-title" className="@container/runs grid min-w-0 gap-3">
            <h2 id="runs-table-title" className="sr-only">
              All runs
            </h2>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SegmentedControl label="Filter runs" value={filter} options={filters} onChange={setFilter} />
              <div className="relative ml-auto min-w-48 flex-1 sm:max-w-72 sm:flex-none">
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
                  className="min-h-9 w-full rounded-md border border-input bg-secondary py-1.5 pr-3 pl-9 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="sr-only">Project</span>
                <Select
                  aria-label="Project"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  className="min-h-9"
                >
                  <option value="">All projects</option>
                  {[...projects]
                    .sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at))
                    .map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                        {project.archived_at ? ' (archived)' : ''}
                      </option>
                    ))}
                </Select>
              </label>
            </div>

            {visible.length ? (
              <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
                <table className="w-full border-collapse text-sm" aria-labelledby="runs-table-title">
                  <thead className="bg-secondary/50 @max-3xl/runs:sr-only">
                    <tr className="text-left text-xs font-medium text-muted-foreground">
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Run
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium">
                        Status
                      </th>
                      <th scope="col" className="w-44 px-4 py-2.5 font-medium">
                        Process
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium @max-5xl/runs:hidden">
                        Usage
                      </th>
                      <th scope="col" className="px-4 py-2.5 font-medium @max-4xl/runs:hidden">
                        Updated
                      </th>
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((order) => (
                      <tr
                        key={order.id}
                        data-testid="run-row"
                        className="border-t border-border align-middle transition-colors first:border-t-0 hover:bg-hover/40 @max-3xl/runs:grid @max-3xl/runs:grid-cols-[minmax(0,1fr)_auto] @max-3xl/runs:gap-x-3 @max-3xl/runs:gap-y-2.5 @max-3xl/runs:p-4"
                      >
                        <td className="max-w-0 min-w-56 px-4 py-3 @max-3xl/runs:col-span-2 @max-3xl/runs:max-w-none @max-3xl/runs:min-w-0 @max-3xl/runs:p-0">
                          <Link
                            to={runPath(order.id)}
                            className="block truncate font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {order.objective}
                          </Link>
                          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="truncate">{projectName(order)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{isMonitoring(order) ? 'Monitoring' : modeLabels[order.mode]}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{order.id.slice(0, 8)}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap @max-3xl/runs:p-0">
                          <RunBadge value={order.status} />
                        </td>
                        <td className="px-4 py-3 @max-3xl/runs:order-last @max-3xl/runs:col-span-2 @max-3xl/runs:p-0">
                          <StageStrip order={order} className="w-40 @max-3xl/runs:w-auto" />
                        </td>
                        <td className="px-4 py-3 @max-5xl/runs:hidden">
                          <Usage order={order} />
                        </td>
                        <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground @max-4xl/runs:hidden">
                          <time
                            dateTime={order.updated_at}
                            title={new Date(order.updated_at).toLocaleString()}
                          >
                            {relativeTime(order.updated_at, now)}
                          </time>
                        </td>
                        <td className="px-4 py-3 @max-3xl/runs:p-0">
                          <RowActions api={api} order={order} connected={connected} onChanged={onChanged} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid gap-1 rounded-xl border border-dashed border-border p-6 text-center">
                <strong className="text-sm font-medium">No matching runs</strong>
                <p className="text-xs text-muted-foreground">Change the filters to find another run.</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              One writer per project. A pull request is opened only from verified evidence.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

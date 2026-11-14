import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Api, Project, RunFigures, RunMetrics } from '../../api';
import Button from '../../components/Button';
import DescriptionList from '../../components/DescriptionList';
import EmptyState from '../../components/EmptyState';
import Field from '../../components/FormField';
import LoadingState from '../../components/LoadingState';
import Notice from '../../components/Notice';
import PageHeader from '../../components/PageHeader';
import SegmentedControl from '../../components/SegmentedControl';
import Select from '../../components/Select';
import StatTile from '../../components/StatTile';
import { Card, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { cn } from '../../lib/utils';
import { ErrorNotice, message } from '../runs/shared';
import OutcomeChart from './OutcomeChart';
import {
  UNKNOWN,
  buckets,
  compact,
  duration,
  failureLabel,
  full,
  modeLabel,
  percent,
  roleLabel,
  usd,
} from './insights';

const WINDOWS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;
type Window = (typeof WINDOWS)[number]['value'];
const MODES = ['create', 'patch', 'maintain', 'audit'] as const;
const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' });

/** A figure, or the word Unknown when nothing measured it. A measured zero is printed as a zero. */
function Figure({ value }: { value: string | null }) {
  return value === null ? (
    <span data-unknown="true" className="font-normal text-muted-foreground">
      {UNKNOWN}
    </span>
  ) : (
    <>{value}</>
  );
}

const count = (value: number | null | undefined) =>
  value === null || value === undefined ? null : full(value);

/** Share of the runs that ended which were delivered; unknown while no run has ended. */
function delivered(figures: RunFigures): number | null {
  const ended = figures.completed + figures.stopped + figures.cancelled;
  return ended ? figures.completed / ended : null;
}

function Summary({ totals }: { totals: RunFigures }) {
  const tiles: { label: string; value: string | null; note: ReactNode }[] = [
    {
      label: 'Runs',
      value: full(totals.runs),
      note: `${full(totals.completed)} completed · ${full(totals.stopped)} stopped · ${full(totals.cancelled)} cancelled`,
    },
    {
      label: 'Delivered, of runs that ended',
      value: percent(delivered(totals)),
      note:
        delivered(totals) === null
          ? 'No run has ended in this window'
          : `${full(totals.waiting + totals.active)} still open`,
    },
    {
      label: 'Tokens per completed run',
      value:
        totals.median_tokens_per_completed_run === null
          ? null
          : compact(totals.median_tokens_per_completed_run),
      note: totals.completed ? `Median of ${full(totals.completed)}` : 'No run completed in this window',
    },
    {
      label: 'Active time per completed run',
      value: duration(totals.median_active_seconds_per_completed_run),
      note: totals.completed ? `Median of ${full(totals.completed)}` : 'No run completed in this window',
    },
    {
      label: 'Measured tokens',
      value: compact(totals.measured_tokens),
      note: totals.unsettled_calls
        ? `${full(totals.settled_calls)} settled calls · ${full(totals.unsettled_calls)} never settled`
        : `${full(totals.settled_calls)} settled calls`,
    },
    {
      label: 'API cost',
      value: usd(totals.api_cost_usd),
      note:
        totals.api_cost_usd === null
          ? totals.cli_calls
            ? 'Calls ran through a CLI session, which has no price per token'
            : 'No call was charged per token'
          : totals.cli_calls
            ? `${full(totals.cli_calls)} CLI calls have no price per token`
            : 'Settled calls at the configured prices',
    },
    {
      label: 'Input read from cache',
      value: percent(totals.cache_read_share),
      note:
        totals.cache_read_share === null
          ? 'No call reported its token split'
          : `Of ${compact(totals.input_tokens ?? 0)} input tokens`,
    },
    {
      label: 'Context read again',
      value: percent(totals.recovery_ratio),
      note:
        totals.recovery_ratio === null
          ? 'No tool call recorded'
          : `Tool calls that paged back archived text, of ${full(totals.tool_calls)}`,
    },
  ];
  return (
    <section aria-label="Summary" className="@container/summary">
      {/* Eight figures in two rows of four; two per row where the container is narrow. */}
      <div className="grid grid-cols-2 gap-3 @3xl/summary:grid-cols-4">
        {tiles.map((tile) => (
          <StatTile
            key={tile.label}
            label={tile.label}
            value={<Figure value={tile.value} />}
            note={tile.note}
            wrapNote
          />
        ))}
      </div>
    </section>
  );
}

function Tokens({ totals }: { totals: RunFigures }) {
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-1">
          <CardTitle as="h3" className="text-base">
            Tokens
          </CardTitle>
          <CardDescription>What settled calls reported. Cached input is part of the input.</CardDescription>
        </div>
      </CardHeader>
      <DescriptionList
        label="Tokens by kind"
        termWidth="14rem"
        items={[
          ['Measured', full(totals.measured_tokens)],
          ['Input', <Figure key="input" value={count(totals.input_tokens)} />],
          ['Read from the cache', <Figure key="read" value={count(totals.cache_read_tokens)} />],
          ['Written to the cache', <Figure key="written" value={count(totals.cache_write_tokens)} />],
          ['Output', <Figure key="output" value={count(totals.output_tokens)} />],
          ['Reserved by calls that never settled', full(totals.unknown_reserved_tokens)],
        ]}
      />
    </Card>
  );
}

function Calls({ totals }: { totals: RunFigures }) {
  const classes = Object.entries(totals.failed_calls).sort((a, b) => b[1] - a[1]);
  const explained = classes.reduce((sum, [, value]) => sum + value, 0);
  const unexplained = totals.unsettled_calls - explained;
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-1">
          <CardTitle as="h3" className="text-base">
            Model calls
          </CardTitle>
          <CardDescription>
            A call that never settled keeps its reservation: a lost response is not a free request.
          </CardDescription>
        </div>
      </CardHeader>
      <DescriptionList
        label="Model calls"
        termWidth="14rem"
        items={[
          ['Calls', full(totals.calls)],
          ['Settled', full(totals.settled_calls)],
          ['Through a CLI session', full(totals.cli_calls)],
          ['Never settled', full(totals.unsettled_calls)],
          ...classes.map(([name, value]): [ReactNode, ReactNode] => [
            `Failed: ${failureLabel(name)}`,
            full(value),
          ]),
          unexplained > 0 && ['No cause recorded', full(unexplained)],
        ]}
      />
    </Card>
  );
}

function Modes({ metrics }: { metrics: RunMetrics }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3" className="text-base">
          By flow
        </CardTitle>
      </CardHeader>
      <Table label="Figures by flow">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Flow</TableHead>
            {[
              'Runs',
              'Completed',
              'Stopped',
              'Tokens per completed run',
              'API cost',
              'Input read from cache',
              'Context read again',
            ].map((heading) => (
              <TableHead key={heading} scope="col" className="text-right">
                {heading}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {metrics.by_mode.map((item) => (
            <TableRow key={item.mode}>
              <TableHead scope="row" className="text-sm font-medium text-foreground">
                {modeLabel(item.mode)}
              </TableHead>
              {[
                full(item.runs),
                full(item.completed),
                full(item.stopped),
                item.median_tokens_per_completed_run === null
                  ? null
                  : full(item.median_tokens_per_completed_run),
                usd(item.api_cost_usd),
                percent(item.cache_read_share),
                percent(item.recovery_ratio),
              ].map((value, index) => (
                <TableCell key={index} className="text-right whitespace-nowrap tabular-nums">
                  <Figure value={value} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function Specialists({ metrics }: { metrics: RunMetrics }) {
  const largest = Math.max(1, ...metrics.by_specialist.map((item) => item.measured_tokens));
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-1">
          <CardTitle as="h3" className="text-base">
            Tokens by specialist
          </CardTitle>
          <CardDescription>Measured tokens of settled calls, largest first.</CardDescription>
        </div>
      </CardHeader>
      {metrics.by_specialist.length ? (
        <ul className="@container grid gap-3" aria-label="Tokens by specialist">
          {metrics.by_specialist.map((item) => {
            const cached =
              item.cache_read_tokens !== null && item.input_tokens
                ? item.cache_read_tokens / item.input_tokens
                : null;
            return (
              <li
                key={item.role ?? 'none'}
                className="grid min-w-0 gap-x-4 gap-y-1 text-sm @lg:grid-cols-[11rem_minmax(0,1fr)_auto] @lg:items-center"
              >
                <span className="font-medium">{roleLabel(item.role)}</span>
                <span aria-hidden="true" className="flex h-3 items-center">
                  <span
                    className="h-2 min-w-0.5 rounded-r-[4px] bg-primary"
                    style={{ width: `${(item.measured_tokens / largest) * 100}%` }}
                  />
                </span>
                <span className="text-muted-foreground tabular-nums">
                  <strong className="font-semibold text-foreground">{full(item.measured_tokens)}</strong>{' '}
                  tokens · {full(item.calls)} {item.calls === 1 ? 'call' : 'calls'} · cache{' '}
                  <Figure value={percent(cached)} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No model call was recorded in this window.</p>
      )}
    </Card>
  );
}

export default function InsightsView({ api, projects }: { api: Api; projects: Project[] }) {
  const [days, setDays] = useState<Window>('30');
  const [mode, setMode] = useState('');
  const [projectId, setProjectId] = useState('');
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(true);
  // Only the answer to the latest request is shown: a slower, older one never replaces it.
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    return api
      .runMetrics(Number(days), mode || undefined, projectId || undefined)
      .then((next) => {
        if (request !== latest.current) return;
        setMetrics(next);
        setError('');
      })
      .catch((err: unknown) => {
        if (request === latest.current) setError(message(err));
      })
      .finally(() => {
        if (request === latest.current) setPending(false);
      });
  }, [api, days, mode, projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  const windowLabel = `Last ${days} days`;
  const totals = metrics?.totals;
  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Across runs"
        title="Insights"
        description="How runs ended, what they cost and how their context behaved, summed from the ledger and the event log. A figure that nothing measured reads Unknown, never zero."
        actions={
          <>
            {metrics && (
              <span className="text-xs text-muted-foreground">
                Updated {clock.format(new Date(metrics.generated_at))}
              </span>
            )}
            <Button
              type="button"
              disabled={pending}
              onClick={() => {
                setPending(true);
                void load();
              }}
            >
              Refresh
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Window</span>
          <SegmentedControl
            label="Window"
            value={days}
            options={WINDOWS}
            onChange={(value) => {
              setPending(true);
              setDays(value);
            }}
          />
        </div>
        <Field label="Flow" className="w-full max-w-44">
          <Select
            value={mode}
            onChange={(event) => {
              setPending(true);
              setMode(event.target.value);
            }}
          >
            <option value="">All flows</option>
            {MODES.map((item) => (
              <option key={item} value={item}>
                {modeLabel(item)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Project" className="w-full max-w-72">
          <Select
            value={projectId}
            onChange={(event) => {
              setPending(true);
              setProjectId(event.target.value);
            }}
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {!metrics || !totals ? (
        pending && <LoadingState label="Loading figures…" />
      ) : (
        // A refresh keeps the previous figures in place, dimmed, instead of flashing a skeleton.
        <div className={cn('grid gap-6 transition-opacity', pending && 'opacity-60')} aria-busy={pending}>
          {metrics.truncated && (
            <Notice tone="warning" title="This window holds more runs than are counted.">
              <p>Only the newest 5,000 runs are included. Narrow the window or filter by project.</p>
            </Notice>
          )}
          {totals.runs === 0 ? (
            <EmptyState title="No runs in this window" as="h2">
              Figures appear once a run is created. Try a longer window or another filter.
            </EmptyState>
          ) : (
            <>
              <Summary totals={totals} />
              <Card>
                <OutcomeChart buckets={buckets(metrics)} window={windowLabel} />
              </Card>
              <div className="@container">
                <div className="grid gap-6 @3xl:grid-cols-2">
                  <Tokens totals={totals} />
                  <Calls totals={totals} />
                </div>
              </div>
              <Modes metrics={metrics} />
              <Specialists metrics={metrics} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

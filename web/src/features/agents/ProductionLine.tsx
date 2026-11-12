import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { Cog, GitBranch, ListChecks, Repeat, UserRound } from 'lucide-react';
import type { Api, ProcessTopology, WorkOrder } from '../../api';
import DescriptionList from '../../components/DescriptionList';
import { ProductionLineSkeleton } from '../../components/Skeletons';
import Notice from '../../components/Notice';
import SegmentedControl from '../../components/SegmentedControl';
import { isClosed } from '../../runState';
import { cn } from '../../lib/utils';
import CrewAvatar from '../crew/CrewAvatar';
import { STAGES } from '../runs/stages';
import { RunBadge, message, modeLabels } from '../runs/shared';
import { runPath } from '../runs/RunsTable';

type Mode = WorkOrder['mode'];
type Station = ProcessTopology['stations'][number];

const MODES: Mode[] = ['patch', 'maintain', 'create', 'audit'];

export const kindLabels: Record<Station['kind'], string> = {
  rules: 'Rules · no model',
  gates: 'Registered checks · no model',
  model: 'Model',
  gates_model: 'Checks, then a model',
};
const kindShort: Record<Station['kind'], string> = {
  rules: 'rules',
  gates: 'checks',
  model: 'model',
  gates_model: 'checks + model',
};

/** Contiguous runs of stations that share a stage, as grid column spans. */
function stageSpans(stations: Station[]) {
  const spans: { stage: Station['stage']; start: number; end: number }[] = [];
  stations.forEach((station, index) => {
    const last = spans.at(-1);
    if (last && last.stage === station.stage) last.end = index + 1;
    else spans.push({ stage: station.stage, start: index, end: index + 1 });
  });
  return spans;
}

/** Runs that stand at a station now. Closed runs have left the line. */
export function runsAtStations(stations: Station[], orders: WorkOrder[]) {
  const live = new Map<string, WorkOrder[]>();
  for (const order of orders) {
    if (isClosed(order)) continue;
    const station = stations.find((item) => item.phases.includes(order.phase));
    if (station) live.set(station.id, [...(live.get(station.id) ?? []), order]);
  }
  return live;
}

function StationMark({ station }: { station: Station }) {
  if (station.agent) return <CrewAvatar role={station.role} size={30} />;
  const Icon = station.kind === 'gates' ? ListChecks : station.id === 'route' ? GitBranch : Cog;
  return (
    <span className="grid size-[1.875rem] shrink-0 place-items-center rounded-full border border-border bg-secondary text-muted-foreground">
      <Icon aria-hidden="true" className="size-4" />
    </span>
  );
}

/**
 * The sabre-v1 graph drawn as a production line: one column per station, grouped by stage, with
 * the repair loop above and the stations that can stop for the owner marked below. Live runs come
 * from each run's recorded phase; nothing here is inferred from model output.
 */
export default function ProductionLine({ api, orders }: { api: Api; orders: WorkOrder[] }) {
  const initialMode = orders.find((order) => !isClosed(order))?.mode ?? 'patch';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [loaded, setLoaded] = useState<{ mode: Mode; topology?: ProcessTopology; error?: string } | null>(
    null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api
      .flowTopology(mode)
      .then((topology) => live && setLoaded({ mode, topology }))
      .catch((error: unknown) => live && setLoaded({ mode, error: message(error) }));
    return () => {
      live = false;
    };
  }, [api, mode]);
  const current = loaded?.mode === mode ? loaded : null;
  const stations = useMemo(() => current?.topology?.stations ?? [], [current]);
  const loops = current?.topology?.loops ?? [];
  const live = useMemo(() => runsAtStations(stations, orders), [stations, orders]);
  const repair = loops.find((loop) => loop.source !== loop.target);
  const repairFrom = repair ? stations.findIndex((station) => station.id === repair.target) : -1;
  const repairTo = repair ? stations.findIndex((station) => station.id === repair.source) : -1;
  const focus =
    stations.find((station) => station.id === selected) ??
    stations.find((station) => live.has(station.id)) ??
    stations.find((station) => station.id === 'implement') ??
    stations[0];
  const grid = {
    gridTemplateColumns: `repeat(${Math.max(stations.length, 1)}, minmax(5.75rem, 1fr))`,
  } as CSSProperties;

  return (
    <section aria-labelledby="production-line-title" className="@container/line grid min-w-0 gap-4">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 id="production-line-title" className="text-base font-semibold">
            Production line
          </h2>
          <p className="text-xs text-muted-foreground">
            Graph sabre-v1 · stations for the selected mode · live positions from each run&apos;s recorded
            phase
          </p>
        </div>
        <SegmentedControl
          label="Mode"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setSelected(null);
          }}
          options={MODES.map((value) => ({ value, label: modeLabels[value] }))}
        />
      </div>

      {current?.error && (
        <Notice tone="danger" role="alert" title="The line could not be loaded.">
          <p>{current.error}</p>
        </Notice>
      )}
      {!current && <ProductionLineSkeleton />}
      {current?.topology && !stations.length && (
        <Notice tone="neutral" title="This server does not describe stations yet.">
          <p>Update SABRE to see the production line. Runs and their timelines are unaffected.</p>
        </Notice>
      )}

      {stations.length > 0 && (
        <div className="grid min-w-0 items-start gap-4">
          <div className="min-w-0 overflow-x-auto rounded-xl border border-border bg-card p-3 pb-2">
            <div className="grid min-w-max gap-x-2.5 gap-y-1.5" style={grid}>
              {stageSpans(stations).map((span) => (
                <div
                  key={`${span.stage}-${span.start}`}
                  className={cn(
                    'row-start-1 rounded-t-lg border-x border-t px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-semibold tracking-wider uppercase',
                    span.stage === focus?.stage
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border bg-secondary/40 text-muted-foreground',
                  )}
                  style={{ gridColumn: `${span.start + 1} / ${span.end + 1}` }}
                >
                  {STAGES.find((stage) => stage.id === span.stage)?.label}
                </div>
              ))}
              {repair && repairFrom >= 0 && repairTo > repairFrom && (
                <div
                  className="relative row-start-2 mx-10 mt-1 h-6 rounded-t-xl border-x-2 border-t-2 border-dashed border-primary/70"
                  style={{ gridColumn: `${repairFrom + 1} / ${repairTo + 2}` }}
                  title={`${repair.condition}. ${repair.limit}.`}
                >
                  <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-primary/40 bg-card px-2.5 py-0.5 text-[0.6875rem] whitespace-nowrap text-primary">
                    <Repeat aria-hidden="true" className="size-3" />
                    Repair loop · back to {stations[repairFrom].label}
                  </span>
                </div>
              )}
              <ol aria-label={`${modeLabels[mode]} stations`} className="contents">
                {stations.map((station, index) => {
                  const here = live.get(station.id) ?? [];
                  const waiting = here.some(
                    (order) => order.status !== 'running' && order.status !== 'queued',
                  );
                  const active = focus?.id === station.id;
                  return (
                    <li
                      key={station.id}
                      className="row-start-3 grid min-w-0"
                      style={{ gridColumn: index + 1 }}
                    >
                      <button
                        type="button"
                        aria-pressed={active}
                        aria-label={`${station.label}: ${station.agent ?? kindLabels[station.kind]}${here.length ? `, ${here.length} run${here.length === 1 ? '' : 's'} here` : ''}`}
                        onClick={() => setSelected(station.id)}
                        data-kind={station.kind}
                        className={cn(
                          'relative grid h-full min-h-28 cursor-pointer content-start justify-items-start gap-1.5 rounded-lg border bg-background/40 p-2.5 text-left transition-colors hover:bg-hover/50',
                          station.condition ? 'border-dashed border-input' : 'border-border',
                          active &&
                            'border-solid border-primary bg-accent/15 shadow-[0_0_0_1px_var(--primary)]',
                        )}
                      >
                        <StationMark station={station} />
                        <strong className="text-[0.8125rem] leading-tight font-semibold">
                          {station.label}
                        </strong>
                        <span className="text-xs leading-tight text-muted-foreground">
                          {station.agent ?? (station.kind === 'gates' ? 'Checks' : 'Rules')}
                        </span>
                        <span className="font-mono text-[0.6875rem] text-muted-foreground/80">
                          {kindShort[station.kind]}
                        </span>
                        {here.length > 0 && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 font-mono text-[0.6875rem]',
                              waiting ? 'text-warning' : 'text-primary',
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                'size-1.5 rounded-full',
                                waiting ? 'bg-warning' : 'bg-primary motion-safe:animate-pulse',
                              )}
                            />
                            {here.length} run{here.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </button>
                      {station.helpers.map((helper) => (
                        <span
                          key={helper.role}
                          title={helper.condition}
                          className="mt-1 truncate rounded-full border border-dashed border-border px-2 py-0.5 text-center text-[0.6875rem] text-muted-foreground"
                        >
                          + {helper.agent}
                        </span>
                      ))}
                    </li>
                  );
                })}
              </ol>
              {stations.map((station, index) => (
                <div
                  key={`owner-${station.id}`}
                  aria-hidden="true"
                  className="row-start-4 flex justify-center"
                  style={{ gridColumn: index + 1 }}
                >
                  {station.asks_owner && (
                    <span className="h-3 border-l-2 border-dashed border-warning-border" />
                  )}
                </div>
              ))}
              <div
                className="row-start-5 flex items-center gap-2 rounded-lg border border-warning-border/70 bg-warning-bg/40 px-3 py-2 text-xs"
                style={{ gridColumn: `1 / ${stations.length + 1}` }}
              >
                <UserRound aria-hidden="true" className="size-3.5 text-warning" />
                <strong className="font-semibold text-warning">You</strong>
                <span className="text-muted-foreground">
                  {stations.filter((station) => station.asks_owner).length} stations can pause the line for
                  your answer. Pause and cancel are checked before every station and every model call.
                </span>
              </div>
            </div>
          </div>

          {focus && (
            <aside
              aria-label="Station inspector"
              className="grid min-w-0 content-start gap-4 rounded-xl border border-border bg-card p-4 @4xl/line:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @4xl/line:gap-x-8"
            >
              <div className="grid min-w-0 content-start gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="grid gap-0.5">
                    <span className="text-xs text-muted-foreground">
                      Station · {STAGES.find((stage) => stage.id === focus.stage)?.label}
                    </span>
                    <h3 className="text-lg font-semibold">{focus.label}</h3>
                  </div>
                  <StationMark station={focus} />
                </div>
                <p className="text-sm text-foreground/90">{focus.summary}</p>
                <DescriptionList
                  termWidth="6.5rem"
                  stackBelow="never"
                  items={[
                    ['Runs on', focus.agent ?? 'Deterministic code'],
                    ['Kind', kindLabels[focus.kind]],
                    ['When', focus.condition ?? `Every ${modeLabels[mode].toLowerCase()} run`],
                    ['Asks you', focus.asks_owner ? 'Can pause the line for your answer' : 'Never'],
                    focus.helpers.length > 0 && [
                      'Calls',
                      focus.helpers
                        .map((helper) => `${helper.agent}, when ${helper.condition.toLowerCase()}`)
                        .join('; '),
                    ],
                    focus.phases.length > 0 && [
                      'Phases',
                      <span key="phases" className="flex flex-wrap gap-1">
                        {focus.phases.map((phase) => (
                          <code key={phase} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
                            {phase}
                          </code>
                        ))}
                      </span>,
                    ],
                    ...loops
                      .filter((loop) => loop.source === focus.id || loop.target === focus.id)
                      .map(
                        (loop) =>
                          [
                            loop.source === loop.target ? 'Repeats' : 'Loop',
                            `${loop.condition}. ${loop.limit}.`,
                          ] as [string, string],
                      ),
                  ]}
                />
              </div>
              <div className="grid min-w-0 content-start gap-4">
                {focus.agent && (
                  <div className="grid gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      Model for each call · first match wins
                    </span>
                    <ol className="grid gap-1 text-xs">
                      {[
                        'Run phase model',
                        'Flow phase model',
                        `${focus.agent} specialist model`,
                        'Factory default',
                      ].map((step, index) => (
                        <li key={step} className="rounded-md bg-secondary/60 px-2.5 py-1.5">
                          {index + 1} · {step}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <div className="grid gap-1.5">
                  <span className="text-xs text-muted-foreground">Here now</span>
                  {(live.get(focus.id) ?? []).length ? (
                    <ul className="grid gap-1.5">
                      {(live.get(focus.id) ?? []).map((order) => (
                        <li
                          key={order.id}
                          className="flex min-w-0 items-center justify-between gap-2 text-sm"
                        >
                          <Link to={runPath(order.id)} className="truncate hover:underline">
                            {order.objective}
                          </Link>
                          <RunBadge value={order.status} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No run is at this station.</p>
                  )}
                </div>
              </div>
            </aside>
          )}
        </div>
      )}
    </section>
  );
}

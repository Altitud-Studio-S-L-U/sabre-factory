import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Maximize2, Minimize2, Radio } from 'lucide-react';
import type { Api, AuditView, ProcessTopology, RunInspection, SequencedEvent, WorkOrder } from './api';
import { projectExecution, type ObservedSpan } from './executionProjection';
import RunInspector, { specialistNames } from './RunInspector';
import JsonView from './components/JsonView';
import Button from './components/Button';
import Disclosure from './components/Disclosure';
import CrewAvatar from './features/crew/CrewAvatar';
import { currentBlocker } from './runState';
import type { RunUsageState } from './useRunUsage';
import { cn } from './lib/utils';
import {
  anchoredScroll,
  clampZoom,
  scrollForCentre,
  ticks,
  viewportWindow,
  wheelZoom,
} from './features/runs/timelineScale';

const clock = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const duration = (ms: number | null | undefined) =>
  ms == null ? 'Not recorded' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const memoryTools = new Set(['read_memory', 'propose_memory', 'resolve_memory', 'read_context']);
const ROW = 38;
const INSPECTOR_MIN = 280;

/**
 * Per-run display preferences for this tab. Kept in memory on purpose: the console writes
 * nothing to browser storage (a tested guarantee), so zoom and the inspector width survive
 * moving between runs and sections but not a reload.
 */
const displayPrefs = new Map<string, { zoom: number; inspector: number }>();
function readPrefs(id: string): { zoom?: number; inspector?: number } {
  return displayPrefs.get(id) ?? {};
}
function writePrefs(id: string, prefs: { zoom: number; inspector: number }) {
  displayPrefs.set(id, prefs);
}

function barTone(span: ObservedSpan) {
  if (span.event.state === 'failed') return 'border-timeline-failure bg-timeline-failure/25 text-foreground';
  if (span.event.kind === 'tool' && memoryTools.has(span.event.name))
    return 'border-timeline-memory/70 bg-timeline-memory/20 text-foreground';
  if (span.event.kind === 'tool') return 'border-timeline-tool/70 bg-timeline-tool/20 text-foreground';
  if (span.event.kind === 'agent') return 'border-timeline-agent/70 bg-timeline-agent/20 text-foreground';
  return 'border-primary/60 bg-primary/15 text-foreground';
}

function Readout({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <strong className="text-lg font-semibold tabular-nums capitalize">{value}</strong>
      {note && <small className="text-xs leading-snug text-muted-foreground">{note}</small>}
    </div>
  );
}

export default function RunProcessConsole({
  api,
  entries,
  order,
  topology,
  audit,
  liveUsage,
  inspection,
  inspectorError,
  onInspect,
  onMore,
}: {
  api?: Api;
  entries: SequencedEvent[];
  order: WorkOrder;
  topology?: ProcessTopology | null;
  audit?: AuditView | null;
  liveUsage?: RunUsageState;
  inspection?: RunInspection | null;
  inspectorError?: string;
  onInspect?: (role?: string, agentId?: string) => void;
  onMore?: () => void;
}) {
  const tooltipId = useId();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const [wide, setWide] = useState(false);
  const [zoom, setZoomState] = useState(() => clampZoom(readPrefs(order.id).zoom ?? 1));
  const [inspectorWidth, setInspectorWidth] = useState(() => readPrefs(order.id).inspector ?? 400);
  const [view, setView] = useState({ left: 0, width: 1 });
  const [follow, setFollow] = useState(true);
  const [preview, setPreview] = useState<ObservedSpan | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState<ObservedSpan | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const spans = projectExecution(entries);
  const running = ['running', 'queued'].includes(order.status);
  const usage = liveUsage?.snapshot?.usage ?? (audit?.work_id === order.id ? audit.usage : undefined);
  const pendingUsage = (usage?.unsettled_calls ?? 0) > 0;

  useEffect(
    () => writePrefs(order.id, { zoom, inspector: inspectorWidth }),
    [order.id, zoom, inspectorWidth],
  );

  /** Change zoom keeping the instant under `cursor` (px from the scroll box's left) in place. */
  const setZoom = useCallback((next: number | ((value: number) => number), cursor?: number) => {
    setZoomState((previous) => {
      const value = clampZoom(typeof next === 'function' ? next(previous) : next);
      const box = scrollRef.current;
      if (box && value !== previous)
        pendingScroll.current = anchoredScroll(
          box.scrollLeft,
          cursor ?? box.clientWidth / 2,
          previous,
          value,
        );
      return value;
    });
  }, []);
  const measure = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const next = viewportWindow(box.scrollLeft, box.clientWidth, box.scrollWidth);
    setView((prior) => (prior.left === next.left && prior.width === next.width ? prior : next));
  }, []);
  // Apply the anchored offset after the wider content has laid out.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (box && pendingScroll.current != null) {
      box.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
    measure();
  }, [zoom, wide, measure]);
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    // Ctrl/⌘ + wheel and trackpad pinch (reported as ctrl + wheel) zoom at the cursor.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = box.getBoundingClientRect();
      setZoom((value) => wheelZoom(value, event.deltaY), event.clientX - rect.left);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(box);
    return () => {
      box.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [setZoom, measure]);
  useEffect(() => {
    if (!wide || !workspaceRef.current) return;
    const root = workspaceRef.current;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    const siblings: { element: HTMLElement; inert: boolean }[] = [];
    // Isolate the existing workspace in place so inspection and scroll state survive expansion.
    let ancestor: HTMLElement = root;
    while (ancestor.parentElement) {
      for (const element of ancestor.parentElement.children) {
        if (element !== ancestor && element instanceof HTMLElement) {
          siblings.push({ element, inert: element.inert });
          element.inert = true;
        }
      }
      if (ancestor.parentElement === document.body) break;
      ancestor = ancestor.parentElement;
    }
    document.body.style.overflow = 'hidden';
    expandRef.current?.focus();
    return () => {
      for (const sibling of siblings) sibling.element.inert = sibling.inert;
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [wide]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  // Follow now: keep the live edge in view while the run is active.
  useEffect(() => {
    const box = scrollRef.current;
    if (!running || !follow || !box || zoom === 1) return;
    box.scrollLeft = box.scrollWidth;
  }, [running, follow, zoom, now, entries.length]);

  const current =
    spans.find((span) => span.id === selected) ??
    (selected?.startsWith('phase:')
      ? undefined
      : selected
        ? (pinned ?? undefined)
        : ([...spans].reverse().find((span) => span.event.kind === 'stage') ?? spans.at(-1)));
  const historicalSelection = Boolean(selected && pinned && !spans.some((span) => span.id === selected));
  // A recorded step error explains the run's current stop only while the run is stopped with that code and no
  // later step has started; otherwise it is a historical record of an earlier attempt.
  const blocker = currentBlocker(order);
  const firstSequence = (span: ObservedSpan) => span.records[0]?.sequence ?? 0;
  const lastSequence = (span: ObservedSpan) => span.records.at(-1)?.sequence ?? 0;
  const currentStop = Boolean(
    current &&
      !historicalSelection &&
      ['blocked', 'failed'].includes(order.status) &&
      blocker !== null &&
      current.event.error_code === blocker &&
      !spans.some((span) => span.event.kind === 'stage' && firstSequence(span) > lastSequence(current)),
  );
  const registered = topology?.lanes ?? [];
  const laneFor = (span: ObservedSpan) =>
    registered.find(
      (lane) =>
        lane.stages.includes(span.event.phase) ||
        (span.event.kind === 'stage' && lane.stages.includes(span.event.name)),
    )?.id ?? span.phase;
  const laneIds = [...new Set([...registered.map((lane) => lane.id), ...spans.map(laneFor)])];
  const selectedLane = selected?.startsWith('phase:')
    ? selected.slice(6)
    : current
      ? laneFor(current)
      : laneIds[0];
  const lane = registered.find((item) => item.id === selectedLane);
  const known = spans.flatMap((span) => (span.start == null ? [] : [span.start]));
  const origin = known.length ? Math.min(...known) : null;
  const latest = Math.max(
    0,
    ...entries.map((entry) => Date.parse(entry.event.timestamp)).filter(Number.isFinite),
  );
  const end = running ? Math.max(now, latest) : latest;
  const horizon = Math.max(1000, origin == null ? 0 : end - origin);
  const allExpanded = laneIds.length > 0 && laneIds.every((id) => expanded.has(id));
  const fraction = (ms: number) => (origin == null ? 0 : Math.max(0, Math.min(1, (ms - origin) / horizon)));
  const pin = (span: ObservedSpan) => {
    setSelected(span.id);
    setPinned(span);
    const parent = spans.find((candidate) => candidate.id === span.event.parent_id);
    onInspect?.(
      span.event.kind === 'agent'
        ? span.event.name
        : parent?.event.kind === 'agent'
          ? parent.event.name
          : undefined,
      span.event.agent_id ?? parent?.event.agent_id ?? undefined,
    );
  };
  const moveBarFocus = (from: HTMLElement, step: number) => {
    const bars = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-timeline-bar]') ?? []);
    const index = bars.indexOf(from);
    bars[Math.min(bars.length - 1, Math.max(0, index + step))]?.focus();
  };
  const renderBar = (span: ObservedSpan, index: number, total: number, attempt = index + 1) => {
    const left =
      origin == null || span.start == null ? null : Math.max(0, ((span.start - origin) / horizon) * 100);
    const width = span.start == null ? 0 : Math.max(1.1, (((span.end ?? end) - span.start) / horizon) * 100);
    const active = span.event.state === 'started';
    return (
      <button
        type="button"
        key={span.id}
        data-timeline-bar
        data-kind={span.event.kind}
        data-state={span.event.state}
        className={cn(
          'absolute flex h-[30px] min-w-2 cursor-pointer flex-col justify-center overflow-hidden rounded-md border px-2 text-left transition-shadow',
          'hover:ring-2 hover:ring-ring/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          'aria-pressed:ring-2 aria-pressed:ring-primary',
          barTone(span),
          active && 'animate-pulse motion-reduce:animate-none',
        )}
        style={
          left == null
            ? undefined
            : { left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, top: `${6 + index * ROW}px` }
        }
        aria-pressed={current?.id === span.id}
        onClick={() => pin(span)}
        onMouseEnter={() => setPreview(span)}
        onMouseLeave={() => setPreview(null)}
        onFocus={() => setPreview(span)}
        onBlur={() => setPreview(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setPreview(null);
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            moveBarFocus(event.currentTarget, 1);
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveBarFocus(event.currentTarget, -1);
          }
        }}
        aria-describedby={preview?.id === span.id ? tooltipId : undefined}
        aria-label={`${span.event.name} · ${span.event.state}`}
      >
        <strong className="truncate text-xs leading-tight font-semibold">
          {span.event.state === 'failed' ? '× ' : ''}
          {specialistNames[span.event.name] ?? span.event.name.replaceAll('_', ' ')}
          {total > 1 ? ` · attempt ${attempt}` : ''}
        </strong>
        <small className="truncate text-xs leading-tight text-muted-foreground">
          {active && span.start != null
            ? `${clock(Math.max(0, end - span.start))} · active`
            : duration(span.event.duration_ms)}
        </small>
      </button>
    );
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = scrollRef.current;
    if (!box || event.button !== 0 || event.pointerType !== 'mouse') return;
    if ((event.target as HTMLElement).closest('button,a,input,select,textarea')) return;
    const startX = event.clientX;
    const startLeft = box.scrollLeft;
    box.setPointerCapture(event.pointerId);
    box.dataset.panning = 'true';
    setFollow(false);
    const move = (moveEvent: PointerEvent) => {
      box.scrollLeft = startLeft - (moveEvent.clientX - startX);
    };
    const stop = () => {
      delete box.dataset.panning;
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', stop);
      box.removeEventListener('pointercancel', stop);
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);
  };
  const scrubMinimap = (event: ReactPointerEvent<HTMLDivElement>) => {
    const map = minimapRef.current;
    const box = scrollRef.current;
    if (!map || !box) return;
    const place = (clientX: number) => {
      const rect = map.getBoundingClientRect();
      box.scrollLeft = scrollForCentre((clientX - rect.left) / rect.width, box.clientWidth, box.scrollWidth);
    };
    setFollow(false);
    place(event.clientX);
    map.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => place(moveEvent.clientX);
    const stop = () => {
      map.removeEventListener('pointermove', move);
      map.removeEventListener('pointerup', stop);
    };
    map.addEventListener('pointermove', move);
    map.addEventListener('pointerup', stop);
  };
  const resizeInspector = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = workspaceRef.current;
    if (!root) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      setInspectorWidth(
        Math.round(Math.min(rect.width * 0.6, Math.max(INSPECTOR_MIN, rect.right - moveEvent.clientX))),
      );
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
  };
  const overflowing = view.width < 0.999;
  const stageSpans = spans.filter((span) => span.event.kind === 'stage' && span.start != null);

  return (
    <div
      ref={workspaceRef}
      className={cn(
        'grid min-w-0 gap-4',
        wide &&
          'fixed inset-0 z-50 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background p-3 sm:p-5',
      )}
      role={wide ? 'dialog' : undefined}
      aria-modal={wide ? true : undefined}
      aria-label={wide ? 'Expanded run workspace' : undefined}
      onKeyDown={(event) => {
        if (!wide || event.defaultPrevented || (event.target as HTMLElement).closest('dialog[open]')) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          setWide(false);
          setPreview(null);
        }
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button,input,textarea,select,a[href],[tabindex]',
          ),
        ).filter(
          (element) =>
            !element.matches(':disabled,[type="hidden"]') &&
            element.tabIndex >= 0 &&
            element.getClientRects().length > 0,
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <div className={cn('grid min-w-0 gap-3', wide && 'hidden')}>
        {liveUsage?.error && (
          <p
            role={liveUsage.canRetry ? 'alert' : 'status'}
            className="flex flex-wrap items-center gap-2 text-sm text-warning"
          >
            {liveUsage.error}{' '}
            {usage
              ? 'Showing the last recorded usage snapshot; it may be stale.'
              : 'No recorded usage snapshot is available.'}{' '}
            <Button type="button" size="sm" disabled={!liveUsage.canRetry} onClick={liveUsage.retry}>
              Retry usage
            </Button>
          </p>
        )}
        {liveUsage?.loading && !liveUsage.snapshot && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading recorded usage…
          </p>
        )}
        <div
          aria-label="Recorded run state"
          className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2"
        >
          <Readout label="Current phase" value={order.phase.replaceAll('_', ' ')} />
          <Readout
            label="Measured tokens"
            value={usage ? usage.measured_tokens.toLocaleString('en-US') : 'Not available'}
            note={
              pendingUsage
                ? `${usage!.unsettled_calls} calls pending · ${usage!.unknown_reserved_tokens.toLocaleString('en-US')} tokens reserved · usage incomplete`
                : usage
                  ? 'Settled provider usage'
                  : 'Provider usage unavailable'
            }
          />
          <Readout
            label="Model calls"
            value={
              <>
                {usage ? usage.calls : 'Not available'}
                <small className="text-sm font-normal text-muted-foreground">
                  {' '}
                  /{' '}
                  {(order.effective_budget_policy ?? order.budget.policy)?.invocations.primary ??
                    (order.effective_budget_policy || order.budget.policy
                      ? 'Uncapped'
                      : (order.budget.max_calls ?? 'Uncapped'))}
                </small>
              </>
            }
          />
          <Readout
            label="Active time recorded"
            value={clock(order.active_seconds_used * 1000)}
            note="Excludes idle and operator waits"
          />
          <Readout
            label={liveUsage?.snapshot ? 'Recorded model API cost' : 'Model API cost · audit ledger'}
            value={
              liveUsage?.snapshot
                ? liveUsage.snapshot.measured_api_cost_usd == null
                  ? 'Unknown'
                  : `$${liveUsage.snapshot.measured_api_cost_usd.toFixed(4)}`
                : usage
                  ? `$${usage.cost_usd.toFixed(4)} ledger`
                  : 'Unknown'
            }
            note={
              <>
                {liveUsage?.snapshot && (pendingUsage || liveUsage.snapshot.reserved_api_cost_usd > 0)
                  ? `$${liveUsage.snapshot.reserved_api_cost_usd.toFixed(4)} reserved · pending cost unknown. `
                  : !liveUsage?.snapshot && usage
                    ? 'Ledger includes pending reservations. '
                    : ''}
                Subscription fees and unknown remote costs excluded
              </>
            }
          />
        </div>
      </div>
      <div
        data-testid="run-workspace-grid"
        className={cn(
          '@container/workspace min-w-0 overflow-hidden rounded-xl border border-border bg-card',
          wide && 'h-full',
        )}
      >
        <div
          className={cn(
            'grid h-full min-w-0 @[64rem]/workspace:grid-cols-[minmax(0,1fr)_auto_var(--inspector-width)]',
          )}
          style={{ '--inspector-width': `${inspectorWidth}px` } as CSSProperties}
        >
          <section aria-label="Project timeline" className="flex min-h-0 min-w-0 flex-col">
            <div
              aria-label="Timeline display controls"
              className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2"
            >
              <span className="mr-auto text-sm font-medium">Run workspace</span>
              <div aria-label="Timeline zoom" className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="w-8 px-0"
                  disabled={zoom <= 1}
                  aria-label="Zoom out timeline"
                  onClick={() => setZoom((value) => value / 2)}
                >
                  −
                </Button>
                <output aria-live="polite" className="min-w-12 text-center text-xs tabular-nums">
                  {Math.round(zoom * 100)}%
                </output>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="w-8 px-0"
                  disabled={zoom >= 32}
                  aria-label="Zoom in timeline"
                  onClick={() => setZoom((value) => value * 2)}
                >
                  +
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={zoom === 1}
                  onClick={() => setZoom(1)}
                >
                  Fit timeline
                </Button>
              </div>
              {running && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-pressed={follow}
                  className="aria-pressed:text-primary"
                  onClick={() => setFollow((value) => !value)}
                >
                  <Radio aria-hidden="true" />
                  Follow now
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!laneIds.length}
                onClick={() => setExpanded(allExpanded ? new Set() : new Set(laneIds))}
              >
                {allExpanded ? <ChevronsDownUp aria-hidden="true" /> : <ChevronsUpDown aria-hidden="true" />}
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </Button>
              <Button
                ref={expandRef}
                type="button"
                size="sm"
                aria-expanded={wide}
                onClick={() => setWide((value) => !value)}
              >
                {wide ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
                {wide ? 'Exit full screen' : 'Expand workspace'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3 pb-2">
              <div className="grid gap-0.5">
                <strong className="text-sm font-semibold">Process timeline</strong>
                <span className="font-mono text-xs text-muted-foreground">
                  {order.mode.toUpperCase()} · {topology?.graph_version ?? order.graph_version}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <i
                    className="size-2.5 rounded-sm border border-primary/60 bg-primary/30"
                    aria-hidden="true"
                  />
                  Recorded
                </span>
                <span className="flex items-center gap-1.5">
                  <i
                    className="size-2.5 rounded-sm border border-dashed border-timeline-planned"
                    aria-hidden="true"
                  />
                  Planned
                </span>
                <span className="flex items-center gap-1.5">
                  <i className="size-2.5 rounded-sm bg-timeline-failure" aria-hidden="true" />
                  Error
                </span>
              </div>
            </div>
            {overflowing && (
              <div
                ref={minimapRef}
                role="slider"
                tabIndex={0}
                aria-label="Timeline overview"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(view.left * 100)}
                aria-valuetext={`Showing ${Math.round(view.left * 100)}% to ${Math.round((view.left + view.width) * 100)}% of the run`}
                onPointerDown={scrubMinimap}
                onKeyDown={(event) => {
                  const box = scrollRef.current;
                  if (!box) return;
                  if (event.key === 'ArrowRight') box.scrollLeft += box.clientWidth / 4;
                  if (event.key === 'ArrowLeft') box.scrollLeft -= box.clientWidth / 4;
                  if (event.key === 'Home') box.scrollLeft = 0;
                  if (event.key === 'End') box.scrollLeft = box.scrollWidth;
                }}
                className="relative mx-4 mb-2 h-7 cursor-pointer touch-none overflow-hidden rounded-md border border-border bg-code"
              >
                {stageSpans.map((span) => (
                  <span
                    key={span.id}
                    aria-hidden="true"
                    className={cn(
                      'absolute top-2 h-3 rounded-sm',
                      span.event.state === 'failed' ? 'bg-timeline-failure' : 'bg-primary/60',
                    )}
                    style={{
                      left: `${fraction(span.start!) * 100}%`,
                      width: `${Math.max(0.6, (fraction(span.end ?? end) - fraction(span.start!)) * 100)}%`,
                    }}
                  />
                ))}
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 rounded-sm border-2 border-primary bg-primary/10"
                  style={{ left: `${view.left * 100}%`, width: `${view.width * 100}%` }}
                />
              </div>
            )}
            <div
              ref={scrollRef}
              tabIndex={0}
              role="region"
              aria-label="Scrollable process timeline"
              aria-describedby={`${tooltipId}-help`}
              onScroll={measure}
              onPointerDown={startPan}
              onWheel={(event) => {
                if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaX) > 0) setFollow(false);
              }}
              onKeyDown={(event) => {
                if ((event.target as HTMLElement) !== event.currentTarget) return;
                if (event.key === '+' || event.key === '=') setZoom((value) => value * 2);
                if (event.key === '-') setZoom((value) => value / 2);
                if (event.key === '0') setZoom(1);
              }}
              className={cn(
                'relative min-h-0 overflow-auto overscroll-x-contain data-[panning=true]:cursor-grabbing',
                wide && 'flex-1',
              )}
            >
              <span id={`${tooltipId}-help`} className="sr-only">
                Use Control or Command with the wheel, or pinch, to zoom at the pointer. Drag to pan. Keys
                plus, minus and zero zoom when the timeline has focus.
              </span>
              <div className="relative min-w-[44rem]" style={{ width: `${zoom * 100}%` }}>
                <div className="sticky top-0 z-20 grid grid-cols-[11rem_minmax(0,1fr)] border-y border-border bg-secondary/95 backdrop-blur">
                  <div className="sticky left-0 z-10 bg-secondary px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Phase / specialist
                  </div>
                  <div className="relative h-8">
                    {ticks(horizon, zoom).map((tick, index, all) => (
                      <span
                        key={tick.ms}
                        className={cn(
                          'absolute top-0 flex h-full items-center border-l border-border/70 pl-1 font-mono text-xs whitespace-nowrap text-muted-foreground',
                          index === all.length - 1 &&
                            index > 0 &&
                            tick.fraction > 0.94 &&
                            '-translate-x-full border-r border-l-0 pr-1 pl-0',
                        )}
                        style={{ left: `${tick.fraction * 100}%` }}
                      >
                        {tick.label}
                      </span>
                    ))}
                    {running && origin != null && (
                      <span className="absolute top-0 right-0 flex h-full items-center rounded-l-sm bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                        Now
                      </span>
                    )}
                  </div>
                </div>
                {laneIds.map((id) => {
                  const descriptor = registered.find((item) => item.id === id);
                  const activities = spans.filter((span) => laneFor(span) === id);
                  const stages = activities.filter((span) => span.event.kind === 'stage');
                  const children = activities.filter((span) => span.event.kind !== 'stage');
                  const isSelected = selectedLane === id;
                  const failed = activities.some((span) => span.event.state === 'failed');
                  return (
                    <div key={id} data-lane={id} data-failed={failed || undefined}>
                      <div
                        className={cn(
                          'grid grid-cols-[11rem_minmax(0,1fr)] border-b border-border',
                          isSelected && 'bg-accent/40',
                        )}
                        style={{ minHeight: `${Math.max(64, stages.length * ROW + 14)}px` }}
                      >
                        <div
                          className={cn(
                            'sticky left-0 z-10 border-r border-border bg-card',
                            isSelected && 'bg-accent shadow-[inset_3px_0_0_var(--primary)]',
                          )}
                        >
                          <button
                            type="button"
                            aria-expanded={expanded.has(id)}
                            onClick={() => {
                              setSelected(`phase:${id}`);
                              setExpanded((prior) => {
                                const next = new Set(prior);
                                if (next.has(id)) next.delete(id);
                                else next.add(id);
                                return next;
                              });
                            }}
                            className="flex h-full w-full cursor-pointer items-start gap-2 px-2.5 py-2.5 text-left hover:bg-hover/40"
                          >
                            <ChevronRight
                              className={cn(
                                'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
                                expanded.has(id) && 'rotate-90',
                              )}
                              aria-hidden="true"
                            />
                            <span className="grid min-w-0 gap-0.5">
                              <strong className="truncate text-sm font-semibold">
                                {descriptor?.label ?? id}
                              </strong>
                              <small className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                                <CrewAvatar role={descriptor?.specialist} size={16} />
                                {descriptor?.specialist ?? 'Recorded activity'}
                              </small>
                              <small className="truncate text-xs text-muted-foreground">
                                {children.length
                                  ? `${children.length} actions`
                                  : activities.length
                                    ? 'Recorded'
                                    : 'Planned · not started'}
                              </small>
                            </span>
                          </button>
                        </div>
                        <div
                          className={cn(
                            'relative',
                            !stages.length &&
                              'bg-[repeating-linear-gradient(90deg,transparent_0_8px,var(--border)_8px_9px)] bg-[length:100%_1px] bg-center bg-no-repeat',
                          )}
                        >
                          {stages.length ? (
                            stages.map((span, index) =>
                              renderBar(
                                span,
                                index,
                                stages.filter((item) => item.event.name === span.event.name).length,
                                stages
                                  .slice(0, index + 1)
                                  .filter((item) => item.event.name === span.event.name).length,
                              ),
                            )
                          ) : (
                            <span className="absolute top-1/2 left-3 -translate-y-1/2 rounded-sm bg-card px-1.5 text-xs text-muted-foreground">
                              {activities.length ? 'No phase duration recorded' : 'Waiting for this phase'}
                            </span>
                          )}
                        </div>
                      </div>
                      {expanded.has(id) &&
                        children.map((span) => (
                          <div
                            key={span.id}
                            data-testid="timeline-child-row"
                            className="grid min-h-[42px] grid-cols-[11rem_minmax(0,1fr)] border-b border-border/60 bg-background/40"
                          >
                            <div className="sticky left-0 z-10 flex min-w-0 items-center gap-2 border-r border-border bg-card py-1.5 pr-2 pl-8">
                              <span className="shrink-0 rounded-sm bg-secondary px-1 font-mono text-xs text-muted-foreground">
                                {span.event.kind === 'tool' && memoryTools.has(span.event.name)
                                  ? 'memory'
                                  : span.event.kind}
                              </span>
                              <strong className="truncate text-xs font-medium">
                                {specialistNames[span.event.name] ?? span.event.name}
                              </strong>
                            </div>
                            <div className="relative">
                              {span.start == null ? (
                                <button
                                  type="button"
                                  className="absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer rounded-sm border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => pin(span)}
                                >
                                  {span.event.name} · timing unavailable
                                </button>
                              ) : (
                                renderBar(span, 0, 1)
                              )}
                            </div>
                          </div>
                        ))}
                    </div>
                  );
                })}
                {!laneIds.length && (
                  <p className="p-6 text-sm text-muted-foreground">
                    Loading the registered process. Execution data remains available independently.
                  </p>
                )}
              </div>
            </div>
            {!!topology?.alternatives.length && (
              <div className="border-t border-border px-4 py-2">
                <Disclosure variant="plain" summary="Alternative routes · repair and human decisions">
                  {topology.alternatives.map((route, index) => (
                    <p key={index} className="grid gap-0.5 text-sm">
                      <strong className="font-medium">
                        {route.source} → {route.target}
                      </strong>
                      <span className="text-xs text-muted-foreground">{route.condition}</span>
                    </p>
                  ))}
                </Disclosure>
              </div>
            )}
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              {running
                ? 'Live elapsed ruler · usage updates after each provider response.'
                : 'Saved execution · timing uses recorded boundaries.'}{' '}
              Planned lanes describe the registered flow; empty lanes are not execution evidence.
            </p>
          </section>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            aria-valuemin={INSPECTOR_MIN}
            aria-valuenow={inspectorWidth}
            tabIndex={0}
            onPointerDown={resizeInspector}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') setInspectorWidth((value) => value + 24);
              if (event.key === 'ArrowRight')
                setInspectorWidth((value) => Math.max(INSPECTOR_MIN, value - 24));
            }}
            className="hidden w-1.5 cursor-col-resize touch-none bg-border/60 transition-colors hover:bg-primary/60 focus-visible:bg-primary @[64rem]/workspace:block"
          />
          <div
            className={cn(
              'min-w-0 border-t border-border @[64rem]/workspace:border-t-0',
              wide
                ? 'overflow-y-auto'
                : '@[64rem]/workspace:max-h-[46rem] @[64rem]/workspace:overflow-y-auto',
            )}
          >
            <RunInspector
              currentStop={currentStop}
              historicalSelection={historicalSelection}
              api={api}
              current={current}
              lane={lane}
              order={order}
              inspection={inspection}
              error={inspectorError}
              onInspect={onInspect}
              onMore={onMore}
            />
          </div>
        </div>
      </div>
      {preview && (
        <div
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none fixed right-4 bottom-24 z-[60] grid max-w-xs gap-0.5 rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-xl lg:bottom-6"
        >
          <strong className="font-semibold">
            {preview.event.name} · {preview.event.state}
          </strong>
          <span className="text-xs text-muted-foreground">
            {duration(preview.event.duration_ms)} · {preview.event.kind} · {preview.event.phase}
          </span>
          <small className="text-xs text-muted-foreground">Click to pin details · Escape to dismiss</small>
        </div>
      )}
      <Disclosure summary="Immutable configuration and global state" className={cn(wide && 'hidden')}>
        <JsonView
          value={{
            id: order.id,
            status: order.status,
            phase: order.phase,
            plan_revision: order.plan_revision,
            budget: order.budget,
            flow_config: order.flow_config,
            resolved_flow: order.resolved_flow,
            tasks: order.tasks,
            error_code: order.error_code,
          }}
          label="Global run state"
        />
      </Disclosure>
    </div>
  );
}

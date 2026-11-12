/** Pure time-axis math for the process timeline. */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Readable tick steps, smallest first. */
export const NICE_STEPS = [
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  200,
  500,
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  24 * HOUR,
];

export interface Tick {
  ms: number;
  /** Position along the track, 0 to 1. */
  fraction: number;
  label: string;
}

/** Smallest readable step that yields at most `target` intervals across the horizon. */
export function tickStep(horizonMs: number, target: number): number {
  const wanted = Math.max(horizonMs, 1) / Math.max(1, target);
  return NICE_STEPS.find((step) => step >= wanted) ?? Math.ceil(wanted / (24 * HOUR)) * 24 * HOUR;
}

/** Label an instant with the resolution its step needs, so neighbouring ticks never repeat. */
export function formatTick(ms: number, step: number): string {
  if (step < SECOND) return ms < SECOND ? `${ms} ms` : `${(ms / SECOND).toFixed(step < 100 ? 2 : 1)} s`;
  if (step < MINUTE && ms < MINUTE) return `${Math.round(ms / SECOND)} s`;
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const seconds = Math.round((ms % MINUTE) / SECOND);
  const mmss = `${minutes}:${String(seconds).padStart(2, '0')}`;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return step >= MINUTE ? `${minutes} min` : mmss;
}

/**
 * Ticks for a horizon. About five intervals at 100% zoom, more as the track widens; the
 * last tick may fall before the horizon end, never after it.
 */
export function ticks(horizonMs: number, zoom = 1): Tick[] {
  const horizon = Math.max(horizonMs, 1);
  const step = tickStep(horizon, Math.round(5 * Math.max(zoom, 0.25)));
  const result: Tick[] = [];
  for (let ms = 0; ms <= horizon + 1e-6 && result.length < 200; ms += step)
    result.push({ ms, fraction: ms / horizon, label: formatTick(ms, step) });
  return result;
}

/** Zoom bounds: 100% fits the horizon; 3200% shows sub-second detail on long runs. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 32;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Continuous zoom from a wheel or pinch delta (negative delta zooms in). */
export function wheelZoom(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY * 0.0015));
}

/**
 * Scroll offset that keeps the instant under the cursor fixed while the content scales from
 * `previous` to `next`. `cursor` is measured from the scroll container's left edge.
 */
export function anchoredScroll(scrollLeft: number, cursor: number, previous: number, next: number): number {
  if (previous <= 0) return scrollLeft;
  return Math.max(0, (scrollLeft + cursor) * (next / previous) - cursor);
}

/** Visible window of the scroll content as fractions (0 to 1) for the minimap. */
export function viewportWindow(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: number; width: number } {
  if (scrollWidth <= 0 || clientWidth >= scrollWidth) return { left: 0, width: 1 };
  const width = clientWidth / scrollWidth;
  return { left: Math.min(1 - width, Math.max(0, scrollLeft / scrollWidth)), width };
}

/** Scroll offset that centres the visible window on a fraction of the content. */
export function scrollForCentre(fraction: number, clientWidth: number, scrollWidth: number): number {
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.min(max, Math.max(0, fraction * scrollWidth - clientWidth / 2));
}

/** A stretch with no recorded activity, drawn at a fixed small width when idle time is collapsed. */
export interface IdleGap {
  start: number;
  end: number;
  /** Position of the drawn band along the track, 0 to 1. */
  from: number;
  to: number;
}

/**
 * Time axis for one run. With `collapse`, every stretch without activity that lasts at least a
 * minute and a tenth of the run is drawn as a narrow band, so minutes of work stay readable next
 * to hours of pause. Positions stay monotonic and ticks keep showing real elapsed time.
 */
export interface TimeAxis {
  origin: number;
  end: number;
  horizon: number;
  gaps: IdleGap[];
  fraction: (ms: number) => number;
  ticks: (zoom?: number) => Tick[];
}

export const IDLE_MIN_MS = MINUTE;
export const IDLE_MIN_SHARE = 0.1;
/** Share of the drawn track each collapsed gap takes. */
export const IDLE_BAND_SHARE = 0.04;

export function idleGaps(intervals: [number, number][], origin: number, end: number): [number, number][] {
  const horizon = Math.max(1, end - origin);
  const merged = intervals
    .map(
      ([start, stop]) => [Math.max(origin, start), Math.min(end, Math.max(start, stop))] as [number, number],
    )
    .filter(([start, stop]) => stop >= start)
    .sort((a, b) => a[0] - b[0])
    .reduce<[number, number][]>((all, [start, stop]) => {
      const last = all.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], stop);
      else all.push([start, stop]);
      return all;
    }, []);
  const gaps: [number, number][] = [];
  let cursor = origin;
  for (const [start, stop] of merged) {
    if (start - cursor >= Math.max(IDLE_MIN_MS, IDLE_MIN_SHARE * horizon)) gaps.push([cursor, start]);
    cursor = Math.max(cursor, stop);
  }
  return gaps;
}

export function timeAxis(
  origin: number,
  end: number,
  intervals: [number, number][] = [],
  collapse = false,
): TimeAxis {
  const horizon = Math.max(1000, end - origin);
  const real = (ms: number) => Math.max(0, Math.min(1, (ms - origin) / horizon));
  const raw = collapse ? idleGaps(intervals, origin, origin + horizon) : [];
  if (!raw.length)
    return { origin, end, horizon, gaps: [], fraction: real, ticks: (zoom = 1) => ticks(horizon, zoom) };
  const idle = raw.reduce((sum, [start, stop]) => sum + (stop - start), 0);
  const active = Math.max(1, horizon - idle);
  // Each band gets a fixed share of the drawn track; active time shares the rest.
  const bandShare = Math.min(IDLE_BAND_SHARE, 0.5 / raw.length);
  const activeShare = 1 - bandShare * raw.length;
  const fraction = (ms: number) => {
    const t = Math.max(origin, Math.min(origin + horizon, ms));
    let activeBefore = 0;
    let bands = 0;
    let cursor = origin;
    for (const [start, stop] of raw) {
      if (t < start) break;
      activeBefore += start - cursor;
      if (t < stop)
        return (activeBefore / active) * activeShare + (bands + (t - start) / (stop - start)) * bandShare;
      bands += 1;
      cursor = stop;
    }
    activeBefore += t - cursor;
    return Math.min(1, (activeBefore / active) * activeShare + bands * bandShare);
  };
  const gaps = raw.map(([start, stop]) => ({ start, end: stop, from: fraction(start), to: fraction(stop) }));
  const axisTicks = (zoom = 1): Tick[] => {
    // Readable steps over active time, labelled with real elapsed time; none inside a band.
    const step = tickStep(active, Math.round(5 * Math.max(zoom, 0.25)));
    const result: Tick[] = [];
    let cursor = origin;
    const segments = [...raw, [origin + horizon, origin + horizon] as [number, number]];
    for (const [start, stop] of segments) {
      const first = Math.ceil((cursor - origin) / step) * step;
      for (let ms = first; origin + ms <= start + 1e-6 && result.length < 200; ms += step)
        result.push({ ms, fraction: fraction(origin + ms), label: formatTick(ms, step) });
      cursor = stop;
    }
    return result;
  };
  return { origin, end, horizon, gaps, fraction, ticks: axisTicks };
}

/** "1 h 58 min" style duration for idle bands. */
export function idleLabel(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

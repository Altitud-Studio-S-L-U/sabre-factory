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

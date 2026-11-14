import type { RunMetrics } from '../../api';

/** What a figure reads as when nothing measured it. Never a zero, never a dash that could pass for one. */
export const UNKNOWN = 'Unknown';

export const OUTCOMES = [
  { key: 'completed', label: 'Completed', swatch: 'bg-chart-completed' },
  { key: 'stopped', label: 'Stopped', swatch: 'bg-chart-stopped' },
  { key: 'open', label: 'Open', swatch: 'bg-chart-open' },
  { key: 'cancelled', label: 'Cancelled', swatch: 'bg-chart-cancelled' },
] as const;

export type OutcomeKey = (typeof OUTCOMES)[number]['key'];

export interface Bucket extends Record<OutcomeKey, number> {
  key: string;
  label: string;
  started: number;
  measured_tokens: number;
}

const DAY = 86_400_000;
const dayLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const whole = new Intl.NumberFormat('en-US');
const short = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * The window as a continuous series, oldest first: one bucket per UTC day, or per week once the
 * window is longer than a month. Days without runs are zeros, because no run was created on them.
 */
export function buckets(metrics: Pick<RunMetrics, 'window_days' | 'generated_at' | 'by_day'>): Bucket[] {
  const generated = new Date(metrics.generated_at);
  const today = Date.UTC(generated.getUTCFullYear(), generated.getUTCMonth(), generated.getUTCDate());
  const recorded = new Map(metrics.by_day.map((item) => [item.day, item]));
  const size = metrics.window_days > 31 ? 7 : 1;
  const result: Bucket[] = [];
  for (let offset = metrics.window_days - 1; offset >= 0; offset -= 1) {
    const time = today - offset * DAY;
    const day = recorded.get(new Date(time).toISOString().slice(0, 10));
    // Chunks are counted back from today, so the newest bucket is always a whole one.
    const first = offset % size === size - 1 || offset === metrics.window_days - 1;
    if (first)
      result.push({
        key: new Date(time).toISOString().slice(0, 10),
        label: dayLabel.format(time),
        started: 0,
        completed: 0,
        stopped: 0,
        open: 0,
        cancelled: 0,
        measured_tokens: 0,
      });
    const bucket = result[result.length - 1];
    if (!first && offset % size === 0) bucket.label = `${bucket.label} – ${dayLabel.format(time)}`;
    if (!day) continue;
    bucket.started += day.started;
    bucket.completed += day.completed;
    bucket.stopped += day.stopped;
    bucket.cancelled += day.cancelled;
    bucket.open += Math.max(0, day.started - day.completed - day.stopped - day.cancelled);
    bucket.measured_tokens += day.measured_tokens;
  }
  return result;
}

/** A count axis: whole ticks from zero to a round value at or above the largest count. */
export function countAxis(largest: number): { top: number; ticks: number[] } {
  const rough = Math.max(1, largest) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
  const step = Math.max(
    1,
    [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ?? 1,
  );
  const top = Math.max(step, Math.ceil(Math.max(1, largest) / step) * step);
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, index) => index * step) };
}

/** 1,284 in full; 12.9K and 4.2M once the number is long enough to be skimmed. */
export function compact(value: number): string {
  return Math.abs(value) < 10_000 ? whole.format(value) : short.format(value);
}

export function full(value: number): string {
  return whole.format(value);
}

/** A share between 0 and 1 as a percentage with one decimal, or null when it is unknown. */
export function percent(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const scaled = value * 100;
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}%`;
}

export function usd(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // A cost too small to show at two decimals is still a cost: it is not printed as zero.
  if (value > 0 && value < 0.01) return '< $0.01';
  return dollars.format(value);
}

export function duration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  if (minutes < 60) return rounded % 60 ? `${minutes}m ${rounded % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

const FAILURE_LABELS: Record<string, string> = {
  rate_limit: 'Rate limit',
  overloaded: 'Provider overloaded',
  timeout: 'Timeout',
  authentication: 'Authentication',
  invalid_request: 'Invalid request',
  other: 'Other',
};

export function failureLabel(name: string): string {
  return FAILURE_LABELS[name] ?? name;
}

const ROLE_LABELS: Record<string, string> = {
  analyst: 'Analyst',
  planner: 'Planner',
  designer: 'Designer',
  developer: 'Developer',
  qa: 'QA',
  reviewer: 'Reviewer',
  security: 'Security',
  devops: 'DevOps',
};

export function roleLabel(role: string | null): string {
  if (role === null) return 'No specialist recorded';
  return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

const MODE_LABELS: Record<string, string> = {
  create: 'Create',
  patch: 'Patch',
  maintain: 'Maintain',
  audit: 'Audit',
};

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

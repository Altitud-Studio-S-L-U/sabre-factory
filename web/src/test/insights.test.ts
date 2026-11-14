import { describe, expect, it } from 'vitest';
import {
  buckets,
  compact,
  countAxis,
  duration,
  failureLabel,
  modeLabel,
  percent,
  roleLabel,
  usd,
} from '../features/insights/insights';

const day = (value: string, started: number, completed = 0, stopped = 0, cancelled = 0, tokens = 0) => ({
  day: value,
  started,
  completed,
  stopped,
  cancelled,
  measured_tokens: tokens,
});

describe('the window as a series', () => {
  it('has one bucket per UTC day, today included, with zeros where no run was created', () => {
    const series = buckets({
      window_days: 7,
      generated_at: '2026-11-14T23:30:00Z',
      by_day: [day('2026-11-08', 2, 1, 1), day('2026-11-14', 3, 1, 0, 1, 500)],
    });
    expect(series.map((item) => item.key)).toEqual([
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
    ]);
    expect(series[0]).toMatchObject({ label: 'Nov 8', started: 2, completed: 1, stopped: 1, open: 0 });
    expect(series[3]).toMatchObject({ started: 0, completed: 0, stopped: 0, cancelled: 0, open: 0 });
    // Three created, one delivered and one cancelled: the third is still open.
    expect(series[6]).toMatchObject({
      started: 3,
      completed: 1,
      cancelled: 1,
      open: 1,
      measured_tokens: 500,
    });
  });

  it('groups a window longer than a month by week, counted back from today', () => {
    const series = buckets({
      window_days: 90,
      generated_at: '2026-11-14T08:00:00Z',
      by_day: [
        day('2026-11-14', 1, 1),
        day('2026-11-08', 2, 0, 2),
        day('2026-11-07', 4, 4),
        day('2026-08-17', 1),
      ],
    });
    // Twelve whole weeks and the six days left at the start of the window.
    expect(series).toHaveLength(13);
    expect(series.at(-1)).toMatchObject({
      key: '2026-11-08',
      label: 'Nov 8 – Nov 14',
      started: 3,
      completed: 1,
      stopped: 2,
    });
    expect(series.at(-2)).toMatchObject({
      key: '2026-11-01',
      label: 'Nov 1 – Nov 7',
      started: 4,
      completed: 4,
    });
    expect(series[0]).toMatchObject({ key: '2026-08-17', label: 'Aug 17 – Aug 22', started: 1, open: 1 });
    expect(series.reduce((sum, item) => sum + item.started, 0)).toBe(8);
  });

  it('never counts fewer than zero open runs when the outcomes outnumber the runs created', () => {
    const [only] = buckets({
      window_days: 1,
      generated_at: '2026-11-14T08:00:00Z',
      by_day: [day('2026-11-14', 1, 1, 1)],
    });
    expect(only.open).toBe(0);
  });
});

describe('the count axis', () => {
  it.each([
    [0, 1, [0, 1]],
    [1, 1, [0, 1]],
    [3, 3, [0, 1, 2, 3]],
    [7, 8, [0, 2, 4, 6, 8]],
    [23, 30, [0, 10, 20, 30]],
    [100, 100, [0, 50, 100]],
    [1234, 1500, [0, 500, 1000, 1500]],
  ])('covers %i with whole ticks up to %i', (largest, top, ticks) => {
    expect(countAxis(largest)).toEqual({ top, ticks });
  });
});

describe('figures as text', () => {
  it('prints an unknown value as nothing to format and a measured zero as a zero', () => {
    expect(percent(null)).toBeNull();
    expect(percent(undefined)).toBeNull();
    expect(usd(null)).toBeNull();
    expect(duration(null)).toBeNull();
    expect(percent(0)).toBe('0%');
    expect(usd(0)).toBe('$0.00');
    expect(duration(0)).toBe('0s');
  });

  it('formats shares, money, durations and counts for reading', () => {
    expect(percent(0.6842)).toBe('68.4%');
    expect(percent(0.05)).toBe('5%');
    expect(percent(1)).toBe('100%');
    expect(usd(3.4187)).toBe('$3.42');
    // A cost below a cent is not rounded down to nothing.
    expect(usd(0.004)).toBe('< $0.01');
    expect(duration(45)).toBe('45s');
    expect(duration(1260)).toBe('21m');
    expect(duration(1295)).toBe('21m 35s');
    expect(duration(3900)).toBe('1h 5m');
    expect(duration(7200)).toBe('2h');
    expect(compact(1284)).toBe('1,284');
    expect(compact(12_900)).toBe('12.9K');
    expect(compact(4_200_000)).toBe('4.2M');
  });

  it('names failure classes, specialists and flows, and keeps a name it does not know', () => {
    expect(failureLabel('rate_limit')).toBe('Rate limit');
    expect(failureLabel('something_new')).toBe('something_new');
    expect(roleLabel('qa')).toBe('QA');
    expect(roleLabel('researcher')).toBe('Researcher');
    expect(roleLabel(null)).toBe('No specialist recorded');
    expect(modeLabel('audit')).toBe('Audit');
    expect(modeLabel('custom')).toBe('custom');
  });
});

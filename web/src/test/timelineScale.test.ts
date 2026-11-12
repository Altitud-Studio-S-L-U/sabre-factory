import { describe, expect, it } from 'vitest';
import { formatTick, tickStep, ticks } from '../features/runs/timelineScale';

describe('timeline scale', () => {
  it('never repeats a label across a short run', () => {
    for (const horizon of [1, 40, 999, 1_200, 4_500, 61_000, 3_700_000, 90_000_000]) {
      const labels = ticks(horizon).map((tick) => tick.label);
      expect(new Set(labels).size, `${horizon} ms: ${labels.join(' ')}`).toBe(labels.length);
      expect(labels.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('chooses readable steps and units for the horizon', () => {
    expect(ticks(1_200).map((tick) => tick.label)).toEqual(['0 ms', '500 ms', '1.0 s']);
    expect(ticks(61_000).map((tick) => tick.label)).toEqual(['0 s', '15 s', '30 s', '45 s', '1:00']);
    expect(ticks(30 * 60_000).map((tick) => tick.label)).toEqual(['0 min', '10 min', '20 min', '30 min']);
    expect(formatTick(3_725_000, 60_000)).toBe('1:02:05');
  });

  it('adds ticks as the track is zoomed and keeps them within the horizon', () => {
    expect(ticks(60_000, 4).length).toBeGreaterThan(ticks(60_000, 1).length);
    for (const tick of ticks(7_777, 3)) expect(tick.fraction).toBeLessThanOrEqual(1);
    expect(tickStep(10_000, 5)).toBe(2_000);
  });
});

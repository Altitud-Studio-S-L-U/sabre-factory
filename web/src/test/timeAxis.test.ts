import { describe, expect, it } from 'vitest';
import { IDLE_BAND_SHARE, idleGaps, idleLabel, timeAxis } from '../features/runs/timelineScale';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('idle time on the process timeline', () => {
  it('finds stretches without activity that are long in absolute and relative terms', () => {
    const gaps = idleGaps(
      [
        [0, 2 * MIN],
        [90_000, 3 * MIN],
        [2 * HOUR, 2 * HOUR + 4 * MIN],
      ],
      0,
      2 * HOUR + 4 * MIN,
    );
    expect(gaps).toEqual([[3 * MIN, 2 * HOUR]]);
    // Short pauses between steps are work rhythm, not idle time.
    expect(
      idleGaps(
        [
          [0, MIN],
          [MIN + 30_000, 3 * MIN],
        ],
        0,
        3 * MIN,
      ),
    ).toEqual([]);
  });

  it('keeps the plain proportional axis when idle time is not collapsed', () => {
    const axis = timeAxis(
      0,
      2 * HOUR,
      [
        [0, MIN],
        [HOUR + 59 * MIN, 2 * HOUR],
      ],
      false,
    );
    expect(axis.gaps).toEqual([]);
    expect(axis.fraction(HOUR)).toBeCloseTo(0.5);
  });

  it('draws a two-hour pause as one narrow band and gives the rest to active time', () => {
    const intervals: [number, number][] = [
      [0, 3 * MIN],
      [2 * HOUR, 2 * HOUR + 3 * MIN],
    ];
    const axis = timeAxis(0, 2 * HOUR + 3 * MIN, intervals, true);
    expect(axis.gaps).toHaveLength(1);
    const [gap] = axis.gaps;
    expect(gap.to - gap.from).toBeCloseTo(IDLE_BAND_SHARE);
    expect(axis.fraction(3 * MIN)).toBeCloseTo(gap.from);
    // Equal active durations get equal widths on both sides of the band.
    expect(gap.from).toBeCloseTo(1 - gap.to);
    expect(axis.fraction(2 * HOUR + 3 * MIN)).toBeCloseTo(1);
    // Positions never go backwards.
    let previous = -1;
    for (let ms = 0; ms <= 2 * HOUR + 3 * MIN; ms += 30_000) {
      const value = axis.fraction(ms);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('labels ticks with real elapsed time and never inside a band', () => {
    const axis = timeAxis(
      0,
      2 * HOUR + 3 * MIN,
      [
        [0, 3 * MIN],
        [2 * HOUR, 2 * HOUR + 3 * MIN],
      ],
      true,
    );
    const labels = axis.ticks();
    const [gap] = axis.gaps;
    expect(labels.some((tick) => tick.ms >= 2 * HOUR)).toBe(true);
    expect(labels.every((tick) => tick.ms <= gap.start - 0 || tick.ms >= gap.end)).toBe(true);
    expect(labels.find((tick) => tick.ms === 2 * HOUR)?.label).toBe('2:00:00');
  });

  it('describes band durations in hours and minutes', () => {
    expect(idleLabel(118 * MIN)).toBe('1 h 58 min');
    expect(idleLabel(45 * MIN)).toBe('45 min');
    expect(idleLabel(2 * HOUR)).toBe('2 h');
  });
});

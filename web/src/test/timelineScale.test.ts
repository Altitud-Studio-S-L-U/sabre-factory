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

describe('timeline zoom and minimap', () => {
  it('clamps zoom and turns wheel deltas into continuous steps', async () => {
    const { clampZoom, wheelZoom, MAX_ZOOM } = await import('../features/runs/timelineScale');
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(999)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(wheelZoom(2, -100)).toBeGreaterThan(2);
    expect(wheelZoom(2, 100)).toBeLessThan(2);
    expect(wheelZoom(1, 500)).toBe(1);
  });

  it('keeps the instant under the cursor fixed while zooming', async () => {
    const { anchoredScroll } = await import('../features/runs/timelineScale');
    // 300 px into a 1000 px track at 100%: the same instant sits 600 px in at 200%.
    expect(anchoredScroll(0, 300, 1, 2)).toBe(300);
    expect(anchoredScroll(200, 100, 2, 4)).toBe(500);
    expect(anchoredScroll(0, 50, 2, 1)).toBe(0);
  });

  it('maps the scroll position to a minimap window and back', async () => {
    const { viewportWindow, scrollForCentre } = await import('../features/runs/timelineScale');
    expect(viewportWindow(0, 500, 500)).toEqual({ left: 0, width: 1 });
    expect(viewportWindow(500, 500, 2000)).toEqual({ left: 0.25, width: 0.25 });
    expect(scrollForCentre(0.5, 500, 2000)).toBe(750);
    expect(scrollForCentre(0, 500, 2000)).toBe(0);
    expect(scrollForCentre(1, 500, 2000)).toBe(1500);
  });
});

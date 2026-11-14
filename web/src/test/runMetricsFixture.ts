import type { RunFigures, RunMetrics } from '../api';

export function runFigures(overrides: Partial<RunFigures> = {}): RunFigures {
  return {
    runs: 0,
    completed: 0,
    cancelled: 0,
    stopped: 0,
    waiting: 0,
    active: 0,
    calls: 0,
    settled_calls: 0,
    unsettled_calls: 0,
    failed_calls: {},
    cli_calls: 0,
    measured_tokens: 0,
    unknown_reserved_tokens: 0,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    api_cost_usd: null,
    active_seconds: 0,
    median_tokens_per_completed_run: null,
    median_active_seconds_per_completed_run: null,
    cache_read_share: null,
    tool_calls: 0,
    recovery_ratio: null,
    ...overrides,
  };
}

/** A window with delivered, stopped, cancelled and open runs, charged through an API. */
export function runMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  const patch = runFigures({
    runs: 5,
    completed: 3,
    stopped: 1,
    active: 1,
    calls: 42,
    settled_calls: 40,
    unsettled_calls: 2,
    failed_calls: { rate_limit: 1 },
    measured_tokens: 1_840_000,
    unknown_reserved_tokens: 26_000,
    input_tokens: 1_760_000,
    output_tokens: 80_000,
    cache_read_tokens: 1_232_000,
    cache_write_tokens: 96_000,
    api_cost_usd: 3.4187,
    active_seconds: 5400,
    median_tokens_per_completed_run: 412_000,
    median_active_seconds_per_completed_run: 1260,
    cache_read_share: 0.7,
    tool_calls: 180,
    recovery_ratio: 0.05,
  });
  const audit = runFigures({
    runs: 2,
    completed: 1,
    cancelled: 1,
    calls: 14,
    settled_calls: 14,
    cli_calls: 14,
    measured_tokens: 310_000,
    active_seconds: 900,
    median_tokens_per_completed_run: 290_000,
    median_active_seconds_per_completed_run: 840,
    tool_calls: 60,
    recovery_ratio: 0,
  });
  return {
    version: 1,
    window_days: 30,
    mode: null,
    project_id: null,
    generated_at: '2026-11-14T12:00:00Z',
    truncated: false,
    totals: runFigures({
      ...patch,
      runs: 7,
      completed: 4,
      cancelled: 1,
      stopped: 1,
      active: 1,
      calls: 56,
      settled_calls: 54,
      cli_calls: 14,
      measured_tokens: 2_150_000,
      active_seconds: 6300,
      median_tokens_per_completed_run: 351_000,
      median_active_seconds_per_completed_run: 1050,
      tool_calls: 240,
      recovery_ratio: 0.0375,
    }),
    by_mode: [
      { ...audit, mode: 'audit' },
      { ...patch, mode: 'patch' },
    ],
    by_specialist: [
      {
        role: 'developer',
        calls: 24,
        measured_tokens: 1_200_000,
        input_tokens: 1_150_000,
        output_tokens: 50_000,
        cache_read_tokens: 862_500,
      },
      {
        role: 'analyst',
        calls: 20,
        measured_tokens: 700_000,
        input_tokens: 610_000,
        output_tokens: 30_000,
        cache_read_tokens: 0,
      },
      {
        role: null,
        calls: 12,
        measured_tokens: 250_000,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
      },
    ],
    by_day: [
      { day: '2026-11-03', started: 1, completed: 1, stopped: 0, cancelled: 0, measured_tokens: 290_000 },
      { day: '2026-11-10', started: 2, completed: 1, stopped: 0, cancelled: 1, measured_tokens: 440_000 },
      { day: '2026-11-12', started: 3, completed: 2, stopped: 1, cancelled: 0, measured_tokens: 1_300_000 },
      { day: '2026-11-14', started: 1, completed: 0, stopped: 0, cancelled: 0, measured_tokens: 120_000 },
    ],
    ...overrides,
  };
}

/** A window whose calls all ran through a CLI session and reported no split: tokens are known, the rest is not. */
export function unmeasuredRunMetrics(): RunMetrics {
  const totals = runFigures({
    runs: 2,
    stopped: 1,
    active: 1,
    calls: 9,
    settled_calls: 9,
    cli_calls: 9,
    measured_tokens: 237_000,
    active_seconds: 700,
  });
  return runMetrics({
    totals,
    by_mode: [{ ...totals, mode: 'audit' }],
    by_specialist: [
      {
        role: 'analyst',
        calls: 9,
        measured_tokens: 237_000,
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
      },
    ],
    by_day: [
      { day: '2026-11-13', started: 2, completed: 0, stopped: 1, cancelled: 0, measured_tokens: 237_000 },
    ],
  });
}

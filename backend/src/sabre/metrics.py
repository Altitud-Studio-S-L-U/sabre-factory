"""Figures across runs, derived on request from the ledger and the event log.

There is no second pipeline and nothing is sampled: a figure is a sum over the rows the factory
already keeps. What was not measured stays None, never zero: a call through a CLI session has no
price per token, an unsettled call has no token count, and a split the provider did not report is
unknown.
"""

from collections import defaultdict
from datetime import UTC, date, datetime
from statistics import median
from typing import Literal

from fastapi import FastAPI, Query
from psycopg import sql
from pydantic import Field

from sabre.contracts import Contract
from sabre.models import now

FAILURE_CLASSES = ("rate_limit", "overloaded", "timeout", "authentication", "invalid_request", "other")
CLI_PROVIDERS = ("codex_cli", "claude_cli")
MAX_RUNS = 5000
# How a run's status reads across runs: delivered, stopped by the owner, stopped by something else, or still going.
OUTCOMES = {"completed": "completed", "cancelled": "cancelled", "blocked": "stopped", "failed": "stopped", "paused": "stopped",
            "waiting_input": "waiting", "queued": "active", "running": "active"}


class Figures(Contract):
    runs: int = 0
    completed: int = 0
    cancelled: int = 0
    stopped: int = Field(default=0, description="Blocked, failed or paused")
    waiting: int = Field(default=0, description="Waiting for the owner's answer")
    active: int = Field(default=0, description="Queued or running")
    calls: int = 0
    settled_calls: int = 0
    unsettled_calls: int = Field(default=0, description="Calls whose outcome is unknown: their tokens are not counted as measured")
    failed_calls: dict[str, int] = Field(default_factory=dict, description="Unsettled calls by failure class")
    cli_calls: int = Field(default=0, description="Settled calls made through a CLI session, which has no price per token")
    measured_tokens: int = 0
    unknown_reserved_tokens: int = 0
    input_tokens: int | None = Field(default=None, description="None when no settled call reported the split")
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None
    api_cost_usd: float | None = Field(default=None, description="Charged through API prices; None when no settled call had one")
    reported_cost_usd: float | None = Field(
        default=None, description="What providers themselves reported their calls cost, such as a CLI session at API rates; not what was charged")
    active_seconds: float = 0
    median_tokens_per_completed_run: int | None = None
    median_active_seconds_per_completed_run: float | None = None
    cache_read_share: float | None = Field(default=None, description="Cached input over all input, where the split was reported")
    tool_calls: int = 0
    recovery_ratio: float | None = Field(default=None, description="Tool calls that paged back text already read, over all tool calls")


class ModeFigures(Figures):
    mode: str


class SpecialistFigures(Contract):
    role: str | None = Field(description="None for calls recorded without a specialist")
    calls: int
    measured_tokens: int
    input_tokens: int | None
    output_tokens: int | None
    cache_read_tokens: int | None


class DayFigures(Contract):
    day: date = Field(description="The UTC day the runs were created")
    started: int = 0
    completed: int = 0
    stopped: int = 0
    cancelled: int = 0
    measured_tokens: int = 0


class RunMetrics(Contract):
    version: Literal[1] = 1
    window_days: int = Field(description="Whole UTC days the window covers, today included")
    mode: str | None
    project_id: str | None
    generated_at: datetime
    truncated: bool = Field(description=f"True when the window holds more than {MAX_RUNS} runs and the oldest were left out")
    totals: Figures
    by_mode: list[ModeFigures]
    by_specialist: list[SpecialistFigures]
    by_day: list[DayFigures]


COUNTS = ("calls", "settled_calls", "cli_calls", "measured_tokens", "unknown_reserved_tokens", "tool_calls", "recoveries")
SPLITS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")


def whole(value) -> int | None:
    return None if value is None else int(value)


def plain(row: dict) -> dict:
    """One run's sums as Python numbers: PostgreSQL returns sums of integers as decimals."""
    for name in COUNTS:
        row[name] = int(row[name])
    for name in SPLITS:
        row[name] = whole(row[name])
    for name in ("api_cost_usd", "reported_cost_usd"):
        row[name] = None if row[name] is None else float(row[name])
    row["active_seconds"] = float(row["active_seconds"])
    return row


def known_sum(values):
    """The sum of what was reported; None when nothing was."""
    reported = [value for value in values if value is not None]
    return sum(reported) if reported else None


def share(part: int | None, total: int | None) -> float | None:
    return round(part / total, 4) if part is not None and total else None


def figures(runs: list[dict]) -> Figures:
    """Aggregate per-run rows. Each row carries one run's status, active time and its own sums from the ledger and the events."""
    result = Figures(runs=len(runs))
    for run in runs:
        outcome = OUTCOMES.get(run["status"], "stopped")
        setattr(result, outcome, getattr(result, outcome) + 1)
    result.calls = sum(run["calls"] for run in runs)
    result.settled_calls = sum(run["settled_calls"] for run in runs)
    result.unsettled_calls = result.calls - result.settled_calls
    failed: dict[str, int] = defaultdict(int)
    for run in runs:
        for name, count in (run["failed_calls"] or {}).items():
            if name in FAILURE_CLASSES:
                failed[name] += int(count)
    result.failed_calls = dict(sorted(failed.items()))
    result.cli_calls = sum(run["cli_calls"] for run in runs)
    result.measured_tokens = sum(run["measured_tokens"] for run in runs)
    result.unknown_reserved_tokens = sum(run["unknown_reserved_tokens"] for run in runs)
    for name in SPLITS:
        setattr(result, name, known_sum(run[name] for run in runs))
    for name in ("api_cost_usd", "reported_cost_usd"):
        cost = known_sum(run[name] for run in runs)
        setattr(result, name, None if cost is None else round(float(cost), 6))
    result.active_seconds = round(sum(run["active_seconds"] for run in runs), 3)
    completed = [run for run in runs if run["status"] == "completed"]
    if completed:
        result.median_tokens_per_completed_run = int(median(run["measured_tokens"] for run in completed))
        result.median_active_seconds_per_completed_run = round(float(median(run["active_seconds"] for run in completed)), 3)
    result.cache_read_share = share(result.cache_read_tokens, result.input_tokens)
    result.tool_calls = sum(run["tool_calls"] for run in runs)
    result.recovery_ratio = share(sum(run["recoveries"] for run in runs), result.tool_calls)
    return result


def by_day(runs: list[dict]) -> list[DayFigures]:
    days: dict[date, DayFigures] = {}
    for run in runs:
        key = run["created_at"].astimezone(UTC).date()
        day = days.setdefault(key, DayFigures(day=key))
        day.started += 1
        outcome = OUTCOMES.get(run["status"], "stopped")
        if outcome in {"completed", "stopped", "cancelled"}:
            setattr(day, outcome, getattr(day, outcome) + 1)
        day.measured_tokens += run["measured_tokens"]
    return [days[key] for key in sorted(days)]


# The runs of the window, newest first up to the bound. The window is whole UTC days, today included, so a
# figure per day covers the same runs as the totals. The security watch files its own work orders; they are not runs.
SELECTED = sql.SQL("""
WITH selected AS (
  SELECT id, data->>'mode' AS mode, data->>'status' AS status, (data->>'created_at')::timestamptz AS created_at,
         coalesce((data->>'active_seconds_used')::float8, 0) AS active_seconds
  FROM work_orders
  WHERE (data->>'created_at')::timestamptz
        >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - make_interval(days => %(days)s - 1)
    AND data->>'phase' IS DISTINCT FROM 'security_watch'
    AND (%(mode)s::text IS NULL OR data->>'mode' = %(mode)s)
    AND (%(project)s::text IS NULL OR project_id = %(project)s)
  ORDER BY (data->>'created_at')::timestamptz DESC, id LIMIT %(limit)s
)""")

RUNS_QUERY = SELECTED + sql.SQL(""", ledger AS (
  SELECT u.work_id, count(*) AS calls, count(u.actual_tokens) AS settled_calls,
         count(*) FILTER (WHERE u.actual_tokens IS NOT NULL AND u.context_receipt->>'model_provider' = ANY(%(cli)s)) AS cli_calls,
         coalesce(sum(u.actual_tokens), 0) AS measured_tokens,
         coalesce(sum(u.reserved_tokens) FILTER (WHERE u.actual_tokens IS NULL), 0) AS unknown_reserved_tokens,
         sum(u.input_tokens) AS input_tokens, sum(u.output_tokens) AS output_tokens,
         sum(u.cache_read_tokens) AS cache_read_tokens, sum(u.cache_write_tokens) AS cache_write_tokens,
         sum(u.actual_usd) FILTER (WHERE u.context_receipt->>'model_provider' IS NOT NULL
                                   AND NOT (u.context_receipt->>'model_provider' = ANY(%(cli)s))) AS api_cost_usd,
         sum(u.reported_usd) AS reported_cost_usd
  FROM model_usage u JOIN selected s ON s.id = u.work_id GROUP BY u.work_id
), failures AS (
  SELECT work_id, jsonb_object_agg(failure_class, total) AS failed_calls
  FROM (SELECT u.work_id, u.failure_class, count(*) AS total FROM model_usage u JOIN selected s ON s.id = u.work_id
        WHERE u.failure_class IS NOT NULL AND u.actual_tokens IS NULL GROUP BY u.work_id, u.failure_class) classes
  GROUP BY work_id
), tools AS (
  SELECT e.work_id, count(*) AS tool_calls, count(*) FILTER (WHERE e.data->>'name' = 'read_context') AS recoveries
  FROM run_events e JOIN selected s ON s.id = e.work_id
  WHERE e.data->>'kind' = 'tool' AND e.data->>'state' IN ('completed', 'failed') GROUP BY e.work_id
)
SELECT s.id, s.mode, s.status, s.created_at, s.active_seconds,
       coalesce(l.calls, 0) AS calls, coalesce(l.settled_calls, 0) AS settled_calls, coalesce(l.cli_calls, 0) AS cli_calls,
       coalesce(l.measured_tokens, 0) AS measured_tokens, coalesce(l.unknown_reserved_tokens, 0) AS unknown_reserved_tokens,
       l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_write_tokens, l.api_cost_usd, l.reported_cost_usd,
       f.failed_calls, coalesce(t.tool_calls, 0) AS tool_calls, coalesce(t.recoveries, 0) AS recoveries
FROM selected s LEFT JOIN ledger l ON l.work_id = s.id LEFT JOIN failures f ON f.work_id = s.id LEFT JOIN tools t ON t.work_id = s.id
ORDER BY s.created_at, s.id
""")

SPECIALISTS_QUERY = SELECTED + sql.SQL("""
SELECT u.context_receipt->>'role' AS role, count(*) AS calls, coalesce(sum(u.actual_tokens), 0) AS measured_tokens,
       sum(u.input_tokens) AS input_tokens, sum(u.output_tokens) AS output_tokens, sum(u.cache_read_tokens) AS cache_read_tokens
FROM model_usage u JOIN selected s ON s.id = u.work_id
GROUP BY 1 ORDER BY measured_tokens DESC, role NULLS LAST
""")


class RunMetricsService:
    def __init__(self, repository):
        self.repository = repository

    async def runs(self, days: int, mode: str | None = None, project_id: str | None = None) -> RunMetrics:
        values = {"days": days, "mode": mode, "project": project_id, "limit": MAX_RUNS + 1, "cli": list(CLI_PROVIDERS)}
        async with self.repository.connection() as conn:
            rows = [plain(dict(row)) for row in await (await conn.execute(RUNS_QUERY, values)).fetchall()]
            # The same bound as the runs kept below, so both views describe the same runs.
            specialists = await (await conn.execute(SPECIALISTS_QUERY, {**values, "limit": MAX_RUNS})).fetchall()
        truncated = len(rows) > MAX_RUNS
        # The query returns oldest first after taking the newest: the extra row, when there is one, is the oldest.
        rows = rows[1:] if truncated else rows
        modes: dict[str, list[dict]] = defaultdict(list)
        for row in rows:
            modes[row["mode"]].append(row)
        return RunMetrics(
            window_days=days, mode=mode, project_id=project_id, generated_at=now(), truncated=truncated, totals=figures(rows),
            by_mode=[ModeFigures(mode=name, **figures(items).model_dump()) for name, items in sorted(modes.items())],
            by_specialist=[SpecialistFigures(role=row["role"], calls=int(row["calls"]), measured_tokens=int(row["measured_tokens"]),
                                             input_tokens=whole(row["input_tokens"]), output_tokens=whole(row["output_tokens"]),
                                             cache_read_tokens=whole(row["cache_read_tokens"])) for row in specialists],
            by_day=by_day(rows))


def install_metrics_routes(app: FastAPI, service):
    @app.get("/api/v1/metrics/runs", response_model=RunMetrics)
    async def run_metrics(days: int = Query(default=30, ge=1, le=365),
                          mode: Literal["create", "patch", "maintain", "audit"] | None = None,
                          project_id: str | None = Query(default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")):
        return await RunMetricsService(service().repository).runs(days, mode, project_id)

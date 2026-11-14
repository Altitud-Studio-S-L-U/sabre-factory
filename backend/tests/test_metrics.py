"""Figures across runs: what is summed, what stays unknown, and what the endpoint accepts."""

from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import SecretStr

from sabre.api import create_app
from sabre.metrics import MAX_RUNS, SPECIALISTS_QUERY, RunMetrics, RunMetricsService, by_day, figures, plain

TOKEN = "owner-test-token-at-least-24"


def run(status="completed", **values):
    row = {"id": "work", "mode": "patch", "status": status, "created_at": datetime(2026, 11, 14, 9, tzinfo=UTC), "active_seconds": 10.0,
           "calls": 0, "settled_calls": 0, "cli_calls": 0, "measured_tokens": 0, "unknown_reserved_tokens": 0,
           "input_tokens": None, "output_tokens": None, "cache_read_tokens": None, "cache_write_tokens": None,
           "api_cost_usd": None, "failed_calls": None, "tool_calls": 0, "recoveries": 0}
    assert set(values) <= set(row)
    return row | values


def test_what_no_call_reported_stays_unknown_and_is_never_a_zero():
    # Two settled calls through a CLI session: tokens were measured, the split and a price per token were not.
    result = figures([run(calls=2, settled_calls=2, cli_calls=2, measured_tokens=500)])
    assert (result.calls, result.settled_calls, result.unsettled_calls, result.cli_calls, result.measured_tokens) == (2, 2, 0, 2, 500)
    assert (result.input_tokens, result.output_tokens, result.cache_read_tokens, result.cache_write_tokens) == (None, None, None, None)
    assert result.api_cost_usd is None and result.cache_read_share is None and result.recovery_ratio is None
    empty = figures([])
    assert empty.runs == 0 and empty.median_tokens_per_completed_run is None and empty.median_active_seconds_per_completed_run is None
    assert empty.api_cost_usd is None and empty.failed_calls == {}


def test_a_zero_that_was_measured_is_reported_as_zero():
    result = figures([run(calls=1, settled_calls=1, measured_tokens=120, input_tokens=100, output_tokens=20, cache_read_tokens=0,
                          cache_write_tokens=0, api_cost_usd=0.0, tool_calls=4)])
    assert result.cache_read_tokens == 0 and result.cache_read_share == 0.0
    assert result.api_cost_usd == 0.0 and result.recovery_ratio == 0.0


def test_a_sum_counts_what_was_reported_and_ignores_what_was_not():
    runs = [run(calls=3, settled_calls=2, measured_tokens=900, unknown_reserved_tokens=400, input_tokens=700, output_tokens=200,
                cache_read_tokens=350, cache_write_tokens=50, api_cost_usd=0.012345678, tool_calls=10, recoveries=2,
                failed_calls={"rate_limit": 1}),
            run("blocked", calls=2, settled_calls=1, cli_calls=1, measured_tokens=300, unknown_reserved_tokens=100,
                failed_calls={"rate_limit": 1, "timeout": 2, "made_up": 9}, tool_calls=5, recoveries=1),
            run("cancelled"), run("waiting_input"), run("running"), run("queued"), run("paused"), run("failed"), run("unheard_of")]
    result = figures(runs)
    assert (result.runs, result.completed, result.cancelled, result.stopped, result.waiting, result.active) == (9, 1, 1, 4, 1, 2)
    assert (result.calls, result.settled_calls, result.unsettled_calls, result.cli_calls) == (5, 3, 2, 1)
    # A class the ledger cannot hold is not invented into the figures.
    assert result.failed_calls == {"rate_limit": 2, "timeout": 2}
    assert (result.measured_tokens, result.unknown_reserved_tokens) == (1200, 500)
    assert (result.input_tokens, result.output_tokens, result.cache_read_tokens, result.cache_write_tokens) == (700, 200, 350, 50)
    assert result.api_cost_usd == 0.012346 and result.cache_read_share == 0.5
    assert result.tool_calls == 15 and result.recovery_ratio == 0.2
    assert result.active_seconds == 90.0


def test_the_median_describes_completed_runs_only():
    runs = [run(measured_tokens=100, active_seconds=10.0), run(measured_tokens=300, active_seconds=30.0),
            run(measured_tokens=1000, active_seconds=50.0), run("blocked", measured_tokens=90000, active_seconds=900.0)]
    result = figures(runs)
    assert result.median_tokens_per_completed_run == 300 and result.median_active_seconds_per_completed_run == 30.0
    assert figures(runs[:2]).median_tokens_per_completed_run == 200


def test_runs_are_grouped_by_the_utc_day_they_were_created():
    late = datetime.fromisoformat("2026-11-13T23:30:00-05:00")
    days = by_day([run(created_at=late, measured_tokens=40), run("blocked", created_at=datetime(2026, 11, 14, 8, tzinfo=UTC), measured_tokens=2),
                   run("cancelled", created_at=datetime(2026, 11, 12, 8, tzinfo=UTC)), run("running", created_at=datetime(2026, 11, 12, 9, tzinfo=UTC))])
    assert [(item.day, item.started, item.completed, item.stopped, item.cancelled, item.measured_tokens) for item in days] == [
        (date(2026, 11, 12), 2, 0, 0, 1, 0), (date(2026, 11, 14), 2, 1, 1, 0, 42)]


def test_database_sums_become_plain_numbers_and_an_absent_sum_stays_absent():
    row = plain(run(calls=Decimal(3), measured_tokens=Decimal(900), input_tokens=Decimal(700), api_cost_usd=Decimal("0.0125"), active_seconds=12))
    assert (row["calls"], row["measured_tokens"], row["input_tokens"], row["api_cost_usd"], row["active_seconds"]) == (3, 900, 700, 0.0125, 12.0)
    assert all(type(row[name]) is int for name in ("calls", "measured_tokens", "input_tokens"))
    assert row["output_tokens"] is None and type(row["active_seconds"]) is float


class Ledger:
    """A repository whose connection answers the two queries with canned rows and remembers their parameters."""

    def __init__(self, runs, specialists=()):
        self.rows, self.specialists, self.seen = list(runs), list(specialists), []

    @asynccontextmanager
    async def connection(self):
        yield self

    async def execute(self, query, values):
        self.seen.append(values)
        return SimpleNamespace(fetchall=AsyncMock(return_value=self.specialists if query is SPECIALISTS_QUERY else self.rows))


async def test_the_service_splits_by_mode_and_specialist_and_passes_the_filters_to_both_queries():
    rows = [run(mode="patch", measured_tokens=100, calls=1, settled_calls=1), run("blocked", mode="audit", measured_tokens=50, calls=1, settled_calls=1),
            run(mode="audit", measured_tokens=30, calls=1, settled_calls=1)]
    specialists = [{"role": "analyst", "calls": 2, "measured_tokens": Decimal(80), "input_tokens": Decimal(60), "output_tokens": Decimal(20), "cache_read_tokens": None},
                   {"role": None, "calls": 1, "measured_tokens": Decimal(100), "input_tokens": None, "output_tokens": None, "cache_read_tokens": None}]
    ledger = Ledger(rows, specialists)
    result = await RunMetricsService(ledger).runs(7, "audit", "project-1")
    assert (result.window_days, result.mode, result.project_id, result.truncated) == (7, "audit", "project-1", False)
    assert [(item.mode, item.runs, item.completed, item.stopped, item.measured_tokens) for item in result.by_mode] == [
        ("audit", 2, 1, 1, 80), ("patch", 1, 1, 0, 100)]
    assert result.totals.runs == 3 and result.totals.measured_tokens == 180
    assert [(item.role, item.calls, item.measured_tokens, item.input_tokens, item.cache_read_tokens) for item in result.by_specialist] == [
        ("analyst", 2, 80, 60, None), (None, 1, 100, None, None)]
    assert [(values["days"], values["mode"], values["project"]) for values in ledger.seen] == [(7, "audit", "project-1")] * 2
    assert [values["limit"] for values in ledger.seen] == [MAX_RUNS + 1, MAX_RUNS]


async def test_a_window_with_more_runs_than_the_bound_says_so_and_leaves_out_the_oldest():
    old = run(id="oldest", created_at=datetime(2026, 1, 1, tzinfo=UTC), measured_tokens=7)
    rows = [old, *(run(id=f"work-{index}", measured_tokens=1) for index in range(MAX_RUNS))]
    result = await RunMetricsService(Ledger(rows)).runs(365)
    assert result.truncated and result.totals.runs == MAX_RUNS and result.totals.measured_tokens == MAX_RUNS
    assert [item.day for item in result.by_day] == [date(2026, 11, 14)]


async def test_the_endpoint_is_the_owners_and_validates_its_filters():
    ledger = Ledger([run(mode="patch", measured_tokens=100, calls=1, settled_calls=1)])
    application = create_app(SimpleNamespace(repository=ledger), SimpleNamespace(auth_token=SecretStr(TOKEN), allowed_origins=["http://localhost:8000"]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url="http://localhost:8000") as client:
        assert (await client.get("/api/v1/metrics/runs")).status_code == 401
        owner = {"Authorization": f"Bearer {TOKEN}"}
        response = await client.get("/api/v1/metrics/runs", headers=owner)
        assert response.status_code == 200
        result = RunMetrics.model_validate(response.json())
        assert (result.window_days, result.mode, result.project_id, result.totals.runs) == (30, None, None, 1)
        # Unknown values travel as null, never as a number.
        totals = response.json()["totals"]
        assert totals["api_cost_usd"] is None and totals["cache_read_share"] is None and totals["input_tokens"] is None
        filtered = await client.get("/api/v1/metrics/runs", params={"days": 90, "mode": "audit", "project_id": "project-1"}, headers=owner)
        assert filtered.status_code == 200 and ledger.seen[-1]["days"] == 90 and ledger.seen[-1]["project"] == "project-1"
        for invalid in ({"days": 0}, {"days": 366}, {"mode": "security_watch"}, {"project_id": "not a project"}, {"project_id": ""}):
            assert (await client.get("/api/v1/metrics/runs", params=invalid, headers=owner)).status_code == 422


@pytest.mark.parametrize("status", ["completed", "cancelled", "blocked", "failed", "paused", "waiting_input", "queued", "running"])
def test_every_status_a_run_can_have_is_counted_in_exactly_one_outcome(status):
    result = figures([run(status)])
    assert result.completed + result.cancelled + result.stopped + result.waiting + result.active == result.runs == 1

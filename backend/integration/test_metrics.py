"""The ledger's cache and failure columns and the figures across runs, against the real PostgreSQL instance."""

from types import SimpleNamespace

import httpx
import psycopg
import pytest
from psycopg.types.json import Jsonb
from pydantic import SecretStr

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.api import create_app
from sabre.context_receipts import ContextReceipt
from sabre.events import ExecutionEvent
from sabre.metrics import RunMetrics, RunMetricsService
from sabre.models import Budget, WorkOrder, new_id, now
from tests.test_context_receipts import receipt

TOKEN = "owner-test-token-at-least-24"


async def another_work(repo, project, mode):
    work = WorkOrder(project_id=project.id, mode=mode, objective="Inspect fixture behavior", acceptance=["Reported"],
                     budget=Budget(max_cost_usd=10), idempotency_key=new_id())

    async def enqueue(conn, work_id):
        await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,'admitted','Atomic test enqueue')", (new_id(), work_id))

    await repo.admit(work, enqueue)
    return work


async def change(repo, work, **data):
    async with repo.connection() as conn:
        await conn.execute("UPDATE work_orders SET data=data || %s WHERE id=%s", (Jsonb(data), work.id))


def call_receipt(work, project, role, provider):
    return ContextReceipt.model_validate(receipt(work.id, project.id, role=role, child_id=f"{work.id}/r1/{role}/" + "a" * 64,
                                                 model_provider=provider, model_name="fixture-model"))


async def tool_event(repo, work, name, state):
    await repo.record_execution_event(ExecutionEvent(id=new_id(), work_id=work.id, plan_revision=1, phase="analysis", correlation_id=new_id(),
                                                     kind="tool", state=state, name=name, timestamp=now(), duration_ms=5))


async def test_the_ledger_keeps_cache_writes_and_why_an_unsettled_call_failed(repository):
    repo, project, work = await fixture_work(repository)
    settled = await repo.reserve_usage(work, 1000, 0.05, 1000)
    await repo.settle_usage(settled, 600, 0.02, breakdown={"input_tokens": 500, "output_tokens": 100, "cache_read_tokens": 300, "cache_write_tokens": 50})
    lost = await repo.reserve_usage(work, 800, 0.04, 1000)
    await repo.fail_usage(lost, "rate_limit")
    # A settled call has an outcome already: a failure class is never written over it.
    await repo.fail_usage(settled, "timeout")
    legacy = await repo.reserve_usage(work, 100, 0, 1000)
    await repo.settle_usage(legacy, 70, 0)
    calls, truncated = await repo.audit_calls(work.id)
    assert not truncated
    assert [(call["actual_tokens"], call["cache_read_tokens"], call["cache_write_tokens"], call["failure_class"]) for call in calls] == [
        (600, 300, 50, None), (None, None, None, "rate_limit"), (70, None, None, None)]
    # The reservation of the failed call stays: a lost response is not a free request.
    usage = await repo.audit_usage(work.id)
    assert (usage["calls"], usage["settled_calls"], usage["unknown_reserved_tokens"]) == (3, 2, 800)
    with pytest.raises(psycopg.errors.CheckViolation):
        await repo.fail_usage(lost, "a class the ledger does not know")
    with pytest.raises(psycopg.errors.CheckViolation):
        await repo.settle_usage(legacy, 70, 0, breakdown={"cache_write_tokens": -1})


async def test_figures_across_runs_agree_with_the_ledger_and_the_event_log(repository):
    repo, project, delivered = await fixture_work(repository)
    audit = await another_work(repo, project, "audit")
    waiting = await another_work(repo, project, "patch")
    await change(repo, delivered, status="completed", active_seconds_used=40.0)
    await change(repo, audit, status="blocked", active_seconds_used=15.0)
    # A delivered patch: one settled API call with cached input, one call that never settled.
    first = await repo.reserve_usage(delivered, 1000, 0.05, 1000, context_receipt=call_receipt(delivered, project, "developer", "openai"))
    await repo.settle_usage(first, 600, 0.02, breakdown={"input_tokens": 500, "output_tokens": 100, "cache_read_tokens": 300, "cache_write_tokens": 50})
    second = await repo.reserve_usage(delivered, 800, 0.04, 1000, context_receipt=call_receipt(delivered, project, "developer", "openai"))
    await repo.fail_usage(second, "rate_limit")
    for name, state in (("read_file", "completed"), ("read_context", "completed"), ("execute", "failed"), ("read_file", "started")):
        await tool_event(repo, delivered, name, state)
    # A blocked audit: one call through a CLI session, and one recorded without a specialist or a token split.
    third = await repo.reserve_usage(audit, 2000, 0, 1000, context_receipt=call_receipt(audit, project, "analyst", "claude_cli"))
    await repo.settle_usage(third, 1500, 0, breakdown={"input_tokens": 1400, "output_tokens": 100, "cache_read_tokens": 1000, "cache_write_tokens": 0})
    fourth = await repo.reserve_usage(audit, 100, 0, 1000)
    await repo.settle_usage(fourth, 70, 0)

    service = RunMetricsService(repo)
    result = await service.runs(30, project_id=project.id)
    totals = result.totals
    assert (totals.runs, totals.completed, totals.stopped, totals.active, totals.cancelled, totals.waiting) == (3, 1, 1, 1, 0, 0)
    assert (totals.calls, totals.settled_calls, totals.unsettled_calls, totals.cli_calls) == (4, 3, 1, 1)
    assert totals.failed_calls == {"rate_limit": 1}
    assert (totals.measured_tokens, totals.unknown_reserved_tokens) == (2170, 800)
    assert (totals.input_tokens, totals.output_tokens, totals.cache_read_tokens, totals.cache_write_tokens) == (1900, 200, 1300, 50)
    # Only the call charged through API prices has a cost; the CLI call and the unattributed one add nothing to it.
    assert totals.api_cost_usd == 0.02
    assert totals.active_seconds == 55.0
    assert (totals.median_tokens_per_completed_run, totals.median_active_seconds_per_completed_run) == (600, 40.0)
    assert totals.cache_read_share == round(1300 / 1900, 4)
    assert (totals.tool_calls, totals.recovery_ratio) == (3, round(1 / 3, 4))
    # The same sums the run audit reads from the ledger, run by run.
    audited = [await repo.audit_usage(work.id) for work in (delivered, audit, waiting)]
    assert sum(item["calls"] for item in audited) == totals.calls
    assert sum(item["measured_tokens"] for item in audited) == totals.measured_tokens
    assert sum(item["unknown_reserved_tokens"] for item in audited) == totals.unknown_reserved_tokens

    by_mode = {item.mode: item for item in result.by_mode}
    assert list(by_mode) == ["audit", "patch"]
    assert (by_mode["audit"].runs, by_mode["audit"].stopped, by_mode["audit"].cli_calls, by_mode["audit"].measured_tokens) == (1, 1, 1, 1570)
    # An audit with no API call has an unknown cost and, with no tool call recorded, an unknown recovery ratio.
    assert by_mode["audit"].api_cost_usd is None and by_mode["audit"].recovery_ratio is None
    assert by_mode["audit"].cache_read_share == round(1000 / 1400, 4)
    assert (by_mode["patch"].runs, by_mode["patch"].completed, by_mode["patch"].active, by_mode["patch"].api_cost_usd) == (2, 1, 1, 0.02)
    assert [(item.role, item.calls, item.measured_tokens, item.input_tokens, item.cache_read_tokens) for item in result.by_specialist] == [
        ("analyst", 1, 1500, 1400, 1000), ("developer", 2, 600, 500, 300), (None, 1, 70, None, None)]
    assert sum(item.started for item in result.by_day) == 3 and sum(item.measured_tokens for item in result.by_day) == 2170
    assert (sum(item.completed for item in result.by_day), sum(item.stopped for item in result.by_day)) == (1, 1)

    assert (await service.runs(30, "audit", project.id)).totals.runs == 1
    # A run created before the window is outside it, and the security watch's own work orders are never runs.
    await change(repo, waiting, created_at="2026-01-01T00:00:00+00:00")
    assert (await service.runs(30, project_id=project.id)).totals.runs == 2
    assert (await service.runs(365, project_id=project.id)).totals.runs in {2, 3}
    await change(repo, audit, phase="security_watch")
    narrowed = await service.runs(30, project_id=project.id)
    assert (narrowed.totals.runs, narrowed.totals.measured_tokens, [item.role for item in narrowed.by_specialist]) == (1, 600, ["developer"])

    application = create_app(SimpleNamespace(repository=repo), SimpleNamespace(auth_token=SecretStr(TOKEN), allowed_origins=["http://localhost:8000"]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url="http://localhost:8000",
                                 headers={"Authorization": f"Bearer {TOKEN}"}) as client:
        response = await client.get("/api/v1/metrics/runs", params={"days": 30, "project_id": project.id})
        assert response.status_code == 200
        served = RunMetrics.model_validate(response.json())
        assert served.model_dump(exclude={"generated_at"}) == narrowed.model_dump(exclude={"generated_at"})


async def test_a_run_keeps_the_root_span_of_its_latest_execution_and_the_next_one_links_to_it(repository, monkeypatch):
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from sabre.telemetry import execution_span, trace_identifiers

    repo, _, work = await fixture_work(repository)
    assert await repo.trace_root(work.id) is None and await repo.trace_root("no-such-run") is None
    before = await repo.work(work.id)
    await repo.remember_trace_root(work.id, {"trace_id": "a" * 32, "span_id": "b" * 16, "anything_else": "left out"})
    assert await repo.trace_root(work.id) == {"trace_id": "a" * 32, "span_id": "b" * 16}
    # Keeping the root is not a change to the run: nothing the owner sees moves.
    assert await repo.work(work.id) == before

    exporter, provider = InMemorySpanExporter(), TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr("sabre.telemetry.trace.get_tracer", lambda _: provider.get_tracer("test"))
    async with execution_span(repo, work.id):
        first = trace_identifiers()
    async with execution_span(repo, work.id):
        second = trace_identifiers()
    earlier, later = exporter.get_finished_spans()
    assert [(f"{link.context.trace_id:032x}", f"{link.context.span_id:016x}") for link in earlier.links] == [("a" * 32, "b" * 16)]
    assert [(f"{link.context.trace_id:032x}", f"{link.context.span_id:016x}") for link in later.links] == [
        (first["trace_id"], first["span_id"])]
    assert await repo.trace_root(work.id) == second
    provider.shutdown()

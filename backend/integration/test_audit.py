from types import SimpleNamespace
from typing import TypedDict

import httpx
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from pydantic import SecretStr

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.api import create_app
from sabre.audit import AuditService, RunUsageSnapshot
from sabre.security import SecretGuard


class State(TypedDict):
    messages: list


async def test_live_usage_reads_reservations_and_settlement_without_work_save_or_checkpoint_read(repository):
    repo, _, work = await fixture_work(repository)
    application = create_app(SimpleNamespace(repository=repo), SimpleNamespace(
        auth_token=SecretStr("owner-test-token-at-least-24"), allowed_origins=["http://localhost:8000"]))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application), base_url="http://localhost:8000",
                                 headers={"Authorization": "Bearer owner-test-token-at-least-24"}) as client:
        async def current():
            response = await client.get(f"/api/v1/work/{work.id}/usage")
            assert response.status_code == 200
            result = RunUsageSnapshot.model_validate(response.json())
            assert result.version == 1 and result.work_id == work.id
            return result

        empty = await current()
        assert empty.usage.calls == 0
        assert empty.measured_api_cost_usd is None and empty.reserved_api_cost_usd == 0
        first = await repo.reserve_usage(work, 100, 0.1, 10)
        snapshot = await current()
        reserved = snapshot.usage
        assert (reserved.calls, reserved.settled_calls, reserved.unsettled_calls) == (1, 0, 1)
        assert (reserved.tokens, reserved.measured_tokens, reserved.unknown_reserved_tokens) == (100, 0, 100)
        assert reserved.cost_usd == 0.1
        assert snapshot.measured_api_cost_usd is None and snapshot.reserved_api_cost_usd == 0.1
        await repo.settle_usage(first, 30, 0.03)
        second = await repo.reserve_usage(work, 120, 0.12, 10)
        snapshot = await current()
        mixed = snapshot.usage
        assert (mixed.calls, mixed.settled_calls, mixed.unsettled_calls) == (2, 1, 1)
        assert (mixed.tokens, mixed.measured_tokens, mixed.unknown_reserved_tokens) == (150, 30, 120)
        assert snapshot.measured_api_cost_usd == 0.03 and snapshot.reserved_api_cost_usd == 0.12
        await repo.settle_usage(second, 40, 0.04)
        snapshot = await current()
        settled = snapshot.usage
        assert (settled.calls, settled.settled_calls, settled.unsettled_calls) == (2, 2, 0)
        assert (settled.tokens, settled.measured_tokens, settled.unknown_reserved_tokens) == (70, 70, 0)
        assert snapshot.measured_api_cost_usd == 0.07 and snapshot.reserved_api_cost_usd == 0
        _, _, cli_work = await fixture_work(repository)
        cli_usage = await repo.reserve_usage(cli_work, 20, 0, 10)
        await repo.settle_usage(cli_usage, 15, 0)
        cli_response = await client.get(f"/api/v1/work/{cli_work.id}/usage")
        assert cli_response.status_code == 200
        assert cli_response.json()["measured_api_cost_usd"] == 0
        saved = await repo.work(work.id)
        assert (saved.phase, saved.calls_used, saved.tokens_used) == (work.phase, 0, 0)


async def test_audit_reads_latest_official_checkpoint_and_preserves_usage_and_project_scope(repository):
    repo, project, work = await fixture_work(repository)
    _, other_project, foreign = await fixture_work(repository)
    thread = f"{work.id}/r1/developer/" + "a" * 64
    foreign_thread = f"{foreign.id}/r1/developer/" + "b" * 64
    first = await repo.reserve_usage(work, 100, 0, 10)
    await repo.settle_usage(first, 30, 0)
    await repo.reserve_usage(work, 120, 0, 10)
    ai = AIMessage(id="one-response", content="Private content", usage_metadata={"input_tokens": 25, "output_tokens": 5, "total_tokens": 30}, tool_calls=[{"name": "execute", "id": "command", "args": {"argv": ["private"]}}])
    reply = ToolMessage(id="reply", tool_call_id="command", content='{"exit_code":1,"output":"Private output"}')
    async with AsyncPostgresSaver.from_conn_string(repo.dsn) as saver:
        await saver.setup()
        builder = StateGraph(State)
        builder.add_node("save", lambda state: state)
        builder.add_edge(START, "save")
        builder.add_edge("save", END)
        graph = builder.compile(checkpointer=saver)
        config = {"configurable": {"thread_id": thread}}
        await graph.ainvoke({"messages": [ai]}, config, durability="sync")
        await graph.ainvoke({"messages": [ai, reply]}, config, durability="sync")
        await graph.ainvoke({"messages": [ai]}, {"configurable": {"thread_id": foreign_thread}}, durability="sync")
        service = AuditService(repo, saver, SecretGuard())
        before = await saver.aget_tuple(config)
        report = await service.audit(work.id)
        assert len(report.agents) == 1 and report.agents[0].model_responses == 1
        assert report.tools[0].exit_code == 1 and report.tools[0].response == "received"
        assert (report.usage.calls, report.usage.settled_calls, report.usage.tokens, report.usage.unknown_reserved_tokens) == (2, 1, 150, 120)
        assert report.checkpoint_count > 1 and report.checkpoint_threads == 1
        knowledge = await service.knowledge(project.id)
        assert knowledge.memories.total == 0 and knowledge.checkpoints.threads == 1 and knowledge.context is None
        assert (await service.knowledge(other_project.id)).checkpoints.threads == 1
        assert (await saver.aget_tuple(config)).config == before.config
        async with repo.connection() as conn:
            row = await (await conn.execute("SELECT count(*) total,count(actual_tokens) settled FROM model_usage WHERE work_id=%s", (work.id,))).fetchone()
        assert row == {"total": 2, "settled": 1}
        await saver.adelete_thread(thread)
        await saver.adelete_thread(foreign_thread)


async def test_per_call_split_and_measured_boundaries_persist_without_content(repository):
    from sabre.events import ExecutionEvent
    from sabre.models import new_id, now

    repo, _, work = await fixture_work(repository)
    split = await repo.reserve_usage(work, 9000, 0, 10)
    await repo.settle_usage(split, 3005, 0, breakdown={"input_tokens": 3000, "output_tokens": 5, "cache_read_tokens": 2048})
    legacy = await repo.reserve_usage(work, 500, 0, 10)
    await repo.settle_usage(legacy, 400, 0)
    await repo.reserve_usage(work, 700, 0, 10)
    calls, truncated = await repo.audit_calls(work.id)
    assert not truncated and [call["reserved_tokens"] for call in calls] == [9000, 500, 700]
    first, second, pending = calls
    assert (first["input_tokens"], first["output_tokens"], first["cache_read_tokens"], first["actual_tokens"]) == (3000, 5, 2048, 3005)
    assert first["call_ms"] is not None and first["call_ms"] >= 0
    assert (second["input_tokens"], second["actual_tokens"]) == (None, 400)
    assert pending["actual_tokens"] is None and pending["call_ms"] is None
    models = await repo.audit_model_usage(work.id)
    assert sum(entry["input_tokens"] or 0 for entry in models) == 3000
    assert sum(entry["unsplit_calls"] for entry in models) == 1
    agent = "c" * 64

    def event(kind, name, state, duration=None, size=None):
        return ExecutionEvent(id=new_id(), work_id=work.id, plan_revision=1, phase="implementation", correlation_id=new_id(),
            agent_id=agent, kind=kind, state=state, name=name, timestamp=now(), duration_ms=duration, output_bytes=size)

    for item in (event("agent", "developer", "started"), event("tool", "read_file", "started"),
                 event("tool", "read_file", "completed", 1400, 900), event("tool", "read_file", "failed", 30),
                 event("tool", "read_file", "completed", 1500, 1100), event("agent", "developer", "completed", 9000)):
        await repo.record_execution_event(item)
    timings = {(row["kind"], row["name"]): row for row in await repo.audit_execution_timings(work.id)}
    reads = timings[("tool", "read_file")]
    assert (reads["count"], reads["failed"], reads["total_ms"], reads["max_ms"], reads["output_bytes"]) == (3, 1, 2930, 1500, 2000)
    assert timings[("agent", "developer")]["total_ms"] == 9000

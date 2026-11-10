from typing import TypedDict

from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.audit import AuditService
from sabre.security import SecretGuard


class State(TypedDict):
    messages: list


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

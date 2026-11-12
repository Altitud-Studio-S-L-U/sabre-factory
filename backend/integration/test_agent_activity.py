from psycopg.types.json import Jsonb

from integration.test_postgres import fixture_work
from integration.test_postgres import repository as repository
from sabre.agent_activity import agent_activity
from sabre.events import ExecutionEvent
from sabre.models import Status, new_id, now


async def test_activity_aggregates_agent_events_usage_and_current_runs(repository):
    repo, project, work = await fixture_work(repository)
    role = f"role-{new_id()[:8]}"
    before = await agent_activity(repo, 7)
    for state, duration in (("started", None), ("completed", 1200), ("started", None), ("failed", 300), ("started", None), ("interrupted", 50)):
        await repo.record_execution_event(ExecutionEvent(id=new_id(), work_id=work.id, plan_revision=1, phase="analysis", correlation_id=new_id(),
                                                         kind="agent", state=state, name=role, timestamp=now(), duration_ms=duration))
    await repo.record_execution_event(ExecutionEvent(id=new_id(), work_id=work.id, plan_revision=1, phase="analysis", correlation_id=new_id(),
                                                     kind="tool", state="completed", name=role, timestamp=now(), duration_ms=99))
    async with repo.connection() as conn:
        for tokens in (100, None):
            await conn.execute("INSERT INTO model_usage(id,work_id,reserved_tokens,reserved_usd,actual_tokens,actual_usd,context_receipt) VALUES(%s,%s,500,0,%s,0,%s)",
                               (new_id(), work.id, tokens, Jsonb({"role": role})))
    work.status, work.phase, work.repair_cycles_used = Status.RUNNING, "development", 2
    await repo.save(work)
    after = await agent_activity(repo, 7)
    activity = next(item for item in after.roles if item.role == role)
    assert (activity.invocations, activity.completed, activity.failed, activity.interrupted) == (3, 1, 1, 1)
    assert activity.duration_ms == 1550 and activity.model_calls == 2 and activity.tokens == 100
    assert after.repair_cycles == before.repair_cycles + 2
    assert any(run.work_id == work.id and run.stage == "development" and run.status == "running" for run in after.active_runs)
    work.status = Status.WAITING_INPUT
    await repo.save(work)
    waiting = await agent_activity(repo, 7)
    assert waiting.waiting_for_input == before.waiting_for_input + 1
    assert all(run.work_id != work.id for run in waiting.active_runs)

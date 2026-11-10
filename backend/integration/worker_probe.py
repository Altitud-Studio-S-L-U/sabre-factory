"""Container-only fixture for real worker death and Procrastinate recovery checks."""

import asyncio
import json
import sys

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from sabre.models import Budget, Project, Status, WorkOrder, new_id
from sabre.repository import payload
from sabre.runtime import Runtime
from sabre.settings import settings

TASK = "sabre.integration_worker_recovery"
QUEUE = "integration-recovery"


def register(runtime):
    @runtime.queue.task(name=TASK, queue=QUEUE)
    async def fixture_work(work_id: str):
        async with runtime.repository.connection() as conn:
            await conn.execute("UPDATE integration_worker_probe SET starts=starts+1 WHERE work_id=%s", (work_id,))
            work = await runtime.repository.work(work_id)
            work.status, work.phase = Status.RUNNING, "integration_fixture"
            await conn.execute("UPDATE work_orders SET data=%s WHERE id=%s", (Jsonb(payload(work)), work_id))
        while True:
            async with runtime.repository.connection() as conn:
                row = await (await conn.execute("SELECT released FROM integration_worker_probe WHERE work_id=%s", (work_id,))).fetchone()
            if row["released"]:
                break
            await asyncio.sleep(0.2)
        async with runtime.repository.connection() as conn:
            # Count every completed invocation: duplicate execution must fail the probe.
            await conn.execute("UPDATE integration_worker_probe SET completions=completions+1 WHERE work_id=%s", (work_id,))
            work = await runtime.repository.work(work_id)
            work.status, work.summary = Status.COMPLETED, "Fixture de recuperación terminada"
            await conn.execute("UPDATE work_orders SET data=%s WHERE id=%s", (Jsonb(payload(work)), work_id))
            await conn.execute("INSERT INTO work_events(id,work_id,kind,message) VALUES(%s,%s,'fixture_completed','Fixture finished')", (new_id(), work_id))

    return fixture_work


async def main():
    action = sys.argv[1]
    if action in {"state", "release"}:
        async with await psycopg.AsyncConnection.connect(settings().database_url.get_secret_value(), row_factory=dict_row) as conn:
            if action == "release":
                await conn.execute("UPDATE integration_worker_probe SET released=true")
                return
            row = await (await conn.execute("SELECT p.*,w.data->>'status' AS work_status,j.status AS job_status,(SELECT count(*) FROM work_events e WHERE e.work_id=p.work_id AND e.kind='fixture_completed') AS events FROM integration_worker_probe p JOIN work_orders w ON w.id=p.work_id JOIN procrastinate_jobs j ON j.id=p.job_id")).fetchone()
            print(json.dumps(row))
        return
    async with Runtime(settings()) as runtime:
        task = register(runtime)
        if action == "bootstrap":
            async with runtime.repository.connection() as conn:
                await conn.execute("CREATE TABLE integration_worker_probe(work_id text PRIMARY KEY,job_id bigint,starts integer NOT NULL DEFAULT 0,completions integer NOT NULL DEFAULT 0,released boolean NOT NULL DEFAULT false)")
            project = await runtime.repository.create_project(Project(name="Isolated recovery fixture", repository="https://github.com/fixture/recovery", profile="python", gate_commands=[["python", "-m", "unittest"]]))
            work = WorkOrder(project_id=project.id, mode="patch", objective="Probar recuperación aislada del worker", acceptance=["Una terminación después de la caída"], budget=Budget(max_cost_usd=1), idempotency_key=new_id())

            async def enqueue(conn, work_id):
                job_id = await task.configure(connection=conn).defer_async(work_id=work_id)
                await conn.execute("INSERT INTO integration_worker_probe(work_id,job_id) VALUES(%s,%s)", (work_id, job_id))

            await runtime.repository.admit(work, enqueue)
            print(json.dumps({"work_id": work.id}))
        elif action in {"worker", "control"}:
            queues = [QUEUE] if action == "worker" else ["maintenance"]
            await runtime.queue.run_worker_async(queues=queues, concurrency=1, shutdown_graceful_timeout=5)
        else:
            raise ValueError("Unknown integration probe action")


if __name__ == "__main__":
    asyncio.run(main())

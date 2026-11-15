import procrastinate
import psycopg
import pytest
from psycopg.rows import dict_row

from sabre.models import new_id
from sabre.settings import Settings
from sabre.worker import worker_options


def test_each_worker_takes_its_queues_and_deletes_the_jobs_that_succeeded():
    control, work = worker_options(True, 2), worker_options(False, 3)
    assert control["queues"] == ["maintenance", "slack", "operator"] and control["concurrency"] == 2
    assert work["queues"] == ["work"] and work["concurrency"] == 3
    assert control["delete_jobs"] == work["delete_jobs"] == "successful"


@pytest.mark.parametrize("control", [True, False])
async def test_a_job_that_succeeded_leaves_the_queue_and_a_job_that_failed_stays(control):
    dsn = Settings().database_url.get_secret_value()
    # Short: PostgreSQL limits the name of the channel the queue notifies on.
    queue = f"kept-{new_id()[:8]}"
    app = procrastinate.App(connector=procrastinate.PsycopgConnector(conninfo=dsn, min_size=1, max_size=2))

    @app.task(name=f"{queue}.fine", queue=queue)
    async def fine():
        return None

    @app.task(name=f"{queue}.broken", queue=queue)
    async def broken():
        raise RuntimeError("synthetic failure")

    async def rows():
        async with await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row) as conn:
            jobs = await (await conn.execute("SELECT id,task_name,status FROM procrastinate_jobs WHERE queue_name=%s ORDER BY id", (queue,))).fetchall()
            events = await (await conn.execute("SELECT count(*) AS count FROM procrastinate_events WHERE job_id=ANY(%s)", ([job["id"] for job in jobs],))).fetchone()
        return [(job["task_name"].rsplit(".", 1)[1], job["status"]) for job in jobs], events["count"]

    async with app.open_async():
        async with await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row) as conn:
            present = await (await conn.execute("SELECT to_regclass('procrastinate_jobs') AS present")).fetchone()
        if not present["present"]:
            await app.schema_manager.apply_schema_async()
        try:
            for _ in range(3):
                await fine.defer_async()
            await broken.defer_async()
            assert (await rows())[0] == [("fine", "todo")] * 3 + [("broken", "todo")]
            # The factory's own options, on this test's queue, until the queue is empty.
            options = worker_options(control, 2) | {"queues": [queue], "wait": False, "install_signal_handlers": False}
            await app.run_worker_async(**options)
            jobs, events = await rows()
            # Three jobs succeeded and are gone with their events. The failure is still there to be read.
            assert jobs == [("broken", "failed")]
            assert events > 0
        finally:
            async with await psycopg.AsyncConnection.connect(dsn) as conn:
                await conn.execute("DELETE FROM procrastinate_jobs WHERE queue_name=%s", (queue,))

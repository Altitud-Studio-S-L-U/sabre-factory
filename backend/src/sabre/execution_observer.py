"""Persist measured execution boundaries without recording prompt or tool content."""

import asyncio
import time
from contextlib import asynccontextmanager

from langgraph.errors import GraphInterrupt

from sabre.events import ExecutionEvent
from sabre.models import new_id, now


@asynccontextmanager
async def observe(repository, work, kind, name, *, parent_id=None, provider=None, model=None):
    correlation = new_id()
    started = time.perf_counter()

    async def record(state, error=None):
        if hasattr(repository, "record_execution_event"):
            await repository.record_execution_event(ExecutionEvent(id=new_id(), work_id=work.id,
                plan_revision=work.plan_revision, phase=work.phase, correlation_id=correlation,
                parent_id=parent_id, kind=kind, state=state, name=name, timestamp=now(),
                duration_ms=None if state == "started" else int((time.perf_counter() - started) * 1000),
                error_code=error, provider=provider, model=model))

    await record("started")
    try:
        yield correlation
    except BaseException as error:
        await record("interrupted" if isinstance(error, (GraphInterrupt, asyncio.CancelledError)) else "failed", getattr(error, "code", None))
        raise
    else:
        await record("completed")

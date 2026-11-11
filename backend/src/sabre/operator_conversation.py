"""Durable owner messages, serialized by context and processed by the worker."""

import asyncio

from psycopg.types.json import Jsonb

from sabre.models import DomainError, new_id
from sabre.operator_contracts import (
    OperatorContext,
    OperatorMessagePage,
    OperatorMessageRequest,
    OperatorMessageResume,
    OperatorMessageView,
)
from sabre.repository import digest


def view(row):
    data = row["data"]
    return OperatorMessageView(id=row["id"], work_id=data.get("work_id"), text=data["text"],
        allowed_actions=data.get("allowed_actions", []), state=row["state"], reply=row["reply"],
        error_code=row["error_code"], created_at=row["created_at"])


class OperatorConversationStore:
    def __init__(self, repository, guard, enqueue):
        self.repository, self.guard, self.enqueue = repository, guard, enqueue

    async def admit(self, request: OperatorMessageRequest):
        self.guard.check(request)
        if request.work_id:
            await self.repository.work(request.work_id)
        scope = f"run:{request.work_id}" if request.work_id else "factory"
        content = request.model_dump(mode="json")
        fingerprint = digest(content)
        async with self.repository.connection() as conn:
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,7))", (f"{scope}:{request.idempotency_key}",))
            row = await (await conn.execute("SELECT * FROM operator_messages WHERE scope=%s AND request_key=%s", (scope, request.idempotency_key))).fetchone()
            if row:
                if row["request_digest"] != fingerprint:
                    raise DomainError("OPERATOR_MESSAGE_CONFLICT", "This message key was already used for different content", 409)
                return view(row)
            count = await (await conn.execute("SELECT count(*) AS n FROM operator_messages WHERE scope=%s AND state IN ('queued','running')", (scope,))).fetchone()
            if count["n"] >= 8:
                raise DomainError("OPERATOR_CONVERSATION_BUSY", "Wait for pending supervisor messages before sending more", 429)
            identifier = new_id()
            row = await (await conn.execute("""INSERT INTO operator_messages(id,scope,request_key,request_digest,data)
                VALUES(%s,%s,%s,%s,%s) RETURNING *""", (identifier, scope, request.idempotency_key, fingerprint, Jsonb(content)))).fetchone()
            await self.enqueue(conn, identifier, scope)
        return view(row)

    async def list(self, work_id: str | None = None):
        if work_id:
            await self.repository.work(work_id)
        async with self.repository.connection() as conn:
            rows = await (await conn.execute("SELECT * FROM operator_messages WHERE scope=%s ORDER BY created_at DESC,id DESC LIMIT 101", (f"run:{work_id}" if work_id else "factory",))).fetchall()
        result = OperatorMessagePage(items=[view(row) for row in reversed(rows[:100])], truncated=len(rows) > 100)
        self.guard.check(result)
        return result

    async def get(self, identifier):
        async with self.repository.connection() as conn:
            return await (await conn.execute("SELECT * FROM operator_messages WHERE id=%s", (identifier,))).fetchone()

    async def resume(self, identifier, request: OperatorMessageResume):
        async with self.repository.connection() as conn:
            row = await (await conn.execute("SELECT * FROM operator_messages WHERE id=%s FOR UPDATE", (identifier,))).fetchone()
            if not row:
                raise DomainError("OPERATOR_MESSAGE_NOT_FOUND", "The supervisor message does not exist", 404)
            if row["state"] in {"queued", "running", "completed"}:
                return view(row)
            if row["error_code"] != request.expected_error_code:
                raise DomainError("OPERATOR_MESSAGE_CHANGED", "Refresh this message before resuming", 409)
            row = await (await conn.execute("UPDATE operator_messages SET state='queued',error_code=NULL WHERE id=%s RETURNING *", (identifier,))).fetchone()
            await self.enqueue(conn, identifier, row["scope"])
        return view(row)

    async def transition(self, identifier, state, reply=None, error_code=None):
        self.guard.check([reply, error_code])
        async with self.repository.connection() as conn:
            await conn.execute("UPDATE operator_messages SET state=%s,reply=%s,error_code=%s WHERE id=%s", (state, reply, error_code, identifier))

    async def effect(self, key):
        async with self.repository.connection() as conn:
            return await (await conn.execute("SELECT * FROM effects WHERE operation_key=%s", (key,))).fetchone()


async def register_operator_job(runtime):
    from sabre.error_boundaries import guarded_call
    from sabre.supervisor import SupervisorConversation

    async def enqueue(conn, identifier, scope):
        await process_message.configure(connection=conn, lock=f"operator:{scope}").defer_async(identifier=identifier)

    store = OperatorConversationStore(runtime.repository, runtime.service.guard, enqueue)
    runtime.operator_conversation = store
    conversation = SupervisorConversation(runtime.service, store, runtime.checkpointer)

    @runtime.queue.task(name="sabre.operator_message", queue="operator", retry=0)
    async def process_message(identifier: str):
        row = await store.get(identifier)
        if not row or row["state"] in {"completed", "blocked"}:
            return
        event = OperatorContext.model_validate({**row["data"], "id": identifier})
        await store.transition(identifier, "running")
        try:
            async with asyncio.timeout(180):
                reply = await guarded_call(conversation.reply, runtime.service.guard, "OPERATOR_CONVERSATION_FAILED", event)
        except DomainError as error:
            await store.transition(identifier, "blocked", error_code=error.code)
            return
        except TimeoutError:
            await store.transition(identifier, "blocked", error_code="OPERATOR_CONVERSATION_TIMEOUT")
            return
        except asyncio.CancelledError:
            await asyncio.shield(store.transition(identifier, "blocked", error_code="OPERATOR_INTERRUPTED"))
            raise
        await store.transition(identifier, "completed", reply=reply)

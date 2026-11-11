import asyncio
from unittest.mock import AsyncMock

import pytest

from integration.test_postgres import repository as repository
from sabre.models import DomainError, new_id
from sabre.operator_contracts import OperatorMessageRequest, OperatorMessageResume
from sabre.operator_conversation import OperatorConversationStore
from sabre.security import SecretGuard


async def test_durable_admission_deduplicates_and_restores_history(repository):
    repo, _ = repository
    enqueue = AsyncMock()
    store = OperatorConversationStore(repo, SecretGuard(), enqueue)
    request = OperatorMessageRequest(version=1, text="Inspect the factory", idempotency_key=new_id())
    try:
        first, second = await asyncio.gather(store.admit(request), store.admit(request))
        assert first.id == second.id
        enqueue.assert_awaited_once()
        cross_channel = await store.admit(request, source="mcp")
        assert cross_channel.id == first.id and cross_channel.source == "web"
        enqueue.assert_awaited_once()
        with pytest.raises(DomainError) as caught:
            await store.admit(request.model_copy(update={"text": "Different request"}))
        assert caught.value.code == "OPERATOR_MESSAGE_CONFLICT"
        await store.transition(first.id, "blocked", error_code="MODEL_NOT_READY")
        resume = OperatorMessageResume(version=1, expected_error_code="MODEL_NOT_READY")
        resumed = await asyncio.gather(store.resume(first.id, resume), store.resume(first.id, resume))
        assert all(item.state == "queued" for item in resumed)
        assert enqueue.await_count == 2
        await store.transition(first.id, "completed", reply="Observed status, not an invented result")
        restarted = OperatorConversationStore(repo, SecretGuard(), enqueue)
        messages = (await restarted.list()).items
        restored = next(item for item in messages if item.id == first.id)
        assert restored.state == "completed" and restored.allowed_actions == []
        assert restored.reply == "Observed status, not an invented result"
    finally:
        async with repo.connection() as conn:
            await conn.execute("DELETE FROM operator_messages WHERE request_key=%s", (request.idempotency_key,))


async def test_enqueue_failure_rolls_back_message_and_allows_safe_admission(repository):
    repo, _ = repository
    request = OperatorMessageRequest(version=1, text="Inspect the factory", idempotency_key=new_id())
    enqueue = AsyncMock(side_effect=RuntimeError("synthetic queue failure"))
    store = OperatorConversationStore(repo, SecretGuard(), enqueue)
    with pytest.raises(RuntimeError):
        await store.admit(request)
    async with repo.connection() as conn:
        row = await (await conn.execute("SELECT id FROM operator_messages WHERE request_key=%s", (request.idempotency_key,))).fetchone()
    assert row is None

import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from sabre.memory import MAX_CONTEXT_BYTES, MemoryService
from sabre.models import DomainError, MemoryItem
from sabre.security import SecretGuard


def item(index=0, content=None):
    return MemoryItem(id=f"memory-{index}", project_id="project-one", source_work_id="previous-work", source_commit="a" * 40,
        kind="lesson", content=content or ("x" * 3900 + " important_task_needle " + "y" * 3900), active=True)


def memory(items, guard=None, embeddings=None):
    repository = SimpleNamespace(search_memory=AsyncMock(return_value=items), has_embedded_memory=AsyncMock(return_value=False),
        memory_for_context=AsyncMock(return_value=items[0] if items else None))
    return MemoryService(repository, guard or SecretGuard(), embeddings), repository


async def test_task_memory_is_bounded_relevant_and_recoverable_without_promoting_lessons():
    originals = [item(index) for index in range(8)]
    service, repository = memory(originals)
    before = [value.model_dump(mode="json") for value in originals]
    selected = await service.context_for_role("project-one", "Maintain behavior", "Fix important_task_needle", "a" * 40, work=object())
    assert len(selected) == 4
    assert len(json.dumps(selected, ensure_ascii=False).encode()) <= MAX_CONTEXT_BYTES
    assert len(json.dumps(selected).encode()) < len(json.dumps(before).encode()) * 0.1
    assert all("important_task_needle" in value["content"] for value in selected)
    assert all(value["kind"] == "lesson" and value["untrusted"] and value["truncated"] for value in selected)
    assert all(value["omitted_memories"] == 4 and value["selection_truncated"] for value in selected)
    assert all(value["retrieved_candidates"] == 8 and value["retrieval_limit_reached"] for value in selected)
    assert [value.model_dump(mode="json") for value in originals] == before
    assert repository.search_memory.await_args.kwargs == {"match_any": True}
    assert "important_task_needle" in repository.search_memory.await_args.args[1]
    selected_item = selected[0]
    reader = service.reader("project-one", "a" * 40)
    chunks, offset = [], 0
    while True:
        result = await reader(selected_item["id"], selected_item["content_digest"], offset, 2048)
        assert len(json.dumps(result, ensure_ascii=False).encode()) <= MAX_CONTEXT_BYTES
        chunks.append(result["content"])
        if result["next_offset"] is None:
            break
        offset = result["next_offset"]
    assert "".join(chunks) == originals[0].content
    assert repository.memory_for_context.await_args.args == ("project-one", "a" * 40, selected_item["id"])


async def test_empty_or_unembedded_scope_does_not_spend_an_embedding_call():
    embeddings = SimpleNamespace(aembed_query=AsyncMock())
    service, repository = memory([], embeddings=embeddings)
    assert await service.context_for_role("project-one", "Objective", "Task details", "a" * 40, work=object()) == []
    assert await service.search("project-one", "Objective", "a" * 40) == []
    embeddings.aembed_query.assert_not_awaited()
    assert all(call.args[3] is None for call in repository.search_memory.await_args_list)


async def test_long_role_instruction_cannot_displace_all_objective_terms():
    service, repository = memory([])
    await service.context_for_role("project-one", "objective_marker important_goal", " ".join(f"instruction_{index}" for index in range(80)), "a" * 40, work=object())
    query = repository.search_memory.await_args.args[1]
    assert "objective_marker" in query and "important_goal" in query and "instruction_0" in query
    assert "instruction_16" not in query


@pytest.mark.parametrize("where", ["selected_tail", "omitted_item", "omitted_query"])
async def test_guard_checks_full_candidates_and_query_before_any_truncation(where):
    secret = "synthetic-private-context-value"
    values = [item(index) for index in range(8)]
    objective = "Objective"
    if where == "omitted_query":
        objective = "x" * 4000 + secret
    else:
        values[0 if where == "selected_tail" else 7].content = "x" * 7000 + secret
    service, _ = memory(values, guard=SecretGuard([secret]))
    with pytest.raises(DomainError) as error:
        await service.context_for_role("project-one", objective, "Task details", "a" * 40, work=object())
    assert error.value.code == "SECRET_DETECTED"


async def test_scoped_reader_checks_current_digest_full_secret_and_serialized_limit():
    value = item(content="\x01雪" * 3000)
    service, _ = memory([value])
    reader = service.reader("project-one", "a" * 40)
    signature = hashlib.sha256(value.content.encode()).hexdigest()
    result = await reader(value.id, signature)
    assert result["truncated"] and result["next_offset"] < 2048
    assert len(json.dumps(result, ensure_ascii=False).encode()) <= MAX_CONTEXT_BYTES
    with pytest.raises(DomainError) as changed:
        await reader(value.id, "b" * 64)
    assert changed.value.code == "MEMORY_CONTEXT_STALE"
    service.guard.known_secrets = (value.content[-30:],)
    with pytest.raises(DomainError) as secret:
        await reader(value.id, signature, 0, 1)
    assert secret.value.code == "SECRET_DETECTED"


@pytest.mark.parametrize(("offset", "limit"), [(-1, 1), (8001, 1), (False, 2), (0, True), (0, 2049)])
async def test_reader_rejects_invalid_ranges_before_lookup(offset, limit):
    service, repository = memory([item()])
    with pytest.raises(DomainError):
        await service.reader("project-one", "a" * 40)("memory-0", "a" * 64, offset, limit)
    repository.memory_for_context.assert_not_awaited()


async def test_context_validator_checks_each_distinct_reference_and_empty_context_does_no_lookup():
    value = item()
    service, repository = memory([value])
    validate = service.context_validator("project-one", "a" * 40)
    await validate([])
    repository.memory_for_context.assert_not_awaited()
    reference = {"id": value.id, "content_digest": hashlib.sha256(value.content.encode()).hexdigest()}
    await validate([reference, reference])
    repository.memory_for_context.assert_awaited_once_with("project-one", "a" * 40, value.id)


@pytest.mark.parametrize("change", ["invalidated", "other_scope", "digest", "legacy"])
async def test_context_validator_blocks_stale_or_unverifiable_checkpoint_memories(change):
    value = item()
    service, repository = memory([value])
    reference = {"id": value.id, "content_digest": hashlib.sha256(value.content.encode()).hexdigest()}
    validate = service.context_validator("project-one", "a" * 40)
    await validate([reference])
    if change in {"invalidated", "other_scope"}:
        repository.memory_for_context.side_effect = DomainError("MEMORY_NOT_AVAILABLE", "Not available", 404)
        if change == "other_scope":
            validate = service.context_validator("other-project", "a" * 40)
    elif change == "digest":
        value.content += " changed"
    else:
        reference = {"content": "Legacy memory without verifiable identity", "source_commit": "a" * 40}
    with pytest.raises(DomainError) as error:
        await validate([reference])
    assert error.value.code == "MEMORY_CONTEXT_CHANGED"


async def test_context_validator_rechecks_secrets_in_full_original_before_model_resume():
    secret = "synthetic-secret-newly-known-in-memory"
    value = item(content="Short visible excerpt. " + "x" * 7000 + secret)
    service, _ = memory([value])
    validate = service.context_validator("project-one", "a" * 40)
    reference = {"id": value.id, "content_digest": hashlib.sha256(value.content.encode()).hexdigest(), "content": "Short visible excerpt."}
    await validate([reference])
    service.guard.known_secrets = (secret,)
    with pytest.raises(DomainError) as error:
        await validate([reference])
    assert error.value.code == "SECRET_DETECTED"

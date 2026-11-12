import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver

from sabre.agent_context import ContextPolicy, memory_references, project_tool_context
from sabre.agents import AgentTeam, GuardedCalls
from sabre.artifacts import ArtifactStore
from sabre.context_archive import ContextArchive
from sabre.models import AgentResult, DomainError
from sabre.security import SecretGuard
from tests.test_agents import Executor, Repository, ScriptedModel, setup

SOURCE = "ñ🙂 source\n" * 500


def history():
    result = [HumanMessage(content="Owner: preserve tests and approvals")]
    for index in range(6):
        name = "read_file" if index in {0, 3} else "execute"
        args = {"path": f"{index}.py"} if name == "read_file" else {"argv": ["check", str(index)]}
        content = SOURCE + str(index) if name == "read_file" else json.dumps({"exit_code": 1, "output": "Failure evidence " * 300})
        result.extend([AIMessage(id=f"ai-{index}", content="Keep this reasoning", tool_calls=[{"id": f"call-{index}", "name": name, "args": args}]),
            ToolMessage(id=f"tool-{index}", tool_call_id=f"call-{index}", content=content)])
    return result


def archived(tmp_path, messages=None, guard=None):
    messages, guard = messages or history(), guard or SecretGuard()
    store = ArtifactStore(tmp_path, guard)
    projection = project_tool_context(messages, ContextPolicy(archive_unique=True, keep_model_turns=2))
    for expected, raw in projection.originals.items():
        assert store.put(raw) == expected
    reader = ContextArchive(store, guard)
    reader.bind(messages)
    return messages, store, projection, reader


async def test_unique_old_reads_are_recoverable_without_changing_actions_arguments_or_checkpoints(tmp_path):
    messages, _, projection, reader = archived(tmp_path)
    assert projection.omitted_results == 2
    assert {ref.reason for ref in projection.references} == {"old_read"}
    for old, new in zip(messages, projection.messages, strict=True):
        assert old.id == new.id
        if isinstance(old, AIMessage):
            assert old == new
        if isinstance(old, ToolMessage) and old.tool_call_id not in {"call-0", "call-3"}:
            assert old is new
    original = messages[2].content
    ref = json.loads(projection.messages[2].content)
    parts, offset = [], 0
    while True:
        page = await reader.read(ref["tool_call_id"], ref["response_digest"], offset, 137)
        assert page["historical"] and page["currentness"] == "not_revalidated"
        parts.append(page["content"])
        if page["eof"]:
            break
        offset = page["next_offset"]
    assert "".join(parts) == original
    assert messages[2].content == SOURCE + "0"
    assert projection.sent_bytes < projection.original_bytes


@pytest.mark.parametrize("forged", [False, True])
async def test_foreign_or_forged_reference_is_rejected_before_artifact_access(forged):
    store = SimpleNamespace(get=Mock())
    reader = ContextArchive(store, SecretGuard())
    reference = {"sabre_context_reference": 2, "tool_call_id": "call-0", "response_digest": "a" * 64}
    content = json.dumps(reference) if forged else "Different child content"
    reader.bind([AIMessage(content="", tool_calls=[{"id": "call-0", "name": "read_file", "args": {"path": "other.py"}}]), ToolMessage(tool_call_id="call-0", content=content)])
    with pytest.raises(DomainError) as error:
        await reader.read("call-0", "a" * 64)
    assert error.value.code == "CONTEXT_REFERENCE_NOT_ALLOWED"
    store.get.assert_not_called()


async def test_new_secret_outside_page_is_blocked_by_complete_original_check(tmp_path):
    secret = "synthetic-new-private-value"
    messages = history()
    messages[2].content = SOURCE + secret
    guard = SecretGuard()
    _, _, projection, reader = archived(tmp_path, messages, guard)
    guard.known_secrets = (secret,)
    ref = next(ref for ref in projection.references if ref.tool_call_id == "call-0")
    with pytest.raises(DomainError) as error:
        await reader.read(ref.tool_call_id, ref.response_digest, 0, 3)
    assert error.value.code == "SECRET_DETECTED"


@pytest.mark.parametrize("missing", [True, False])
async def test_missing_or_corrupt_historical_artifact_never_returns_a_page(tmp_path, missing):
    _, _, projection, reader = archived(tmp_path)
    ref = projection.references[0]
    def invalid_artifact(_):
        if missing:
            raise DomainError("ARTIFACT_NOT_FOUND", "The artifact is unavailable", 404)
        return b"x" * ref.original_bytes
    reader.artifacts = SimpleNamespace(get=invalid_artifact)
    with pytest.raises(DomainError) as error:
        await reader.read(ref.tool_call_id, ref.response_digest)
    assert error.value.code == ("ARTIFACT_NOT_FOUND" if missing else "ARTIFACT_CORRUPT")


@pytest.mark.parametrize("offset,limit", [(-1, 1), (0, 2049), (999999, 1), (True, 1)])
async def test_recovery_rejects_invalid_unicode_page_ranges(tmp_path, offset, limit):
    _, _, projection, reader = archived(tmp_path)
    ref = projection.references[0]
    with pytest.raises(DomainError, match="offset|characters"):
        await reader.read(ref.tool_call_id, ref.response_digest, offset, limit)


@pytest.mark.parametrize("section", ["messages", "system", "tools"])
async def test_complete_irreducible_context_is_rejected_before_reservation(section):
    work, _, config = setup()
    config.context_input_max_bytes = 2048
    request = ModelRequest(model=ScriptedModel(), messages=[HumanMessage(content="Short instruction")])
    if section == "messages":
        request = request.override(messages=[HumanMessage(content="Important instruction " * 1000)])
    elif section == "system":
        request = request.override(system_message=SystemMessage(content="System policy " * 1000))
    else:
        request = request.override(tools=[{"name": "fixture", "description": "Contract " * 1000}])
    repository, handler = Repository(), AsyncMock()
    with pytest.raises(DomainError) as error:
        await GuardedCalls(repository, config, work, SecretGuard()).awrap_model_call(request, handler)
    assert error.value.code == "CONTEXT_BUDGET_EXHAUSTED"
    assert repository.reservations == []
    handler.assert_not_awaited()


@pytest.mark.parametrize("invalidate_on_resume", [False, True])
async def test_pending_recovery_rebuilds_scope_before_tools_and_preserves_original_child(tmp_path, monkeypatch, invalidate_on_resume):
    class Model(ScriptedModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            index = self._calls
            self._calls += 1
            if index == 0:
                name, args = "read_file", {"path": "app.py"}
            elif index < 3:
                name, args = "list_files", {}
            elif index == 3:
                reference = next(json.loads(m.content) for m in messages if isinstance(m, ToolMessage) and m.tool_call_id == "step-0")
                assert reference["sabre_context_reference"] == 2
                name, args = "read_context", {"tool_call_id": "step-0", "response_digest": reference["response_digest"], "offset": 0, "limit": 128}
            else:
                recovered = next(json.loads(m.content) for m in messages if isinstance(m, ToolMessage) and m.tool_call_id == "step-3")
                assert recovered["content"] == SOURCE[:128]
                name, args = "AgentResult", AgentResult(accepted=True, summary="Contenido histórico recuperado").model_dump(mode="json")
            response = AIMessage(content="", tool_calls=[{"id": f"step-{index}", "name": name, "args": args}],
                usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})
            return ChatResult(generations=[ChatGeneration(message=response)])

    class ReadExecutor(Executor):
        async def read_file(self, work_id, path):
            return SOURCE

        async def list_files(self, work_id):
            return ["app.py"]

    original_read, fail_once = ContextArchive.read, True

    async def interrupted_read(self, *args, **kwargs):
        nonlocal fail_once
        if fail_once:
            fail_once = False
            raise DomainError("CONTEXT_TEST_INTERRUPTED", "Synthetic interruption before historical read")
        return await original_read(self, *args, **kwargs)

    monkeypatch.setattr(ContextArchive, "read", interrupted_read)
    work, project, config = setup()
    repository, executor, model, saver = Repository(), ReadExecutor(), Model(), InMemorySaver()
    store = ArtifactStore(tmp_path, SecretGuard())
    invalidated = False
    reference = {"id": "memory-fixture", "content_digest": "a" * 64}
    async def validate_memory(references):
        assert reference in references
        if invalidated:
            raise DomainError("MEMORY_CONTEXT_CHANGED", "La memoria se ha invalidado")
    def team():
        return AgentTeam(config, repository, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver, artifacts=store)
    with pytest.raises(DomainError, match="Synthetic interruption"):
        await team().run("developer", work, project, "Recover old evidence", memory=[reference], memory_tools={"validate_context": validate_memory})
    assert len(repository.reservations) == len(repository.settled) == 4
    invalidated = invalidate_on_resume
    if invalidated:
        with pytest.raises(DomainError) as error:
            await team().run("developer", work, project, "Recover old evidence", memory=[], memory_tools={"validate_context": validate_memory})
        assert error.value.code == "MEMORY_CONTEXT_CHANGED"
        assert len(repository.reservations) == len(repository.settled) == model._calls == 4
        return
    result = await team().run("developer", work, project, "Recover old evidence", memory=[reference], memory_tools={"validate_context": validate_memory})
    assert result.summary == "Contenido histórico recuperado"
    assert len(repository.reservations) == len(repository.settled) == 5
    saved = [row async for row in saver.alist(None)]
    assert len({row.config["configurable"]["thread_id"] for row in saved}) == 1
    messages = saved[0].checkpoint["channel_values"]["messages"]
    assert any(isinstance(m, ToolMessage) and m.content == SOURCE for m in messages)
    assert all('"sabre_context_reference":2' not in str(m.content) for m in messages)
    assert repository.context_receipts[3].compacted_results == 1
    assert repository.context_receipts[-1].restored_pages is None
    assert store.get(hashlib.sha256(SOURCE.encode()).hexdigest()) == SOURCE.encode()


async def test_memory_used_in_history_is_revalidated_before_next_model_reservation():
    reference = {"id": "memory-fixture", "content_digest": "a" * 64}
    messages = [HumanMessage(content=json.dumps({"memory_data": [reference]})),
        AIMessage(content="", tool_calls=[{"id": "memory-read", "name": "read_memory", "args": reference}]),
        ToolMessage(tool_call_id="memory-read", content=json.dumps(reference))]
    assert memory_references(messages) == [reference, reference]
    validator = AsyncMock(side_effect=DomainError("MEMORY_CONTEXT_CHANGED", "La memoria se ha invalidado"))
    work, _, config = setup()
    repository, handler = Repository(), AsyncMock()
    request = ModelRequest(model=ScriptedModel(), messages=messages)
    with pytest.raises(DomainError) as error:
        await GuardedCalls(repository, config, work, SecretGuard(), memory_validator=validator).awrap_model_call(request, handler)
    assert error.value.code == "MEMORY_CONTEXT_CHANGED"
    validator.assert_awaited_once_with([reference, reference])
    assert repository.reservations == []
    handler.assert_not_awaited()


async def test_two_recent_read_batches_resume_with_scoped_recovery_without_clearing_history(tmp_path):
    source = "Exact recoverable source evidence.\n" * 250

    class BatchModel(ScriptedModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            index = self._calls
            self._calls += 1
            if index < 2:
                calls = [{"id": f"batch-{index}-{item}", "name": "read_file", "args": {"path": f"{index}-{item}.py"}}
                         for item in range(5)]
            elif index == 2:
                ref = json.loads(next(m.content for m in messages if isinstance(m, ToolMessage) and m.tool_call_id == "batch-1-4"))
                assert ref["sabre_context_reference"] == 2
                assert any(isinstance(m, HumanMessage) and "Preserve approvals" in m.content for m in messages)
                calls = [{"id": "recover-recent", "name": "read_context", "args": {
                    "tool_call_id": ref["tool_call_id"], "response_digest": ref["response_digest"], "offset": 0, "limit": 128}}]
            else:
                page = json.loads(next(m.content for m in messages if isinstance(m, ToolMessage) and m.tool_call_id == "recover-recent"))
                assert page["content"] == source[:128]
                calls = [{"id": "done", "name": "AgentResult", "args": AgentResult(accepted=True, summary="Recovered recent evidence").model_dump(mode="json")}]
            return ChatResult(generations=[ChatGeneration(message=AIMessage(content="", tool_calls=calls,
                usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}))])

    class BatchExecutor(Executor):
        async def read_file(self, work_id, path):
            return source + path

    work, project, config = setup()
    config.context_input_max_bytes = 70000
    config.context_dedup_keep_model_turns = 2
    config.context_archive_enabled = True
    config.context_dedup_enabled = True
    repository, executor, model, saver = Repository(), BatchExecutor(), BatchModel(), InMemorySaver()
    interrupted = False

    async def pause_after_batches(work_id):
        nonlocal interrupted
        if model._calls == 2 and not interrupted:
            interrupted = True
            return "pause"
        return None

    repository.control = pause_after_batches
    store = ArtifactStore(tmp_path, SecretGuard())

    def team():
        return AgentTeam(config, repository, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver, artifacts=store)

    with pytest.raises(DomainError) as paused:
        await team().run("developer", work, project, "Preserve approvals and inspect source")
    assert paused.value.code == "PAUSE_REQUESTED"
    assert model._calls == len(repository.reservations) == 2
    result = await team().run("developer", work, project, "Preserve approvals and inspect source")
    assert result.accepted
    assert model._calls == len(repository.reservations) == len(repository.settled) == 4
    receipt = repository.context_receipts[2]
    assert receipt.original_bytes > config.context_input_max_bytes >= receipt.sent_bytes
    assert receipt.compacted_results == 10
    saved = [row async for row in saver.alist(None)]
    assert len({row.config["configurable"]["thread_id"] for row in saved}) == 1
    durable = saved[0].checkpoint["channel_values"]["messages"]
    reads = [m for m in durable if isinstance(m, ToolMessage) and m.tool_call_id.startswith("batch-")]
    assert len(reads) == 10 and all(m.content.startswith(source) for m in reads)
    assert all("sabre_context_reference" not in str(m.content) for m in durable)
    for ref in receipt.references:
        raw = next(m.content.encode() for m in reads if m.tool_call_id == ref.tool_call_id)
        assert store.get(ref.response_digest) == raw


@pytest.mark.parametrize("case", ["over_limit", "within_limit", "archive_disabled", "dedup_disabled", "no_recovery", "irreducible"])
async def test_recent_read_fallback_preserves_required_context_and_policy(tmp_path, case):
    work, _, config = setup()
    config.context_input_max_bytes = 10000 if case != "within_limit" else 100000
    config.context_archive_enabled = case != "archive_disabled"
    config.context_dedup_enabled = case != "dedup_disabled"
    config.context_dedup_keep_model_turns = 2
    source = "Recoverable source " * 2000
    calls = [{"id": name, "name": tool, "args": {}} for name, tool in (
        ("read", "read_file"), ("mutation", "write_file"), ("failure", "read_file"), ("page", "read_context"))]
    messages = [HumanMessage(content="Owner constraints and approvals"), AIMessage(content="Current plan", tool_calls=calls),
        ToolMessage(id="original-read", tool_call_id="read", content=source),
        ToolMessage(tool_call_id="mutation", content="Mutation evidence " * (2000 if case == "irreducible" else 10)),
        ToolMessage(tool_call_id="failure", status="error", content="Required error evidence"),
        ToolMessage(tool_call_id="page", content="Exact requested recovery page")]
    original = [m.model_dump(mode="json") for m in messages]
    guard, repository, handler = SecretGuard(), Repository(), AsyncMock(return_value=SimpleNamespace(result=[]))
    store = ArtifactStore(tmp_path, guard)
    archive = None if case == "no_recovery" else ContextArchive(store, guard)
    request = ModelRequest(model=ScriptedModel(), messages=messages, system_message=SystemMessage(content="Current platform instructions"))
    middleware = GuardedCalls(repository, config, work, guard, artifacts=store, context_archive=archive)
    if case not in {"over_limit", "within_limit"}:
        with pytest.raises(DomainError) as error:
            await middleware.awrap_model_call(request, handler)
        assert error.value.code == "CONTEXT_BUDGET_EXHAUSTED"
        assert repository.reservations == []
        handler.assert_not_awaited()
    else:
        await middleware.awrap_model_call(request, handler)
        sent = handler.await_args.args[0]
        assert sent.system_message == request.system_message
        for index in (0, 1, 3, 4, 5):
            assert sent.messages[index] == messages[index]
        if case == "over_limit":
            ref = json.loads(sent.messages[2].content)
            assert sent.messages[2].id == "original-read" and sent.messages[2].tool_call_id == "read"
            assert (await archive.read("read", ref["response_digest"], 0, 128))["content"] == source[:128]
        else:
            assert sent.messages == messages
            assert not list(store.root.glob("*/*"))
    assert [m.model_dump(mode="json") for m in messages] == original


def test_reused_tool_id_cannot_hide_old_memory_from_validation():
    messages = [AIMessage(content="", tool_calls=[{"id": "reused", "name": "read_memory", "args": {}}]),
        ToolMessage(tool_call_id="reused", content=json.dumps({"id": "memory", "content_digest": "a" * 64})),
        AIMessage(content="", tool_calls=[{"id": "reused", "name": "read_file", "args": {"path": "a.py"}}])]
    with pytest.raises(DomainError, match="ambiguous"):
        memory_references(messages)

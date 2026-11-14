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
    # Older reads and older command output are archived; the two most recent turns stay complete.
    assert projection.omitted_results == 4
    assert {(ref.tool_call_id, ref.reason) for ref in projection.references} == {
        ("call-0", "old_read"), ("call-3", "old_read"), ("call-1", "old_output"), ("call-2", "old_output")}
    for old, new in zip(messages, projection.messages, strict=True):
        assert old.id == new.id
        if isinstance(old, AIMessage):
            assert old == new
        if isinstance(old, ToolMessage) and old.tool_call_id not in {"call-0", "call-1", "call-2", "call-3"}:
            assert old is new
    output = json.loads(projection.messages[4].content)
    assert output["tool"] == "execute" and output["exit_code"] == 1 and "full_output" not in output
    page = await reader.read("call-1", output["response_digest"], 0, 8192)
    assert page["content"] == messages[4].content and page["eof"]
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


@pytest.mark.parametrize("offset,limit", [(-1, 1), (0, 8193), (999999, 1), (True, 1)])
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


PAGE_SOURCE = "a" * 64


def recovered(offset, text="recovered line\n" * 400, eof=False):
    return json.dumps({"historical": True, "currentness": "not_revalidated", "tool_call_id": "read-0", "response_digest": PAGE_SOURCE,
        "original_bytes": 50000, "offset": offset, "next_offset": None if eof else offset + len(text), "eof": eof, "content": text})


def restoring_history(turns, content=recovered):
    """One read, then model turns that each recover one page of it."""
    messages = [HumanMessage(content="Owner: preserve tests and approvals"),
        AIMessage(id="ai-read", content="", tool_calls=[{"id": "read-0", "name": "read_file", "args": {"path": "a.py"}}]),
        ToolMessage(id="tool-read", tool_call_id="read-0", content=SOURCE)]
    for index in range(turns):
        arguments = {"tool_call_id": "read-0", "response_digest": PAGE_SOURCE, "offset": index * 6000}
        messages += [AIMessage(id=f"ai-{index}", content="", tool_calls=[{"id": f"page-{index}", "name": "read_context", "args": arguments}]),
            ToolMessage(id=f"tool-{index}", tool_call_id=f"page-{index}", content=content(index * 6000))]
    return messages


def test_recovery_pages_older_than_the_protected_turns_collapse_to_their_coordinates():
    messages = restoring_history(6)
    original = [m.model_dump(mode="json") for m in messages]
    projection = project_tool_context(messages, ContextPolicy(archive_unique=True, keep_model_turns=2))
    pages = {m.tool_call_id: m for m in projection.messages if isinstance(m, ToolMessage) and m.tool_call_id.startswith("page-")}
    for index in range(4):
        reference = json.loads(pages[f"page-{index}"].content)
        assert reference["content_omitted"] is True and "content" not in reference and "recovered line" not in pages[f"page-{index}"].content
        assert (reference["tool"], reference["tool_call_id"], reference["response_digest"], reference["offset"], reference["chars"]) == (
            "read_context", "read-0", PAGE_SOURCE, index * 6000, 6000)
        assert reference["recover_with"] == "read_context(tool_call_id,response_digest,offset,limit)"
    # The two turns the agent has just asked for stay complete.
    assert pages["page-4"] is messages[-3] and pages["page-5"] is messages[-1]
    assert [(ref.tool_call_id, ref.tool, ref.response_digest) for ref in projection.references if ref.reason == "old_page"] == [
        (f"page-{index}", "read_context", PAGE_SOURCE) for index in range(4)]
    # A page copies an original that is already archived: nothing new is stored for it.
    assert set(projection.originals) == {hashlib.sha256(SOURCE.encode()).hexdigest()}
    assert projection.omitted_results == 5 == len(projection.references)
    assert [m.model_dump(mode="json") for m in messages] == original


def test_restoring_history_grows_the_request_by_a_reference_per_turn_not_by_a_page():
    policy = ContextPolicy(archive_unique=True, keep_model_turns=2)
    short, long = (project_tool_context(restoring_history(turns), policy) for turns in (6, 30))
    assert long.original_bytes - short.original_bytes > 24 * 6000
    # Each further turn costs its call and a reference (about 1.1 KB), against 6.6 KB for the page.
    assert long.sent_bytes - short.sent_bytes < 24 * 1200
    assert long.sent_bytes < 50000


def test_an_over_limit_request_keeps_the_pages_just_asked_for_and_sheds_the_oldest_of_them_last():
    messages = restoring_history(3)
    policy = ContextPolicy(archive_unique=True, keep_model_turns=3)
    kept = project_tool_context(messages, policy, archive_recent=True)
    assert json.loads(kept.messages[2].content)["tool"] == "read_file", "the recent read is archived first"
    assert [kept.messages[index] is messages[index] for index in (4, 6, 8)] == [True, True, True]
    shed = project_tool_context(messages, policy, archive_recent=True, shed_page_bytes=1)
    dropped = json.loads(shed.messages[4].content)
    assert dropped["content_omitted"] is True and "exceeded its input limit" in dropped["note"]
    assert shed.messages[6] is messages[6] and shed.messages[8] is messages[8]
    everything = project_tool_context(messages, policy, archive_recent=True, shed_page_bytes=10**9)
    assert json.loads(everything.messages[6].content)["content_omitted"] is True
    assert everything.messages[8] is messages[8], "the newest page is never dropped"


@pytest.mark.parametrize("content", [
    lambda offset: "Exact requested recovery page " * 300,
    lambda offset: json.dumps({"historical": True, "tool_call_id": "read-0", "response_digest": "not-a-digest", "original_bytes": 1,
                               "offset": offset, "content": "x" * 6000}),
    lambda offset: json.dumps({"historical": True, "tool_call_id": "read-0", "response_digest": PAGE_SOURCE, "original_bytes": 1,
                               "offset": -1, "content": "x" * 6000}),
    lambda offset: json.dumps({"tool_call_id": "read-0", "response_digest": PAGE_SOURCE, "original_bytes": 1, "offset": offset,
                               "content": "x" * 6000}),
])
def test_a_result_that_is_not_a_recovery_page_is_never_collapsed(content):
    messages = restoring_history(6, content)
    projection = project_tool_context(messages, ContextPolicy(archive_unique=True, keep_model_turns=2), archive_recent=True, shed_page_bytes=10**9)
    for old, new in zip(messages, projection.messages, strict=True):
        if isinstance(old, ToolMessage) and old.tool_call_id.startswith("page-"):
            assert old is new
    assert not [ref for ref in projection.references if ref.reason == "old_page"]


async def test_an_agent_that_keeps_restoring_history_is_not_stopped_by_its_own_recovery_pages(tmp_path):
    work, _, config = setup()
    config.context_input_max_bytes = 40000
    config.context_archive_enabled, config.context_dedup_enabled, config.context_dedup_keep_model_turns = True, True, 2
    messages = restoring_history(12)
    assert len(json.dumps([m.model_dump(mode="json") for m in messages]).encode()) > 2 * config.context_input_max_bytes
    guard, repository, handler = SecretGuard(), Repository(), AsyncMock(return_value=SimpleNamespace(result=[]))
    store = ArtifactStore(tmp_path, guard)
    request = ModelRequest(model=ScriptedModel(), messages=messages, system_message=SystemMessage(content="Current platform instructions"))
    await GuardedCalls(repository, config, work, guard, artifacts=store, context_archive=ContextArchive(store, guard)).awrap_model_call(request, handler)
    sent = handler.await_args.args[0]
    complete = [m.tool_call_id for m in sent.messages if isinstance(m, ToolMessage) and "recovered line" in m.content]
    assert complete == ["page-10", "page-11"]
    assert len(repository.reservations) == 1


def test_reused_tool_id_cannot_hide_old_memory_from_validation():
    messages = [AIMessage(content="", tool_calls=[{"id": "reused", "name": "read_memory", "args": {}}]),
        ToolMessage(tool_call_id="reused", content=json.dumps({"id": "memory", "content_digest": "a" * 64})),
        AIMessage(content="", tool_calls=[{"id": "reused", "name": "read_file", "args": {"path": "a.py"}}])]
    with pytest.raises(DomainError, match="ambiguous"):
        memory_references(messages)


def write_history(content=SOURCE, *, answered=True, native=True):
    arguments = {"path": "app.py", "content": content}
    write = AIMessage(id="write-turn", content=[{"type": "text", "text": "Write the fix"},
            {"type": "tool_use", "id": "write-1", "name": "write_file", "input": arguments}] if native else "Write the fix",
        tool_calls=[{"id": "write-1", "name": "write_file", "args": arguments}],
        additional_kwargs={"tool_calls": [{"id": "write-1", "type": "function",
            "function": {"name": "write_file", "arguments": json.dumps(arguments)}}]} if native else {})
    result = [HumanMessage(content="Owner: change only app.py"), write]
    if answered:
        result.append(ToolMessage(tool_call_id="write-1", content=json.dumps({"written": True})))
    for index in range(2):
        result += [AIMessage(id=f"later-{index}", content="", tool_calls=[{"id": f"list-{index}", "name": "list_files", "args": {}}]),
                   ToolMessage(tool_call_id=f"list-{index}", content="app.py")]
    return result


async def test_old_write_content_is_archived_in_every_provider_copy_and_recoverable(tmp_path):
    messages = write_history()
    original = [m.model_dump(mode="json") for m in messages]
    _, _, projection, reader = archived(tmp_path, messages)
    assert [(ref.tool_call_id, ref.tool, ref.reason) for ref in projection.references] == [("write-1", "write_file", "old_argument")]
    sent = projection.messages[1]
    assert sent.id == "write-turn" and sent.tool_calls[0]["name"] == "write_file" and sent.tool_calls[0]["id"] == "write-1"
    assert sent.tool_calls[0]["args"]["path"] == "app.py"
    ref = json.loads(sent.tool_calls[0]["args"]["content"])
    assert ref["sabre_context_reference"] == 2 and ref["argument"] == "content" and "Never write" in ref["note"]
    assert sent.content[0] == {"type": "text", "text": "Write the fix"}
    assert json.loads(sent.content[1]["input"]["content"]) == ref
    assert json.loads(json.loads(sent.additional_kwargs["tool_calls"][0]["function"]["arguments"])["content"]) == ref
    assert SOURCE not in json.dumps(sent.model_dump(mode="json"), ensure_ascii=False)
    assert [m.model_dump(mode="json") for m in messages] == original
    assert projection.sent_bytes < projection.original_bytes / 2
    parts, offset = [], 0
    while offset is not None:
        page = await reader.read("write-1", ref["response_digest"], offset, 4096)
        parts.append(page["content"])
        offset = page["next_offset"]
    assert "".join(parts) == SOURCE


@pytest.mark.parametrize("case", ["unanswered", "recent", "small", "dedup_only"])
def test_write_content_stays_when_unanswered_recent_small_or_without_recovery(case):
    messages = write_history(content="print('ok')\n" if case == "small" else SOURCE, answered=case != "unanswered", native=False)
    if case == "recent":
        messages = messages[:3]
    policy = ContextPolicy(archive_unique=case != "dedup_only", keep_model_turns=2, trigger_bytes=1)
    projection = project_tool_context(messages, policy)
    assert projection.references == [] and projection.messages[1] is messages[1]


async def test_bounded_command_output_and_its_complete_artifact_are_recoverable(tmp_path):
    from sabre.tools import bounded_execution
    guard = SecretGuard()
    store = ArtifactStore(tmp_path, guard)
    output = "".join(f"line {index}: failure detail\n" for index in range(2000))
    result = bounded_execution({"exit_code": 1, "output": output}, store)
    messages = [HumanMessage(content="Fix the failing check"),
        AIMessage(content="", tool_calls=[{"id": "check-1", "name": "execute", "args": {"argv": ["python", "-m", "unittest"]}}]),
        ToolMessage(tool_call_id="check-1", content=json.dumps(result))]
    for index in range(2):
        messages += [AIMessage(content="", tool_calls=[{"id": f"list-{index}", "name": "list_files", "args": {}}]),
                     ToolMessage(tool_call_id=f"list-{index}", content="app.py")]
    projection = project_tool_context(messages, ContextPolicy(archive_unique=True, keep_model_turns=2))
    for expected, raw in projection.originals.items():
        assert store.put(raw) == expected
    reader = ContextArchive(store, guard)
    reader.bind(messages)
    ref = json.loads(projection.messages[2].content)
    assert ref["tool"] == "execute" and ref["exit_code"] == 1
    assert ref["full_output"]["output_digest"] == result["output_digest"] and ref["full_output"]["output_bytes"] == len(output.encode())
    assert projection.messages[1] is messages[1]
    shown = await reader.read("check-1", ref["response_digest"], 0, 8192)
    assert shown["content"] == messages[2].content[:8192]
    parts, offset = [], 0
    while offset is not None:
        page = await reader.read("check-1", result["output_digest"], offset, 8192)
        parts.append(page["content"])
        offset = page["next_offset"]
    assert "".join(parts) == output
    with pytest.raises(DomainError) as foreign:
        await reader.read("list-0", result["output_digest"])
    assert foreign.value.code == "CONTEXT_REFERENCE_NOT_ALLOWED"


async def test_write_file_rejects_a_copied_context_reference_as_content():
    from sabre.agents import RECOVERABLE_TOOL_ERRORS
    from sabre.tools import workspace_tools
    executor = Executor()
    catalog = workspace_tools(executor, "work", role="developer")
    reference = json.dumps({"sabre_context_reference": 2, "tool": "write_file", "content_omitted": True}, separators=(",", ":"))
    with pytest.raises(DomainError) as error:
        await catalog.invoke("write_file", {"path": "app.py", "content": reference}, "developer")
    assert error.value.code == "CONTEXT_REFERENCE_CONTENT" and error.value.code in RECOVERABLE_TOOL_ERRORS
    assert executor.writes == []
    assert (await catalog.invoke("write_file", {"path": "notes.md", "content": "Mentions sabre_context_reference in prose\n"}, "developer"))["written"]

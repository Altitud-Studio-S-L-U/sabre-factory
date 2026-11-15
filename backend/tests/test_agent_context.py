import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import PrivateAttr

from sabre.agent_context import ContextPolicy, project_tool_context
from sabre.agents import AgentTeam, GuardedCalls
from sabre.artifacts import ArtifactStore
from sabre.codex_model import AssistantEnvelope, CodexChatModel, InvocationResponse
from sabre.executor import ExecutionResult
from sabre.models import AgentResult, DomainError
from sabre.security import SecretGuard
from tests.test_agents import Executor, Repository, ScriptedModel, setup

SOURCE = 'value = "synthetic fixture"\n' * 800


def history():
    result = [HumanMessage(content='Owner approval: change only app.py; preserve all tests.')]
    for index in range(10):
        name, args = ("read_file", {"path": "app.py"}) if index < 6 else ("execute", {"argv": ["check", str(index)]})
        result += [AIMessage(id=f"model-{index}", content="Inspect and verify", tool_calls=[{"id": f"call-{index}", "name": name, "args": args}]),
                   ToolMessage(id=f"tool-{index}", tool_call_id=f"call-{index}", content=SOURCE if index < 6 else json.dumps({"exit_code": 1, "output": "Required regression fails"}))]
    return result


def test_projection_removes_only_redundant_old_reads_and_measures_serialized_bytes():
    messages = history()
    original = [m.model_dump(mode="json") for m in messages]
    projected = project_tool_context(messages, ContextPolicy())
    assert projected.omitted_results == 5
    assert projected.sent_bytes < projected.original_bytes / 2
    assert [m.model_dump(mode="json") for m in messages] == original
    assert projected.messages[12] is messages[12]  # Latest identical read stays complete, even outside the last four turns.
    assert projected.messages[13:] == messages[13:]
    assert projected.messages[0] is messages[0]
    for before, after in zip(messages, projected.messages, strict=True):
        assert before.id == after.id and before.type == after.type
        if isinstance(before, AIMessage):
            assert before.tool_calls == after.tool_calls
    reference = json.loads(projected.messages[2].content)
    assert reference["identical_result_tool_call_id"] == "call-5"
    assert reference["original_content_sha256"] == hashlib.sha256(SOURCE.encode()).hexdigest()
    assert projected.originals[reference["original_content_sha256"]] == SOURCE.encode()
    print(json.dumps({"fixture": "repeated-source-read", **projected.stats()}))


@pytest.mark.parametrize("variation", ["path", "tool", "content", "error", "duplicate_id"])
def test_unique_provenance_failures_and_ambiguous_calls_are_never_compacted(variation):
    messages = history()
    if variation == "path":
        messages[1].tool_calls[0]["args"] = {"path": "different.py"}
    elif variation == "tool":
        messages[1].tool_calls[0]["name"] = "write_file"
    elif variation == "content":
        messages[2].content += "unique source detail"
    elif variation == "error":
        messages[2].status = "error"
    else:
        messages[3].tool_calls[0]["id"] = "call-0"
    projected = project_tool_context(messages, ContextPolicy())
    assert projected.messages[2] is messages[2]


async def test_compact_cli_serialization_preserves_complete_json_contract(monkeypatch):
    captured = []

    async def invoke(self, request):
        captured.append(request.prompt)
        return InvocationResponse(result=AssistantEnvelope(content="done", tool_calls=[]), input_tokens=1, output_tokens=1, cached_input_tokens=0)

    monkeypatch.setattr(CodexChatModel, "_invoke", invoke)
    schema = {"type": "function", "function": {"name": "read_file", "description": "Read source", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}}
    call = {"name": "read_file", "args": {"path": "source with spaces.py"}, "id": "call-1", "type": "tool_call"}
    content = 'Línea con espacios  \n{"key": "value with spaces"}'
    history = [SystemMessage(content="Preserve approval"), HumanMessage(content=content), AIMessage(content="", tool_calls=[call]), ToolMessage(content=content, tool_call_id="call-1")]
    await CodexChatModel()._agenerate(history, tools=[schema], tool_choice="auto")
    decoded = json.loads(captured[0])
    assert list(decoded) == ["instruction", "tools", "tool_choice", "conversation"]
    assert decoded["conversation"] == [{"role": "system", "content": "Preserve approval"}, {"role": "human", "content": content},
        {"role": "ai", "content": "", "tool_calls": [call]}, {"role": "tool", "content": content, "tool_call_id": "call-1"}]
    assert decoded["tools"] == [schema] and decoded["tool_choice"] == "auto"
    baseline = json.dumps(decoded, ensure_ascii=False)
    assert json.loads(baseline) == decoded and len(captured[0].encode()) < len(baseline.encode())


@pytest.mark.parametrize("provider", ["Codex", "Claude"])
def test_cli_transport_exposes_invisible_source_controls_without_changing_content(provider):
    from sabre.cli_protocol import read_lines, serialize_turn

    original = '/^"[!#-~\x80-\xff]*"$/u; Línea é 😀\x7f\x85\x9f\\u0080'
    history = [HumanMessage(content=original), ToolMessage(content=original, tool_call_id="read-source")]
    wire = serialize_turn(history, [], "auto", provider)
    assert all(chr(codepoint) not in wire for codepoint in range(0x7f, 0xa0))
    assert all(escape in wire for escape in (r"\u007f", r"\u0080", r"\u0085", r"\u009f"))
    assert "Línea é 😀" in wire and "\xff" in wire
    decoded = json.loads(wire) if provider == "Codex" else read_lines(wire)
    assert [entry["content"] for entry in decoded["conversation"]] == [original, original]
    assert decoded["conversation"][1]["tool_call_id"] == "read-source"
    assert [message.content for message in history] == [original, original]


def test_cli_limit_counts_expanded_control_representation():
    from sabre.cli_protocol import MAX_INPUT_BYTES, serialize_turn

    original = "\x80" * (MAX_INPUT_BYTES // 3)
    assert len(original.encode()) < MAX_INPUT_BYTES
    with pytest.raises(DomainError) as error:
        serialize_turn([HumanMessage(content=original)], [], "auto", "Claude")
    assert error.value.code == "CLAUDE_INPUT_LIMIT"


async def test_original_secret_is_rejected_before_projection_artifacts_or_reservation(tmp_path):
    work, _, config = setup()
    messages = history()
    secret = "synthetic-hidden-old-read"
    messages[2].content += secret
    store = SimpleNamespace(put=AsyncMock())
    repo = Repository()
    middleware = GuardedCalls(repo, config, work, SecretGuard([secret]), artifacts=store)
    request = ModelRequest(model=ScriptedModel(), messages=messages)
    handler = AsyncMock()
    with pytest.raises(DomainError) as error:
        await middleware.awrap_model_call(request, handler)
    assert error.value.code == "SECRET_DETECTED"
    assert repo.reservations == []
    handler.assert_not_awaited()
    store.put.assert_not_called()


async def test_transient_model_view_keeps_durable_actions_and_unknown_reservation_on_resume(tmp_path):
    class RepeatedReads(ScriptedModel):
        _fail_once: bool = PrivateAttr(True)
        _received: list = PrivateAttr(default_factory=list)

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            self._received.append([m.model_dump(mode="json") for m in messages])
            index = self._calls
            if index == 8 and self._fail_once:
                self._fail_once = False
                raise DomainError("CODEX_RUNNER_FAILED", "Synthetic lost response")
            self._calls += 1
            if index < 6:
                name, args = "read_file", {"path": "app.py"}
            elif index == 6:
                name, args = "execute", {"argv": ["python", "-m", "unittest"]}
            elif index == 7:
                name, args = "write_file", {"path": "app.py", "content": "fixed source"}
            else:
                assert any(isinstance(m, ToolMessage) and m.content == SOURCE for m in messages)
                assert any(isinstance(m, ToolMessage) and '"exit_code": 1' in str(m.content) for m in messages)
                name, args = "AgentResult", AgentResult(accepted=True, summary="Regresión corregida").model_dump(mode="json")
            response = AIMessage(id=f"response-{index}", content="", tool_calls=[{"name": name, "args": args, "id": f"call-{index}"}],
                                 usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})
            return ChatResult(generations=[ChatGeneration(message=response)])

    class ReadExecutor(Executor):
        async def read_file(self, work_id, path):
            return SOURCE

        async def execute(self, work_id, argv):
            return ExecutionResult(exit_code=1, output="Required regression fails")

    outcomes = []
    for enabled in (False, True):
        work, project, config = setup()
        config.context_dedup_enabled = enabled
        # Keep this regression on the supported legacy dedup policy. Recoverable
        # unique reads and the new input ceiling have their own behavioral tests.
        config.context_archive_enabled = False
        config.context_dedup_keep_model_turns = 4
        config.context_input_max_bytes = 400000
        repo, executor, model, saver = Repository(), ReadExecutor(), RepeatedReads(), InMemorySaver()
        store = ArtifactStore(tmp_path / str(enabled), SecretGuard())
        team = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda model=model: model, checkpointer=saver, artifacts=store)
        with pytest.raises(DomainError, match="Synthetic lost response"):
            await team.run("developer", work, project, "Correct the defect")
        reservations = list(repo.reservations)
        assert len(reservations) == 9 and len(repo.settled) == 8 and len(executor.writes) == 1
        restored = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda model=model: model, checkpointer=saver, artifacts=store)
        result = await restored.run("developer", work, project, "Correct the defect")
        assert repo.reservations[:9] == reservations
        assert len(repo.reservations) == 10 and len(repo.settled) == 9 and len(executor.writes) == 1
        saved = [row async for row in saver.alist(None)]
        assert len({row.config["configurable"]["thread_id"] for row in saved}) == 1
        durable = saved[0].checkpoint["channel_values"]["messages"]
        assert sum(isinstance(m, ToolMessage) and m.content == SOURCE for m in durable) == 6
        assert all("sabre_context_reference" not in str(m.content) for m in durable)
        if enabled:
            assert store.get(hashlib.sha256(SOURCE.encode()).hexdigest()) == SOURCE.encode()
            assert any("sabre_context_reference" in json.dumps(call) for call in model._received)
        else:
            assert not list(store.root.glob("*/*"))
        outcomes.append((result.model_dump(), len(repo.reservations), len(repo.settled), model._calls,
                         len(json.dumps(model._received[-1], ensure_ascii=False).encode())))
    assert outcomes[0][:4] == outcomes[1][:4]
    assert outcomes[1][4] < outcomes[0][4]

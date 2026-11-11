"""Routine tool failures and one invalid model turn are recoverable; policy failures are not."""

import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver

from sabre.agents import MAX_RECOVERED_TOOL_ERRORS, AgentTeam, GuardedCalls
from sabre.models import AgentResult, DomainError
from sabre.security import SecretGuard
from tests.test_agents import Executor, Repository, ScriptedModel, setup


def middleware():
    work, _, config = setup()
    return GuardedCalls(Repository(), config, work, SecretGuard())

async def test_recoverable_tool_error_returns_an_observation_and_policy_errors_still_stop():
    guarded = middleware()
    request = SimpleNamespace(tool_call={"id": "call-1", "name": "edit_source", "args": {}})

    async def stale(_request):
        raise DomainError("SOURCE_CONTEXT_STALE", "The file changed before saving; read it again", 409)

    message = await guarded.awrap_tool_call(request, stale)
    assert message.status == "error" and message.tool_call_id == "call-1"
    assert json.loads(message.content)["error"] == {"code": "SOURCE_CONTEXT_STALE",
        "message": "The file changed before saving; read it again", "recoverable": True}
    for code in ("TOOL_NOT_ALLOWED", "SECRET_DETECTED", "BUDGET_EXHAUSTED", "TOOL_APPROVAL_REQUIRED", "WORKSPACE_QUOTA_EXCEEDED"):
        async def denied(_request, code=code):
            raise DomainError(code, "Denied", 403)
        with pytest.raises(DomainError) as error:
            await guarded.awrap_tool_call(request, denied)
        assert error.value.code == code

    async def unavailable(_request):
        raise DomainError("WORKSPACE_IO_FAILED", "The workspace helper did not return a valid result (exit 1)", 503)
    with pytest.raises(DomainError):
        await guarded.awrap_tool_call(request, unavailable)

    async def missing(_request):
        raise DomainError("WORKSPACE_IO_FAILED", "The workspace operation failed: FileNotFoundError (exit 1)", 422)
    assert (await guarded.awrap_tool_call(request, missing)).status == "error"

async def test_recovered_tool_errors_are_capped_per_agent_step():
    guarded = middleware()
    request = SimpleNamespace(tool_call={"id": "call", "name": "read_file", "args": {}})

    async def stale(_request):
        raise DomainError("SOURCE_NOT_FOUND", "Missing", 404)

    for _ in range(MAX_RECOVERED_TOOL_ERRORS):
        await guarded.awrap_tool_call(request, stale)
    with pytest.raises(DomainError):
        await guarded.awrap_tool_call(request, stale)

class FirstTurnInvalid(ScriptedModel):
    """Answers once without the structured result, then completes."""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._calls += 1
        self._inputs.append([message.content for message in messages if message.type == "human"])
        if self._calls == 1:
            message = AIMessage(content="I am done.")
        else:
            message = AIMessage(content="", tool_calls=[{"name": "AgentResult", "args": AgentResult(accepted=True, summary="Corrected").model_dump(mode="json"),
                                                         "id": "result", "type": "tool_call"}])
        message.usage_metadata = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
        return ChatResult(generations=[ChatGeneration(message=message)])

@pytest.mark.parametrize("checkpointer", [None, "memory"])
async def test_one_corrective_retry_after_an_invalid_structured_turn(checkpointer):
    work, project, config = setup()
    model = FirstTurnInvalid()
    team = AgentTeam(config, Repository(), Executor(), SecretGuard(), model_factory=lambda: model,
                     checkpointer=InMemorySaver() if checkpointer else None)
    result = await team.run("developer", work, project, "Implement the task")
    assert result.summary == "Corrected" and model._calls == 2
    assert "platform_correction" in model._inputs[1][-1] and "MODEL_OUTPUT_INVALID" in model._inputs[1][-1]

async def test_a_second_invalid_turn_still_stops():
    class AlwaysInvalid(FirstTurnInvalid):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            self._calls += 1
            message = AIMessage(content="Still no result")
            message.usage_metadata = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
            return ChatResult(generations=[ChatGeneration(message=message)])

    work, project, config = setup()
    model = AlwaysInvalid()
    team = AgentTeam(config, Repository(), Executor(), SecretGuard(), model_factory=lambda: model, checkpointer=InMemorySaver())
    with pytest.raises(DomainError) as error:
        await team.run("developer", work, project, "Implement the task")
    assert error.value.code == "MODEL_OUTPUT_INVALID" and model._calls == 2

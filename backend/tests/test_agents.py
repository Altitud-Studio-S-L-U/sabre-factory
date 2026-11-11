import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import PrivateAttr

from sabre.agents import ROLE_PROMPTS, AgentTeam
from sabre.models import AgentResult, Budget, DomainError, Project, WorkOrder
from sabre.security import SecretGuard
from sabre.workflows import Factory


class ScriptedModel(BaseChatModel):
    _calls: int = PrivateAttr(0)
    _secret: bool = PrivateAttr(False)
    _inputs: list = PrivateAttr(default_factory=list)
    _systems: list = PrivateAttr(default_factory=list)
    _input_tokens: int = PrivateAttr(10)

    @property
    def _llm_type(self):
        return "sabre-test-scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._calls += 1
        self._inputs.append([message.content for message in messages if message.type == "human"])
        self._systems.append([message.content for message in messages if message.type == "system"])
        if self._secret:
            message = AIMessage(content="sk-proj-" + "A" * 40)
        elif self._calls == 1:
            message = AIMessage(content="", tool_calls=[{"name": "write_file", "args": {"path": "app.py", "content": "print('fixed')\n"}, "id": "write-app", "type": "tool_call"}])
        else:
            message = AIMessage(content="", tool_calls=[{"name": "AgentResult", "args": AgentResult(accepted=True, summary="Archivo implementado").model_dump(mode="json"), "id": "structured-result", "type": "tool_call"}])
        message.usage_metadata = {"input_tokens": self._input_tokens, "output_tokens": 20, "total_tokens": self._input_tokens + 20}
        return ChatResult(generations=[ChatGeneration(message=message)])


class Repository:
    def __init__(self):
        self.reservations, self.settled, self.breakdowns = [], [], []
        self.events = []
        self.context_receipts = []
        self.reject = False

    async def control(self, work_id):
        return None

    async def reserve_usage(self, *args, context_receipt=None):
        if self.reject:
            raise DomainError("BUDGET_EXHAUSTED", "No hay presupuesto")
        self.reservations.append(args)
        self.context_receipts.append(context_receipt)
        return str(len(self.reservations))

    async def settle_usage(self, *args, breakdown=None):
        self.settled.append(args)
        self.breakdowns.append(breakdown)

    async def record_execution_event(self, event):
        self.events.append(event)


class Executor:
    def __init__(self):
        self.writes = []

    async def write_file(self, work_id, path, content):
        self.writes.append((work_id, path, content))


def setup():
    work = WorkOrder(project_id="p", mode="patch", objective="Corregir el cálculo", acceptance=["Resultado correcto"], budget=Budget(max_cost_usd=1), idempotency_key="model-loop-fixture")
    project = Project(id="p", name="Fixture", repository="https://github.com/owner/repo", profile="python", gate_commands=[["python", "-m", "unittest"]])
    config = SimpleNamespace(model_max_output_tokens=100, model_input_usd_per_million=1, model_output_usd_per_million=2, monthly_budget_usd=100, mcp_servers={})
    return work, project, config


async def test_langchain_role_executes_tools_and_restores_completed_checkpoint_without_rebilling():
    work, project, config = setup()
    repo, executor, model, saver = Repository(), Executor(), ScriptedModel(), InMemorySaver()
    team = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    result = await team.run("developer", work, project, "Implement the task")
    assert result.summary == "Archivo implementado"
    assert executor.writes == [(work.id, "app.py", "print('fixed')\n")]
    assert model._calls == 2
    assert len(repo.reservations) == len(repo.settled) == 2
    context = json.loads(model._inputs[0][0])
    assert context["project"]["gate_commands"] == project.gate_commands
    assert context["project"]["execution_profile"] == project.profile
    restored = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    assert (await restored.run("developer", work, project, "Implement the task")).summary == result.summary
    assert model._calls == 2
    assert len(executor.writes) == 1


async def test_settlement_records_the_provider_token_split_and_tool_result_size():
    work, project, config = setup()
    repo, executor = Repository(), Executor()

    class CachingModel(ScriptedModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            result = super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
            result.generations[0].message.usage_metadata["input_token_details"] = {"cache_read": 6}
            return result

    model = CachingModel()
    team = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model)
    await team.run("developer", work, project, "Implement the task")
    assert repo.breakdowns == [{"input_tokens": 10, "output_tokens": 20, "cache_read_tokens": 6}] * 2
    writes = [event for event in repo.events if event.kind == "tool" and event.state == "completed"]
    assert [(event.name, event.output_bytes) for event in writes] == [("write_file", len('{"written":true}'))]
    started = [event for event in repo.events if event.state == "started"]
    assert started and all(event.output_bytes is None for event in started)
    assert all("output_bytes" not in event.model_dump(mode="json") for event in started)


@pytest.mark.parametrize("role", ["qa", "developer"])
async def test_execute_keeps_qa_checks_in_a_copy_and_developer_writes_in_workspace(role):
    from sabre.executor import ExecutionResult

    work, project, config = setup()
    source = {"src/app.py": "original source"}
    dispatched = []

    class CheckingModel(ScriptedModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if self._calls == 0:
                self._calls += 1
                message = AIMessage(content="", tool_calls=[{"name": "execute", "args": {"argv": project.gate_commands[0]}, "id": "run-check", "type": "tool_call"}])
                return ChatResult(generations=[ChatGeneration(message=message)])
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    class CheckingExecutor:
        async def snapshot(self, work_id):
            assert work_id == work.id
            return {"digest": "a" * 64}

        async def execute(self, work_id, argv):
            dispatched.append(("workspace", work_id, argv))
            source["dist/app.js"] = "generated output"
            return ExecutionResult(exit_code=0, output="passed")

        async def execute_gate(self, work_id, argv, digest):
            assert digest == "a" * 64
            dispatched.append(("copy", work_id, argv))
            copy = dict(source)
            copy["dist/app.js"] = "generated output"
            return ExecutionResult(exit_code=0, output="passed")

    result = await AgentTeam(config, Repository(), CheckingExecutor(), SecretGuard(), model_factory=CheckingModel).run(
        role, work, project, "Run the approved check")
    assert result.accepted
    assert dispatched == [("copy" if role == "qa" else "workspace", work.id, project.gate_commands[0])]
    assert source["src/app.py"] == "original source"
    assert ("dist/app.js" in source) is (role == "developer")


async def test_budget_rejection_happens_before_provider_call():
    work, project, config = setup()
    repo, model = Repository(), ScriptedModel()
    repo.reject = True
    team = AgentTeam(config, repo, Executor(), SecretGuard(), model_factory=lambda: model)
    with pytest.raises(DomainError) as error:
        await team.run("developer", work, project, "Implement the task")
    assert error.value.code == "BUDGET_EXHAUSTED"
    assert model._calls == 0


@pytest.mark.parametrize("progress_limits", [False, True])
async def test_pending_child_keeps_original_messages_effect_and_unknown_usage_reservation(monkeypatch, progress_limits):
    class InterruptedModel(ScriptedModel):
        _fail_once: bool = PrivateAttr(True)

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if self._calls == 1 and self._fail_once:
                self._fail_once = False
                raise DomainError("CODEX_RUNNER_FAILED", "Synthetic lost response")
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    work, project, config = setup()
    if progress_limits:
        config.model_provider = "codex_cli"
        work.budget.max_cost_usd = 0
    repo, executor, model, saver = Repository(), Executor(), InterruptedModel(), InMemorySaver()
    team = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    with pytest.raises(DomainError, match="Synthetic lost response"):
        await team.run("developer", work, project, "Implement the task")
    assert len(executor.writes) == 1 and len(repo.reservations) == 2 and len(repo.settled) == 1
    if progress_limits:
        work.budget = Budget(max_calls=None, max_tokens=None, active_seconds=None)
    else:
        work.budget.max_tokens += 1000
        work.budget.max_calls += 1
    monkeypatch.setitem(ROLE_PROMPTS, "developer", ROLE_PROMPTS["developer"] + " Synthetic updated recovery guidance.")
    restored = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    await restored.run("developer", work, project, "Implement the task", memory=[{"content": "new context after restart"}])
    assert len(executor.writes) == 1
    assert len(repo.reservations) == 3 and len(repo.settled) == 2
    assert json.loads(model._inputs[-1][0])["memory_data"] == []
    assert model._inputs[-1] == model._inputs[0]
    assert model._systems[-1] != model._systems[0]
    assert "Synthetic updated recovery guidance." in model._systems[-1][0]


async def test_legacy_plan_reuses_existing_supervisor_checkpoint_without_another_model_call():
    legacy_instruction = "Produce the task DAG. Assign implementation to developer, independent test assessment to qa. Include acceptance criteria. Assign each task a technical specialty (general, backend, frontend, infrastructure or documentation) from repository evidence and its concrete scope; specialties do not grant extra tool permissions."
    work, project, config = setup()
    repo, model, saver = Repository(), ScriptedModel(), InMemorySaver()
    model._calls = 1
    team = AgentTeam(config, repo, Executor(), SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    await team.run("supervisor", work, project, legacy_instruction)
    calls_before, reservations_before = model._calls, len(repo.reservations)

    async def role(role_name, current, current_project, instruction, **kwargs):
        return await team.run(role_name, current, current_project, instruction, analysis_handoff=kwargs.get("analysis_handoff"))

    factory = SimpleNamespace(begin=AsyncMock(return_value=work), repository=SimpleNamespace(project=AsyncMock(return_value=project)),
        executor=SimpleNamespace(snapshot=AsyncMock(return_value={"digest": "a" * 64, "base_commit": "b" * 40})),
        guard=SecretGuard(), role=role, finish=AsyncMock(return_value={"order": work.model_dump(mode="json")}))
    await Factory.plan(factory, {"order": work.model_dump(mode="json")})
    assert model._calls == calls_before and len(repo.reservations) == reservations_before
    assert work.summary == "Archivo implementado"


async def test_supervisor_receives_analysis_as_separate_untrusted_data_not_approved_memory():
    work, project, config = setup()
    repo, model = Repository(), ScriptedModel()
    model._calls = 1
    handoff = {"version": 1, "untrusted": True, "summary": "Observed behavior", "source_commit": "b" * 40}
    await AgentTeam(config, repo, Executor(), SecretGuard(), model_factory=lambda: model).run(
        "supervisor", work, project, "Plan product changes", analysis_handoff=handoff)
    payload = json.loads(model._inputs[0][0])
    assert payload["analysis_handoff"] == handoff
    assert payload["memory_data"] == []


async def test_secret_model_output_is_rejected_before_tool_dispatch_and_checkpoint():
    work, project, config = setup()
    model, repo, executor, saver = ScriptedModel(), Repository(), Executor(), InMemorySaver()
    model._secret = True
    team = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    with pytest.raises(DomainError) as error:
        await team.run("developer", work, project, "Implement the task")
    assert error.value.code == "SECRET_DETECTED"
    assert executor.writes == []
    assert repo.settled == []


@pytest.mark.parametrize("provider", ["codex_cli", "claude_cli"])
async def test_cli_invocations_record_tokens_without_api_spend(provider):
    work, project, config = setup()
    config.model_provider = provider
    config.monthly_budget_usd = 0
    work.budget.max_cost_usd = 0
    repo, executor, model = Repository(), Executor(), ScriptedModel()
    await AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model).run("developer", work, project, "Implement the task")
    assert len(executor.writes) == 1
    assert all(reservation[2] == 0 for reservation in repo.reservations)
    assert all(settlement[1:] == (30, 0) for settlement in repo.settled)


@pytest.mark.parametrize("provider", ["codex_cli", "claude_cli"])
async def test_cli_aggregate_overrun_is_recorded_and_blocks_requested_workspace_write(provider):
    work, project, config = setup()
    config.model_provider = provider
    repo, executor, model = Repository(), Executor(), ScriptedModel()
    model._input_tokens = 1_000_000
    with pytest.raises(DomainError) as error:
        await AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model).run("developer", work, project, "Implement the task")
    assert error.value.code == "CLI_USAGE_EXCEEDED"
    assert executor.writes == []
    assert model._calls == 1
    assert repo.settled == [("1", 1_000_020, 0)]


async def test_model_name_secrets_are_blocked_before_usage_reservation_or_provider_call():
    work, project, config = setup()
    config.model_name = "synthetic-private-model-name"
    repo, executor, model = Repository(), Executor(), ScriptedModel()
    with pytest.raises(DomainError) as error:
        await AgentTeam(config, repo, executor, SecretGuard([config.model_name]), model_factory=lambda: model).run("developer", work, project, "Implement the task")
    assert error.value.code == "SECRET_DETECTED"
    assert repo.reservations == [] and model._calls == 0 and executor.writes == []


@pytest.mark.parametrize("provider", ["codex_cli", "claude_cli"])
async def test_cli_progress_limits_record_usage_above_estimate_without_a_cumulative_quota(provider):
    work, project, config = setup()
    config.model_provider = provider
    work.budget = Budget(max_calls=None, max_tokens=None, active_seconds=None)
    repo, executor, model = Repository(), Executor(), ScriptedModel()
    model._input_tokens = 1_000_000
    result = await AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model).run("developer", work, project, "Implement the task")
    assert result.accepted and len(executor.writes) == 1
    assert len(repo.reservations) == len(repo.settled) == 2
    assert all(settlement[1:] == (1_000_020, 0) for settlement in repo.settled)


async def test_cli_progress_limits_stop_a_repeating_agent_at_the_existing_graph_step_limit():
    class RepeatingModel(ScriptedModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            self._calls += 1
            message = AIMessage(content="", tool_calls=[{"name": "write_file", "args": {"path": "app.py", "content": "synthetic"}, "id": f"write-{self._calls}", "type": "tool_call"}])
            return ChatResult(generations=[ChatGeneration(message=message)])

    work, project, config = setup()
    config.model_provider = "codex_cli"
    work.budget = Budget(max_calls=None, max_tokens=None, active_seconds=None)
    repo, executor, model = Repository(), Executor(), RepeatingModel()
    with pytest.raises(DomainError) as error:
        await AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model).run("developer", work, project, "Implement the task")
    assert error.value.code == "AGENT_STEP_LIMIT"
    assert 0 < len(executor.writes) <= model._calls <= 50
    assert len(repo.reservations) == model._calls


@pytest.mark.parametrize("provider", ["codex_cli", "claude_cli"])
async def test_cli_stage_deadline_cancels_pending_call_and_resume_keeps_checkpoint_and_reservation(monkeypatch, provider):
    contexts = []
    timeout = asyncio.timeout
    cancelled = asyncio.Event()

    def controlled_timeout(delay):
        if delay == 600:
            context = timeout(None)
            contexts.append(context)
            return context
        return timeout(delay)

    monkeypatch.setattr(asyncio, "timeout", controlled_timeout)

    class StalledModel(ScriptedModel):
        _stall_once: bool = PrivateAttr(True)

        async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
            if self._calls == 1 and self._stall_once:
                self._stall_once = False
                assert contexts, "CLI progress mode must install the 600 second deadline"
                contexts[-1].reschedule(asyncio.get_running_loop().time())
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
            return self._generate(messages, stop=stop, **kwargs)

    work, project, config = setup()
    config.model_provider = provider
    work.budget = Budget(max_calls=None, max_tokens=None, active_seconds=None)
    repo, executor, model, saver = Repository(), Executor(), StalledModel(), InMemorySaver()
    team = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    with pytest.raises(DomainError) as error:
        await team.run("developer", work, project, "Implement the task")
    assert error.value.code == "AGENT_TIMEOUT" and cancelled.is_set()
    assert len(executor.writes) == 1 and len(repo.reservations) == 2 and len(repo.settled) == 1
    restored = AgentTeam(config, repo, executor, SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    result = await restored.run("developer", work, project, "Implement the task")
    assert result.accepted and len(contexts) == 2
    assert len(executor.writes) == 1 and len(repo.reservations) == 3 and len(repo.settled) == 2
    assert model._inputs[-1] == model._inputs[0]

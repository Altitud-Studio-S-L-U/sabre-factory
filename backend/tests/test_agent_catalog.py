from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from langchain_core.messages import AIMessage
from pydantic import ValidationError

from sabre.agent_catalog import ROLE_ADAPTERS, SPECIALISTS, baseline, definition_errors
from sabre.agent_contracts import (
    AgentDefinition,
    AgentDefinitionSnapshot,
    ChainDefinition,
    SkillReference,
    StepResult,
)
from sabre.agents import AgentTeam
from sabre.artifacts import ArtifactStore
from sabre.audit import public_id
from sabre.budget_contracts import legacy_policy
from sabre.context_receipts import ContextReceipt
from sabre.flow_contracts import ResolvedFlow, ResolvedPhase
from sabre.model_selection import ModelSelection
from sabre.models import AgentResult, Budget, DomainError, Project, Task, WorkOrder
from sabre.operator_contracts import OperatorContext
from sabre.phase_results import AnalysisResult, ImplementationResult
from sabre.repository import digest
from sabre.security import SecretGuard
from sabre.settings import Settings
from sabre.skills import SKILLS
from sabre.supervisor import SupervisorConversation
from sabre.tools import ToolCatalog, ToolDefinition, ToolPolicy

pytest_plugins = ["tests.test_factory_workflow"]


@pytest.mark.parametrize("value", [True, "1", 2, None])
def test_definitions_reject_coercions_and_unknown_versions(value):
    data = baseline("developer").model_dump()
    data["version"] = value
    with pytest.raises(ValidationError):
        AgentDefinition.model_validate(data)


def test_registered_chains_reject_code_unknown_fields_mismatched_steps_and_excess_steps():
    chain = baseline("qa").chains[0].model_dump()
    for mutation in ({"id": "execute_shell"}, {"command": "echo bypass"},
                     {"steps": [{**chain["steps"][0], "capability": "implementation"}]},
                     {"steps": [{**chain["steps"][0], "id": str(index)} for index in range(5)]}):
        with pytest.raises(ValidationError):
            ChainDefinition.model_validate({**chain, **mutation})


def test_specialists_and_legacy_adapters_are_explicit_and_visual_review_blocks():
    assert len(SPECIALISTS) == 7
    assert ROLE_ADAPTERS["architect"] == ("developer", "architecture")
    assert ROLE_ADAPTERS["supervisor"] == ROLE_ADAPTERS["manager"] == ("manager", "planning")
    assert ROLE_ADAPTERS["reviewer"] == ("manager", "review")
    assert all(not definition_errors(baseline(identifier)) for identifier in SPECIALISTS)
    definition = baseline("designer")
    definition.context.visual_review = True
    assert "Visual model review is unavailable" in definition_errors(definition)[0]


def test_step_result_rejects_incompatible_capability_payload():
    payload = dict(version=1, run_id="run", step_id="step", attempt=1, sender="developer", recipient="manager",
                   correlation_id="correlation", capability="review",
                   result=ImplementationResult(version=1, status="completed", summary="Changed", questions=[], evidence=[], changed_paths=[]))
    with pytest.raises(ValidationError):
        StepResult(**payload)


@pytest.mark.parametrize("role", ["designer", "devops"])
def test_specialists_can_record_actual_scoped_usage_context_receipts(role):
    receipt = ContextReceipt(child_id=f"run/r1/{role}/" + "0" * 64, work_id="run", project_id="project", role=role,
        plan_revision=1, original_digest="0" * 64, sent_digest="0" * 64, original_bytes=100,
        sent_bytes=100, input_limit_bytes=98304, compacted_results=0)
    assert receipt.role == role


def pinned_work(role="developer", agent="developer", capability="implementation"):
    definition = baseline(agent)
    snapshot = AgentDefinitionSnapshot(version=1, digest=digest(definition.model_dump(mode="json")), definition=definition)
    phase = {"developer": "implementation", "reviewer": "review", "supervisor": "planning"}[role]
    model = ModelSelection(provider="codex_cli", name="test", destination="http://codex-runner:8091")
    binding = ResolvedPhase(role=role, model=model, credential_target=None, skills={}, definition=snapshot)
    work = WorkOrder(project_id="p", mode="patch", objective="Implement change", acceptance=["Correct behavior"], budget=Budget(max_cost_usd=1), idempotency_key="snapshot-test")
    work.resolved_flow = ResolvedFlow(model_revision=0, phases={phase: binding}, configuration_digest="0" * 64)
    return work, binding, capability


async def test_pinned_procedure_executes_all_bounded_steps_without_following_draft_changes():
    work, binding, _ = pinned_work()
    definition = binding.definition.definition
    definition.instructions = "Pinned approved instructions"
    first = definition.chains[1].steps[0]
    first.instructions = "First instruction"
    definition.chains[1].steps.append(first.model_copy(update={"id": "second", "instructions": "Second instruction"}))
    binding.definition.digest = digest(definition.model_dump(mode="json"))
    team = AgentTeam(None, None, None, None)
    team._run_step = AsyncMock(return_value=AgentResult(accepted=True, summary="Step evidence"))
    await team.run("developer", work, SimpleNamespace(), "Implement")
    assert team._run_step.await_count == 2
    assert "First instruction" in team._run_step.await_args_list[0].args[3]
    assert "Second instruction" in team._run_step.await_args_list[1].args[3]
    assert "Previous procedure step result" in team._run_step.await_args_list[1].args[3]


async def test_rejected_step_stops_chain_and_review_never_receives_coordination_history():
    work, binding, _ = pinned_work("reviewer", "manager", "review")
    chain = binding.definition.definition.chains[1]
    chain.steps.append(chain.steps[0].model_copy(update={"id": "second"}))
    binding.definition.digest = digest(binding.definition.definition.model_dump(mode="json"))
    team = AgentTeam(None, None, None, None)
    team._run_step = AsyncMock(return_value=AgentResult(accepted=False, summary="Defect"))
    result = await team.run("reviewer", work, SimpleNamespace(), "Independently judge")
    assert not result.accepted and team._run_step.await_count == 1
    assert team._run_step.await_args.args[6] is None  # No analysis/coordination handoff.


async def test_snapshot_digest_rejects_mutation_before_any_model_or_tool_call():
    work, binding, _ = pinned_work()
    binding.definition.definition.instructions = "Changed after launch"
    team = AgentTeam(None, None, None, None)
    with patch.object(team, "_run_step", new_callable=AsyncMock) as execute:
        with pytest.raises(DomainError, match="pinned specialist definition"):
            await team.run("developer", work, SimpleNamespace(), "Implement")
        execute.assert_not_awaited()


async def test_actual_agent_uses_pinned_instructions_and_tool_intersection(monkeypatch, tmp_path):
    work, binding, _ = pinned_work()
    definition = binding.definition.definition
    definition.instructions = "Pinned owner instructions"
    definition.tools = ["allowed", "forbidden"]
    binding.definition.digest = digest(definition.model_dump(mode="json"))
    catalog = ToolCatalog(SecretGuard())
    schema = {"type": "object", "properties": {}, "additionalProperties": False}
    catalog.register(ToolDefinition("allowed", "Allowed read", schema, ToolPolicy(frozenset({"developer"}), "read"), AsyncMock()))
    catalog.register(ToolDefinition("forbidden", "Security-only read", schema, ToolPolicy(frozenset({"security"}), "read"), AsyncMock()))
    captured = {}

    def create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(ainvoke=AsyncMock(return_value={"structured_response": ImplementationResult(
            version=1, status="completed", summary="Observed result", questions=[], evidence=[], changed_paths=[])}))

    monkeypatch.setattr("sabre.agents.create_agent", create)
    monkeypatch.setattr("sabre.agents.catalog_workspace_tools", lambda *args, **kwargs: catalog)
    cfg = Settings(database_url="postgresql://unused", auth_token="synthetic-test-token-000000", executor_token="synthetic-executor-token-000", model_provider="codex_cli")
    project = Project(id="p", name="Project", repository="https://github.com/test/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    repository = SimpleNamespace(record_execution_event=AsyncMock())
    guard = SecretGuard()
    team = AgentTeam(cfg, repository, None, guard, model_factory=lambda: SimpleNamespace(), artifacts=ArtifactStore(tmp_path, guard))
    assert (await team.run("developer", work, project, "Implement")).accepted
    assert "Pinned owner instructions" in captured["system_prompt"]
    assert [tool.name for tool in captured["tools"]] == ["allowed"]
    assert captured["middleware"][0].context_archive is None  # The pinned allowlist omitted recovery.
    recorded = [call.args[0] for call in repository.record_execution_event.await_args_list]
    assert all(event.agent_id == public_id(captured["middleware"][0].child_id) for event in recorded)


async def test_pm_receives_its_requirements_method_and_registered_checks_without_execution_authority(monkeypatch):
    definition = baseline("pm")
    model = ModelSelection(provider="codex_cli", name="test", destination="http://codex-runner:8091")
    binding = ResolvedPhase(role="analyst", model=model, credential_target=None,
        skills={skill.name: skill.digest for skill in definition.skills},
        definition=AgentDefinitionSnapshot(version=1, digest=digest(definition.model_dump(mode="json")), definition=definition))
    work = WorkOrder(project_id="p", mode="audit", objective="Inspect the parser", acceptance=["Report actual registered test results"], budget=Budget(max_cost_usd=0), idempotency_key="pm-method-test")
    work.resolved_flow = ResolvedFlow(model_revision=0, phases={"analysis": binding}, configuration_digest="0" * 64)
    captured = {}
    invoke = AsyncMock(return_value={"structured_response": AnalysisResult(version=1, status="completed",
        summary="Requirements ready for deterministic verification", questions=[], evidence=["src/parser.py"],
        decisions=["The registered test command will provide the measured result during verification."])})

    def create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(ainvoke=invoke)

    monkeypatch.setattr("sabre.agents.create_agent", create)
    cfg = Settings(database_url="postgresql://unused", auth_token="synthetic-test-token-000000", executor_token="synthetic-executor-token-000", model_provider="codex_cli")
    project = Project(id="p", name="Project", repository="https://github.com/test/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    team = AgentTeam(cfg, SimpleNamespace(record_execution_event=AsyncMock()), None, SecretGuard(), model_factory=lambda: object())
    result = await team.run("analyst", work, project, "Inspect requirements")
    assert result.accepted and invoke.await_count == 1
    assert SKILLS["requirements"].instruction in captured["system_prompt"]
    assert captured["response_format"] is AnalysisResult
    assert "execute" not in {tool.name for tool in captured["tools"]}
    assert "write_file" not in {tool.name for tool in captured["tools"]}
    initial = invoke.await_args.args[0]["messages"][0].content
    assert definition.chains[0].steps[0].instructions in initial
    assert '"gate_commands": [["python", "-m", "unittest"]]' in initial


def test_requirements_skill_cannot_be_attached_to_an_unrelated_specialist():
    qa = baseline("qa")
    qa.skills.append(SkillReference(name="requirements", digest=SKILLS["requirements"].digest))
    assert "Skill requirements does not apply to this specialist" in definition_errors(qa)


async def test_designer_and_devops_are_invoked_by_existing_graph_stages(build_factory):
    factory, repo, _, executor, _, publisher = build_factory()
    work = repo.current
    work.objective = "Implement an interface with observable user behavior"
    model = ModelSelection(provider="codex_cli", name="test", destination="http://codex-runner:8091")
    work.resolved_flow = ResolvedFlow(model_revision=0, phases={
        "ux": ResolvedPhase(role="designer", model=model, credential_target=None, skills={}),
        "delivery_preparation": ResolvedPhase(role="devops", model=model, credential_target=None, skills={}),
    }, configuration_digest="0" * 64)
    await repo.save(work)
    calls = []

    async def role(name, work, project, instruction, **kwargs):
        calls.append(name)
        tasks = [Task(title="Interface behavior", scope=["app.py"], acceptance=["Correct behavior"], verification_commands=project.gate_commands)] if name == "supervisor" else []
        return AgentResult(accepted=True, summary="Evidence inspected", tasks=tasks)

    factory.role = role
    planned = await factory.plan({"order": work.model_dump(mode="json")})
    assert calls == ["designer", "supervisor"]
    await factory.commit({**planned, "snapshot": await executor.snapshot(work.id), "gates": [], "review": "Reviewed independently",
                          "security": {"blocked": False, "rules_version": "rules-test", "policy_digest": "0" * 64, "exception_ids": []}})
    assert calls[-1] == "devops" and publisher.calls == ["commit"]


async def test_operator_uses_its_pinned_manager_definition_without_expanding_message_grants(monkeypatch):
    definition = baseline("manager")
    definition.instructions = "Pinned conversational specialist instructions"
    definition.tools = ["get_work", "control_work"]
    snapshot = AgentDefinitionSnapshot(version=1, digest=digest(definition.model_dump(mode="json")), definition=definition)
    event = OperatorContext(version=1, id="message-one", text="Inspect current state", idempotency_key="operator-test-one", definition=snapshot)
    cfg = Settings(database_url="postgresql://unused", auth_token="synthetic-test-token-000000", executor_token="synthetic-executor-token-000", model_provider="codex_cli", model_name="test")
    service = SimpleNamespace(config=cfg, repository=SimpleNamespace(), guard=SecretGuard(), queue=SimpleNamespace())
    captured = {}

    def create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(ainvoke=AsyncMock(return_value={"messages": [AIMessage(content="Observed state")]}))

    monkeypatch.setattr("sabre.supervisor.create_agent", create)
    conversation = SupervisorConversation(service, None, None, model_factory=lambda: object())
    assert await conversation.reply(event) == "Observed state"
    assert "Pinned conversational specialist instructions" in captured["system_prompt"]
    assert "factory chief engineer" in captured["system_prompt"]
    assert [tool.name for tool in captured["tools"]] == ["get_work"]
    assert captured["middleware"][0].input_limit == definition.context.max_input_bytes


async def test_uncapped_cli_policy_still_stops_at_per_invocation_deadline(monkeypatch):
    work, _, _ = pinned_work()
    work.budget.policy = legacy_policy(Budget(max_calls=None, max_tokens=None, active_seconds=None), 2)
    work.effective_budget_policy = work.budget.policy.model_copy(deep=True)
    cfg = Settings(database_url="postgresql://unused", auth_token="synthetic-test-token-000000", executor_token="synthetic-executor-token-000", model_provider="codex_cli")
    project = Project(id="p", name="Project", repository="https://github.com/test/project", profile="python", gate_commands=[["python", "-m", "unittest"]])
    invoke = AsyncMock()
    monkeypatch.setattr("sabre.agents.create_agent", lambda **kwargs: SimpleNamespace(ainvoke=invoke))
    monkeypatch.setattr("sabre.agents.catalog_workspace_tools", lambda *args, **kwargs: ToolCatalog(SecretGuard()))

    class Expired:
        async def __aenter__(self):
            raise TimeoutError("Synthetic invocation deadline")

        async def __aexit__(self, *args):
            return False

    def deadline(seconds):
        assert seconds == 600
        return Expired()

    monkeypatch.setattr("sabre.agents.asyncio.timeout", deadline)
    team = AgentTeam(cfg, None, None, SecretGuard(), model_factory=lambda: object())
    with pytest.raises(DomainError) as error:
        await team.run("developer", work, project, "Implement")
    assert error.value.code == "AGENT_TIMEOUT"
    invoke.assert_not_awaited()

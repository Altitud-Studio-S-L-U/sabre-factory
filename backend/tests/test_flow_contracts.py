from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from sabre.flow_contracts import FlowConfiguration
from sabre.flows import parse_flow_yaml, resolve_flow
from sabre.model_configuration import ROLES, ModelConfigurationData, ModelSelection
from sabre.models import AgentResult, DomainError
from sabre.phase_results import AnalysisResult, PlanningResult
from sabre.settings import Settings


@pytest.mark.parametrize("document", ["version: 2", "version: '1'", "version: 1\nversion: 1",
    "version: 1\nphases: &phases {}\nphase_models: *phases", "version: 1\nexecute: rm", "repair_cycles: true"])
def test_configuration_rejects_ambiguous_or_unregistered_input(document):
    with pytest.raises(DomainError, match="Configuration"):
        parse_flow_yaml(document)


def test_yaml_and_json_share_the_same_contract():
    assert parse_flow_yaml("version: 1\nrepair_cycles: 1").model_dump() == FlowConfiguration(repair_cycles=1).model_dump()


def test_agent_cannot_omit_approval_or_claim_completion_with_questions():
    with pytest.raises(ValidationError):
        AgentResult(summary="No explicit decision")
    with pytest.raises(ValidationError):
        AnalysisResult(version=1, status="completed", summary="Done", questions=["Permission?"], evidence=[], decisions=[])
    with pytest.raises(ValidationError):
        PlanningResult(version=1, status="completed", summary="No tasks", questions=[], evidence=[], tasks=[])


async def test_run_override_wins_and_snapshot_does_not_follow_global_changes():
    choice = ModelSelection(provider="codex_cli", name="model-default", destination="http://codex-runner:8091")
    role = choice.model_copy(update={"name": "model-role"})
    flow = choice.model_copy(update={"name": "model-flow"})
    run = choice.model_copy(update={"name": "model-run"})
    data = ModelConfigurationData(default=choice, roles={name: role for name in ROLES})
    cfg = Settings(database_url="postgresql://unused", auth_token="synthetic-test-token-000000", executor_token="synthetic-executor-token-000", model_provider="codex_cli")
    models = SimpleNamespace(snapshot=AsyncMock(return_value=(3, data)), configured=lambda *_: cfg)
    credentials = SimpleNamespace(vault=SimpleNamespace(list_metadata=AsyncMock(return_value=[])))
    config = FlowConfiguration.model_validate({"phases": {"implementation": {"model": flow.model_dump()}}, "phase_models": {"implementation": run.model_dump()}})
    resolved = await resolve_flow(config, "patch", models, credentials)
    assert resolved.phases["implementation"].model.name == "model-run"
    assert resolved.phases["review"].model.name == "model-role"
    data.default.name = "changed-later"
    assert resolved.phases["analysis"].model.name == "model-role"
    assert resolved.model_revision == 3


async def test_phase_cannot_introduce_an_unapproved_destination():
    choice = ModelSelection(provider="codex_cli", name="model", destination="http://codex-runner:8091")
    data = ModelConfigurationData(default=choice, roles={name: None for name in ROLES})
    models = SimpleNamespace(snapshot=AsyncMock(return_value=(1, data)), configured=lambda *_: None)
    credentials = SimpleNamespace(vault=SimpleNamespace(list_metadata=AsyncMock(return_value=[])))
    config = FlowConfiguration.model_validate({"phase_models": {"analysis": {"provider": "local", "name": "model", "destination": "https://unapproved.example/v1"}}})
    with pytest.raises(DomainError) as error:
        await resolve_flow(config, "patch", models, credentials)
    assert error.value.code == "MODEL_DESTINATION_NOT_APPROVED"

import json
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain.agents.structured_output import AutoStrategy, ProviderStrategy, ToolStrategy
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import Field, create_model

from sabre.agents import GuardedCalls
from sabre.models import AgentResult, DomainError
from sabre.repository import digest
from sabre.security import SecretGuard
from tests.test_agents import ScriptedModel, setup


@pytest.mark.parametrize("format", [AgentResult, AutoStrategy(AgentResult), ToolStrategy(AgentResult), ProviderStrategy(AgentResult, strict=True), AgentResult.model_json_schema()])
def test_material_records_the_complete_structured_response_schema(format):
    request = ModelRequest(model=ScriptedModel(), messages=[HumanMessage(content="Inspect the fixture")], response_format=format)
    encoded = json.dumps(GuardedCalls.material(request))
    assert '"properties"' in encoded and '"accepted"' in encoded and '"maxItems": 50' in encoded
    assert '"$defs"' in encoded and '"Task"' in encoded
    assert "<class '" not in encoded and " object at " not in encoded


@dataclass
class TypedResponse:
    accepted: bool


def test_material_supports_trusted_dataclass_and_fingerprints_schema_changes():
    request = ModelRequest(model=ScriptedModel(), messages=[], response_format=TypedResponse)
    assert '"boolean"' in json.dumps(GuardedCalls.material(request))
    first = {"type": "object", "properties": {"decision": {"type": "string", "enum": ["yes"]}}}
    second = {"type": "object", "properties": {"decision": {"type": "string", "enum": ["no"]}}}
    original = GuardedCalls.material(request.override(response_format=AutoStrategy(first)))
    changed = GuardedCalls.material(request.override(response_format=AutoStrategy(second)))
    assert digest(original) != digest(changed)


async def test_response_schema_alone_exceeds_context_limit_before_reservation_or_provider():
    work, _, config = setup()
    config.context_input_max_bytes = 16384
    schema = create_model("LargeResponse", answer=(str, Field(description="Synthetic response contract. " * 1000)))
    repository = SimpleNamespace(control=AsyncMock(return_value=None), reserve_usage=AsyncMock())
    middleware = GuardedCalls(repository, config, work, SecretGuard())
    request = ModelRequest(model=ScriptedModel(), messages=[HumanMessage(content="Short request")], response_format=AutoStrategy(schema))
    handler = AsyncMock(return_value=ModelResponse(result=[AIMessage(content="ok")]))
    with pytest.raises(DomainError) as error:
        await middleware.awrap_model_call(request, handler)
    assert error.value.code == "CONTEXT_BUDGET_EXHAUSTED"
    repository.reserve_usage.assert_not_awaited()
    handler.assert_not_awaited()


async def test_response_schema_is_checked_for_secrets_before_reservation():
    secret = "synthetic-private-schema-value"
    work, _, config = setup()
    repository = SimpleNamespace(control=AsyncMock(return_value=None), reserve_usage=AsyncMock())
    middleware = GuardedCalls(repository, config, work, SecretGuard([secret]))
    request = ModelRequest(model=ScriptedModel(), messages=[], response_format=AutoStrategy({"type": "object", "description": secret}))
    handler = AsyncMock()
    with pytest.raises(DomainError) as error:
        await middleware.awrap_model_call(request, handler)
    assert error.value.code == "SECRET_DETECTED"
    repository.reserve_usage.assert_not_awaited()
    handler.assert_not_awaited()

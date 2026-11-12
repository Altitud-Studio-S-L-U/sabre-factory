import json

import pytest
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from sabre.cli_protocol import serialize_turn


@pytest.mark.parametrize("provider", ["Codex", "Claude"])
def test_empty_tool_collection_remains_explicit_data_in_the_cli_conversation(provider):
    @tool
    def list_records() -> list[dict]:
        """List records from an empty store."""
        return []

    result = list_records.invoke({"name": "list_records", "args": {}, "id": "read-1", "type": "tool_call"})
    assert isinstance(result, ToolMessage)
    original = result.model_dump()
    message = json.loads(serialize_turn([result], [], "none", provider))["conversation"][0]
    assert message == {"role": "tool", "content": "[]", "tool_call_id": "read-1"}
    assert result.model_dump() == original

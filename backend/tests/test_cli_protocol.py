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


@pytest.mark.parametrize("provider", ["Codex", "Claude"])
def test_sabre_json_payloads_are_embedded_without_double_escaping(provider):
    from langchain_core.messages import HumanMessage, ToolMessage

    payload = json.dumps({"objective": "Fix \"quoted\" totals", "task_context": {"task": {"scope": ["pricing.py"]}}, "note": "Línea"}, ensure_ascii=False)
    file_text = '{"name": "pkg",   "version": "1.0.0"}'
    owner_text = '{"a":1}'
    history = [HumanMessage(content=payload), ToolMessage(content=file_text, tool_call_id="read-1"), HumanMessage(content=owner_text)]
    wire = serialize_turn(history, [], "auto", provider)
    decoded = json.loads(wire)["conversation"]
    assert decoded[0] == {"role": "human", "content_json": json.loads(payload)}
    assert decoded[1] == {"role": "tool", "content": file_text, "tool_call_id": "read-1"}
    assert decoded[2] == {"role": "human", "content": owner_text}
    escaped = json.dumps({"conversation": [{"role": "human", "content": payload}]}, ensure_ascii=False, separators=(",", ":"))
    assert len(json.dumps(decoded[0], ensure_ascii=False, separators=(",", ":"))) < len(escaped)
    assert "content_json" in json.loads(wire)["instruction"]

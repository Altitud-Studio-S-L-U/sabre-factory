import json

import pytest
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from sabre.cli_protocol import (
    MAX_INPUT_BYTES,
    InvocationRequest,
    read_lines,
    serialize_segments,
    serialize_turn,
)
from sabre.models import DomainError


def decoded(wire: str, provider: str) -> dict:
    """A prompt read back: Codex receives one JSON document, Claude a header and one message per line."""
    return json.loads(wire) if provider == "Codex" else read_lines(wire)


@pytest.mark.parametrize("provider", ["Codex", "Claude"])
def test_empty_tool_collection_remains_explicit_data_in_the_cli_conversation(provider):
    @tool
    def list_records() -> list[dict]:
        """List records from an empty store."""
        return []

    result = list_records.invoke({"name": "list_records", "args": {}, "id": "read-1", "type": "tool_call"})
    assert isinstance(result, ToolMessage)
    original = result.model_dump()
    message = decoded(serialize_turn([result], [], "none", provider), provider)["conversation"][0]
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
    conversation = decoded(wire, provider)["conversation"]
    assert conversation[0] == {"role": "human", "content_json": json.loads(payload)}
    assert conversation[1] == {"role": "tool", "content": file_text, "tool_call_id": "read-1"}
    assert conversation[2] == {"role": "human", "content": owner_text}
    escaped = json.dumps({"conversation": [{"role": "human", "content": payload}]}, ensure_ascii=False, separators=(",", ":"))
    assert len(json.dumps(conversation[0], ensure_ascii=False, separators=(",", ":"))) < len(escaped)
    assert "content_json" in decoded(wire, provider)["instruction"]


def conversation(turns: int):
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    messages = [SystemMessage(content="You are the analyst of a synthetic project."), HumanMessage(content='{"objective":"Audit","task":1}')]
    for turn in range(turns):
        calls = [{"name": "read_file", "args": {"path": f"module_{turn}_{index}.py"}, "id": f"call-{turn}-{index}", "type": "tool_call"} for index in range(3)]
        messages.append(AIMessage(content="", tool_calls=calls))
        messages += [ToolMessage(content=f"def f_{turn}_{index}():\n    return {index}\n", tool_call_id=call["id"]) for index, call in enumerate(calls)]
    return messages


def test_a_claude_prompt_is_a_header_and_one_block_per_turn_and_only_grows():
    tools = [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}]
    before, after = serialize_segments(conversation(2), tools, "auto"), serialize_segments(conversation(3), tools, "auto")
    # A header, the system message, the human message and one block per assistant turn with its tool results.
    assert len(before) == 5 and len(after) == 6
    # The conversation that grew by a turn is the same blocks, byte for byte, and one more.
    assert after[:5] == before
    header = json.loads(before[0])
    assert list(header) == ["instruction", "tools", "tool_choice"] and header["tools"] == tools and header["tool_choice"] == "auto"
    # Every block is whole lines, each a JSON value; nothing closes the document after its last message.
    for block in after:
        assert block.endswith("\n") and all(isinstance(json.loads(line), dict) for line in block.splitlines())
    turn = [json.loads(line) for line in after[-1].splitlines()]
    assert [entry["role"] for entry in turn] == ["ai", "tool", "tool", "tool"]
    assert [entry["tool_call_id"] for entry in turn[1:]] == ["call-2-0", "call-2-1", "call-2-2"]
    # Joined, the blocks are the prompt: a reader gets the header and every message in order.
    read = read_lines("".join(after))
    assert read["instruction"] == header["instruction"] and len(read["conversation"]) == 2 + 3 * 4
    assert serialize_turn(conversation(3), tools, "auto", "Claude") == "".join(after)
    # The header holds what a call can change without the conversation growing, so that change is visible as one block.
    assert serialize_segments(conversation(2), tools, "any")[1:] == before[1:]
    assert serialize_segments(conversation(2), tools, "auto", output_schema={"type": "object"})[1:] == before[1:]


def test_a_turn_with_many_tool_results_is_still_one_block():
    from langchain_core.messages import AIMessage, HumanMessage

    calls = [{"name": "read_file", "args": {"path": f"m{index}.py"}, "id": f"call-{index}", "type": "tool_call"} for index in range(32)]
    messages = [HumanMessage(content="Read them"), AIMessage(content="", tool_calls=calls),
                *[ToolMessage(content=f"body {index}", tool_call_id=f"call-{index}") for index in range(32)]]
    segments = serialize_segments(messages, [], "auto")
    # The provider looks back over about twenty blocks from the last one: a turn that added thirty-three would never be found.
    assert len(segments) == 3 and len(segments[-1].splitlines()) == 33


def test_a_claude_prompt_over_the_limit_is_refused_by_its_whole_size():
    from langchain_core.messages import HumanMessage

    half = "x" * (MAX_INPUT_BYTES // 2)
    assert len(serialize_segments([HumanMessage(content=half[:1000])], [], "auto")) == 2
    with pytest.raises(DomainError) as error:
        serialize_segments([HumanMessage(content=half), HumanMessage(content=half)], [], "auto")
    assert error.value.code == "CLAUDE_INPUT_LIMIT"


def test_an_invocation_carries_its_prompt_in_exactly_one_form():
    from pydantic import ValidationError

    assert InvocationRequest(prompt="one text").size() == 8
    assert InvocationRequest(segments=["header\n", "turn é\n"]).size() == len("header\nturn é\n".encode())
    for refused in ({}, {"prompt": "text", "segments": ["block"]}, {"segments": []}, {"segments": ["block", ""]}):
        with pytest.raises(ValidationError):
            InvocationRequest(**refused)

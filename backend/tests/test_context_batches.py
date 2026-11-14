"""The recoverable archive in batches: nothing leaves below the high mark, and the view only grows between batches."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from sabre.agent_context import ContextPolicy, batch_plan, message_bytes, project_tool_context
from sabre.agents import ARCHIVE_HIGH_WATER, ARCHIVE_LOW_WATER, GuardedCalls
from sabre.artifacts import ArtifactStore
from sabre.context_archive import ContextArchive
from sabre.security import SecretGuard
from tests.test_agents import Repository, ScriptedModel, setup


def source(index: int, size: int = 4000) -> str:
    return f"# module {index}\n" + f"value_{index} = {index}\n" * (size // 14)


def conversation(reads: int, size: int = 4000) -> list:
    """One read per turn, each of a different file, as an agent exploring a repository would."""
    messages: list = [HumanMessage(content="Audit the repository.")]
    for index in range(reads):
        messages += [AIMessage(id=f"model-{index}", content="", tool_calls=[{"id": f"read-{index}", "name": "read_file", "args": {"path": f"m{index}.py"}}]),
                     ToolMessage(id=f"tool-{index}", tool_call_id=f"read-{index}", content=source(index, size))]
    return messages


def policy(high: int | None, low: int | None, keep: int = 2) -> ContextPolicy:
    return ContextPolicy(archive_unique=True, keep_model_turns=keep, high_water_bytes=high, low_water_bytes=low)


def archived(projection) -> list[str]:
    return [message.tool_call_id for message in projection.messages
            if isinstance(message, ToolMessage) and message.content.startswith('{"sabre_context_reference"')]


def request_bytes(messages) -> bytes:
    return json.dumps([message.model_dump(mode="json") for message in messages], ensure_ascii=False, separators=(",", ":")).encode()


def test_nothing_leaves_a_request_that_is_below_its_high_mark_however_old_it_is():
    messages = conversation(8)
    size = sum(message_bytes(message) for message in messages)
    below = project_tool_context(messages, policy(size + 1, size // 2))
    assert archived(below) == [] and below.sent_bytes == below.original_bytes and below.references == []
    # Without marks every result leaves as soon as it is outside the protected turns: the behaviour the marks replace.
    assert archived(project_tool_context(messages, policy(None, None))) == [f"read-{index}" for index in range(6)]


def test_over_the_high_mark_the_oldest_results_leave_down_to_the_low_mark_and_no_further():
    messages = conversation(8)
    total = sum(message_bytes(message) for message in messages)
    # What one archived read saves: its text minus the reference that replaces it.
    saved = message_bytes(messages[2]) - message_bytes(project_tool_context(messages, policy(1, 0)).messages[2])
    assert saved > 2000
    # Only the request being built is over the mark; two reads are not enough to reach the low mark and three are.
    high, low = total - 1, total - 2 * saved - 1
    projection = project_tool_context(messages, policy(high, low))
    assert archived(projection) == ["read-0", "read-1", "read-2"]
    assert len(request_bytes(projection.messages)) <= low
    assert {reference.reason for reference in projection.references} == {"old_read"} and len(projection.originals) == 3
    # What the request carries besides its messages counts towards the marks.
    assert archived(project_tool_context(messages, policy(high + 5000, low + 5000))) == []
    assert archived(project_tool_context(messages, policy(high + 5000, low + 5000), overhead_bytes=5001)) == ["read-0", "read-1", "read-2"]


def test_the_protected_turns_stay_even_when_the_low_mark_cannot_be_reached():
    messages = conversation(5)
    projection = project_tool_context(messages, policy(1, 0, keep=3))
    assert archived(projection) == ["read-0", "read-1"]
    assert [message.content for message in projection.messages[-6:] if isinstance(message, ToolMessage)] == [source(2), source(3), source(4)]


def test_between_two_batches_the_view_only_grows_at_its_end():
    """Every request of a growing conversation, as the provider's prompt cache would see them."""
    full = conversation(14)
    marks = policy(30000, 18000)
    previous, batches, appended = None, 0, 0
    for turn in range(1, 15):
        seen = full[:1 + 2 * turn]
        view = request_bytes(project_tool_context(seen, marks).messages)
        if previous is not None:
            # The JSON array closes with "]": everything before it must reappear unless a batch rewrote the past.
            if view.startswith(previous[:-1]):
                appended += 1
            else:
                batches += 1
        previous = view
    # 14 reads of about 4 KiB cross a 30 KiB mark a few times; every other request only appended.
    assert 2 <= batches <= 4 and appended == 13 - batches
    # The same history always yields the same view: the plan is replayed, not remembered.
    assert request_bytes(project_tool_context(full, marks).messages) == request_bytes(project_tool_context(list(full), marks).messages)
    # Without marks nearly every request rewrites an earlier message.
    legacy, rewrites = policy(None, None), 0
    previous = None
    for turn in range(1, 15):
        view = request_bytes(project_tool_context(full[:1 + 2 * turn], legacy).messages)
        rewrites += previous is not None and not view.startswith(previous[:-1])
        previous = view
    assert rewrites >= 10


def test_a_batch_takes_write_arguments_and_recovery_pages_by_age_like_any_result():
    content = "x = 1\n" * 700
    page = json.dumps({"historical": True, "currentness": "not_revalidated", "tool_call_id": "read-0", "response_digest": "a" * 64,
                       "original_bytes": 9000, "offset": 0, "next_offset": None, "eof": True, "content": "y = 2\n" * 700})
    messages = [HumanMessage(content="Change the module."),
                AIMessage(id="m0", content="", tool_calls=[{"id": "write-0", "name": "write_file", "args": {"path": "a.py", "content": content}}]),
                ToolMessage(id="t0", tool_call_id="write-0", content='{"written": true}'),
                AIMessage(id="m1", content="", tool_calls=[{"id": "page-0", "name": "read_context", "args": {"tool_call_id": "read-0", "response_digest": "a" * 64}}]),
                ToolMessage(id="t1", tool_call_id="page-0", content=page),
                *conversation(3)[1:]]
    plan = batch_plan(messages, policy(1, 0), 0)
    assert plan == {("argument", "write-0"), ("page", "page-0"), ("result", "read-0")}
    projection = project_tool_context(messages, policy(1, 0))
    assert json.loads(projection.messages[1].tool_calls[0]["args"]["content"])["argument"] == "content"
    assert json.loads(projection.messages[4].content)["tool"] == "read_context"
    assert {reference.reason for reference in projection.references} == {"old_argument", "old_page", "old_read"}
    # Above the mark only as far as needed: the oldest candidate alone can satisfy a generous low mark.
    total = sum(message_bytes(message) for message in messages)
    assert batch_plan(messages, policy(total - 1, total - 2000), 0) == {("argument", "write-0")}


async def test_the_agent_loop_takes_its_marks_from_the_settings_and_counts_the_whole_request(tmp_path):
    work, _, config = setup()
    config.context_input_max_bytes = 60000
    config.context_archive_enabled, config.context_dedup_enabled, config.context_dedup_keep_model_turns = True, True, 2
    messages = conversation(7)
    guard = SecretGuard()
    store = ArtifactStore(tmp_path, guard)

    async def sent(system: str, **marks):
        for name, value in marks.items():
            setattr(config, name, value)
        handler = AsyncMock(return_value=SimpleNamespace(result=[]))
        request = ModelRequest(model=ScriptedModel(), messages=messages, system_message=SystemMessage(content=system))
        await GuardedCalls(Repository(), config, work, guard, artifacts=store, context_archive=ContextArchive(store, guard)).awrap_model_call(request, handler)
        return handler.await_args.args[0]

    assert (ARCHIVE_HIGH_WATER, ARCHIVE_LOW_WATER) == (0.6, 0.4)
    # About 29 KiB of a 60 KiB limit: below the default high mark of 36 KiB, so the request is sent whole.
    whole = await sent("Short instructions")
    assert whole.messages == messages
    # The same conversation with long instructions is over the mark: the oldest reads leave, the instructions do not.
    long_instructions = "Follow the platform contract. " * 400
    over = await sent(long_instructions)
    assert over.system_message.content == long_instructions
    assert archived(over) and archived(over) == [f"read-{index}" for index in range(len(archived(over)))]
    assert over.messages[-4:] == messages[-4:]
    # The marks are configuration.
    assert archived(await sent("Short instructions", context_archive_high_water=0.3, context_archive_low_water=0.2))
    assert (await sent(long_instructions, context_archive_high_water=0.95, context_archive_low_water=0.9)).messages == messages

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver

from sabre.agents import PLATFORM_CONTRACT, RECOVERABLE_TOOL_ERRORS, AgentTeam
from sabre.audit import TOOLS
from sabre.models import AgentResult, DomainError, Status, Task
from sabre.repository import digest
from sabre.security import SecretGuard
from sabre.tools import ToolCatalog, ToolDefinition, ToolPolicy
from sabre.work_notes import (
    MAX_NOTE_CHARS,
    MAX_NOTES,
    MAX_NOTES_BYTES,
    NOTE_DESCRIPTION,
    NOTE_SCHEMA,
    NOTE_TOOL,
    WorkNotes,
    load_notes,
    merge_notes,
    note_scope,
)
from tests.test_agent_catalog import pinned_work
from tests.test_agents import Executor, Repository, ScriptedModel, setup
from tests.test_audit import checkpoint
from tests.test_audit import fixture as audit_fixture

pytest_plugins = ["tests.test_factory_workflow"]


def notebook(scope="task:t1", revision=1, guard=None, entries=()):
    notes = WorkNotes(scope, revision, guard or SecretGuard(), entries)
    notes.bind("work/r1/developer/" + "a" * 64, role="developer", attempt=1, step="single")
    return notes


def catalog_for(notes):
    catalog = ToolCatalog(SecretGuard())
    catalog.register(ToolDefinition(NOTE_TOOL, NOTE_DESCRIPTION, NOTE_SCHEMA, ToolPolicy(frozenset({"developer"}), "read", 10), notes.record))
    return catalog


async def test_notes_are_bounded_per_assignment_and_rejections_ask_to_consolidate():
    notes = notebook()
    for index in range(MAX_NOTES):
        result = await notes.record(f"Note {index}: app.py holds the calculation")
        assert result["recorded"] is True and result["notes"] == index + 1
    with pytest.raises(DomainError) as full:
        await notes.record("One more observation")
    assert full.value.code == "WORK_NOTES_FULL" and full.value.code in RECOVERABLE_TOOL_ERRORS
    assert "Consolidate" in full.value.message and "replaces" in full.value.message and "Nothing was recorded" in full.value.message
    assert len(notes.entries) == MAX_NOTES
    older = [entry["id"] for entry in notes.entries[:5]]
    merged = await notes.record("Notes 0-4: app.py holds the calculation", replaces=older)
    assert merged["replaced"] == older and len(notes.entries) == MAX_NOTES - 4
    assert all(entry["id"] not in older for entry in notes.entries)

    by_bytes = notebook()
    for _ in range(MAX_NOTES_BYTES // MAX_NOTE_CHARS):
        await by_bytes.record("x" * MAX_NOTE_CHARS)
    with pytest.raises(DomainError) as over:
        await by_bytes.record("y" * (MAX_NOTES_BYTES % MAX_NOTE_CHARS + 1))
    assert over.value.code == "WORK_NOTES_FULL"
    with pytest.raises(DomainError) as unknown:
        await by_bytes.record("Consolidated", replaces=["f" * 16])
    assert unknown.value.code == "WORK_NOTE_UNKNOWN" and unknown.value.code in RECOVERABLE_TOOL_ERRORS
    with pytest.raises(DomainError) as blank:
        await notebook().record("   \n")
    assert blank.value.code == "INVALID_TOOL_ARGUMENTS"


async def test_tool_contract_rejects_long_notes_and_blocks_secrets_before_recording():
    notes = notebook()
    catalog = catalog_for(notes)
    with pytest.raises(DomainError) as long:
        await catalog.invoke(NOTE_TOOL, {"note": "x" * (MAX_NOTE_CHARS + 1)}, "developer")
    assert long.value.code == "INVALID_TOOL_ARGUMENTS"
    with pytest.raises(DomainError) as secret:
        await catalog.invoke(NOTE_TOOL, {"note": "token sk-proj-" + "A" * 40}, "developer")
    assert secret.value.code == "SECRET_DETECTED"
    with pytest.raises(DomainError) as role:
        await catalog.invoke(NOTE_TOOL, {"note": "Reviewer note"}, "reviewer")
    assert role.value.code == "TOOL_NOT_ALLOWED"
    assert notes.entries == [] and not notes.changed
    assert (await catalog.invoke(NOTE_TOOL, {"note": "tests/test_app.py covers rounding"}, "developer"))["recorded"]


async def test_notes_are_redacted_when_recorded_and_when_injected_with_newer_secrets():
    secret = "synthetic-owner-value-42"
    notes = notebook(guard=SecretGuard([secret]))
    await notes.record(f"Config uses {secret} locally")
    assert notes.entries[0]["text"] == "Config uses [REDACTED] locally"
    later = "synthetic-later-value-77"
    saved = merge_notes(None, [notebook(entries=[{"id": "a" * 16, "text": f"Seen {later}", "role": "developer", "attempt": 1, "step": "single"}])])
    restored = load_notes(saved, "task:t1", 1, SecretGuard([later]))
    brief = restored.brief()
    assert brief["notes"][0]["text"] == "Seen [REDACTED]" and later not in json.dumps(brief)
    assert brief["untrusted"] is True and "not owner instructions" in brief["authority"]


async def test_saved_notes_survive_by_scope_and_revision_and_reject_invalid_state():
    first, second = notebook("task:t1"), notebook("task:t2")
    await first.record("t1: app.py")
    await second.record("t2: lib.py")
    saved = merge_notes(None, [first])
    saved = merge_notes(saved, [second])
    assert set(saved["scopes"]) == {"task:t1", "task:t2"}
    assert [n["text"] for n in load_notes(saved, "task:t1", 1, SecretGuard()).entries] == ["t1: app.py"]
    assert load_notes(saved, "task:t3", 1, SecretGuard()).entries == []
    assert load_notes(saved, "task:t1", 2, SecretGuard()).entries == []
    assert merge_notes(saved, [notebook("task:t9", revision=2)]) == {"version": 1, "plan_revision": 2, "scopes": {}}
    tampered = json.loads(json.dumps(saved))
    tampered["scopes"]["task:t1"][0]["text"] = "x" * (MAX_NOTE_CHARS + 1)
    assert load_notes(tampered, "task:t1", 1, SecretGuard()).entries == []
    assert load_notes({"version": 2}, "task:t1", 1, SecretGuard()).entries == []
    assert note_scope("qa") == "role:qa" and note_scope("developer", Task(id="t1", title="Fix")) == "task:t1"


class NotingModel(ScriptedModel):
    """Records a note on the first turn of its first conversation, then finishes."""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._calls += 1
        self._inputs.append([message.content for message in messages if message.type == "human"])
        if not any(isinstance(message, AIMessage) for message in messages) and self._calls == 1:
            calls = [{"name": NOTE_TOOL, "args": {"note": "app.py holds total(); python -m unittest fails on half cents"}, "id": "note-1", "type": "tool_call"}]
        else:
            calls = [{"name": "AgentResult", "args": AgentResult(accepted=True, summary="Done").model_dump(mode="json"), "id": f"result-{self._calls}", "type": "tool_call"}]
        message = AIMessage(content="", tool_calls=calls, usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})
        return ChatResult(generations=[ChatGeneration(message=message)])


def opening(model, call):
    return json.loads(model._inputs[call][0])


async def test_a_repair_attempt_receives_the_notes_of_the_earlier_attempt_but_not_other_tasks():
    work, project, config = setup()
    task, other = Task(id="task-a", title="Fix rounding", attempts=1), Task(id="task-b", title="Docs", attempts=1)
    work.tasks = [task, other]
    repository, model, saver = Repository(), NotingModel(), InMemorySaver()
    team = AgentTeam(config, repository, Executor(), SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    notes = load_notes(None, note_scope("developer", task), work.plan_revision, SecretGuard())
    await team.run("developer", work, project, "Task: Fix rounding", task_context={"task_id": task.id}, work_notes=notes)
    assert "work_notes" not in opening(model, 0)
    assert [(entry["attempt"], entry["role"]) for entry in notes.entries] == [(1, "developer")]
    saved = merge_notes(None, [notes])

    task.attempts = 2  # A repair attempt is a new conversation for the same task.
    repair = load_notes(saved, note_scope("developer", task), work.plan_revision, SecretGuard())
    await team.run("developer", work, project, "Task: Fix rounding", task_context={"task_id": task.id}, work_notes=repair)
    injected = opening(model, 2)["work_notes"]
    assert injected["kind"] == "agent_work_notes" and injected["scope"] == "task:task-a"
    assert [note["text"] for note in injected["notes"]] == ["app.py holds total(); python -m unittest fails on half cents"]
    assert injected["notes"][0]["attempt"] == 1

    elsewhere = load_notes(saved, note_scope("developer", other), work.plan_revision, SecretGuard())
    await team.run("developer", work, project, "Task: Docs", task_context={"task_id": other.id}, work_notes=elsewhere)
    assert "work_notes" not in opening(model, 3)
    assert "record_note" in PLATFORM_CONTRACT and NOTE_TOOL in TOOLS


async def test_notes_recorded_before_an_interruption_are_rebuilt_from_the_agent_checkpoint():
    work, project, config = setup()
    task = Task(id="task-a", title="Fix rounding", attempts=1)
    work.tasks = [task]
    repository, model, saver = Repository(), NotingModel(), InMemorySaver()
    paused = False

    async def pause_after_note(work_id):
        nonlocal paused
        if model._calls == 1 and not paused:
            paused = True
            return "pause"
        return None

    repository.control = pause_after_note
    team = AgentTeam(config, repository, Executor(), SecretGuard(), model_factory=lambda: model, checkpointer=saver)
    first = load_notes(None, "task:task-a", 1, SecretGuard())
    with pytest.raises(DomainError) as error:
        await team.run("developer", work, project, "Task: Fix rounding", task_context={"task_id": task.id}, work_notes=first)
    assert error.value.code == "PAUSE_REQUESTED" and len(first.entries) == 1
    # The stage never committed: the resumed step starts from the last saved (empty) notes.
    resumed = load_notes(None, "task:task-a", 1, SecretGuard())
    await team.run("developer", work, project, "Task: Fix rounding", task_context={"task_id": task.id}, work_notes=resumed)
    assert resumed.entries == first.entries and resumed.changed
    resumed.replay([])
    again = load_notes(merge_notes(None, [resumed]), "task:task-a", 1, SecretGuard())
    bound = "work/r1/developer/" + "b" * 64
    again.bind(bound, role="developer", attempt=1, step="single")
    history = [AIMessage(content="", tool_calls=[{"name": NOTE_TOOL, "args": {"note": "Seen"}, "id": "n"}]),
               ToolMessage(tool_call_id="n", content=json.dumps({"recorded": True, "note_id": first.entries[0]["id"], "replaced": []}))]
    again.replay(history)
    assert again.entries == first.entries and not again.changed


async def test_procedure_steps_share_notes_with_their_later_steps():
    work, binding, _ = pinned_work()
    definition = binding.definition.definition
    first = definition.chains[1].steps[0]
    definition.chains[1].steps.append(first.model_copy(update={"id": "second", "instructions": "Second instruction"}))
    binding.definition.digest = digest(definition.model_dump(mode="json"))
    notes, seen = notebook(), []

    async def step(*args, work_notes=None, procedure_step="single", **kwargs):
        seen.append(work_notes.brief())
        if procedure_step == first.id:
            await work_notes.record("Step one found the entry point in app.py")
        return AgentResult(accepted=True, summary="Step evidence")

    team = AgentTeam(None, None, None, None)
    team._run_step = AsyncMock(side_effect=step)
    await team.run("developer", work, SimpleNamespace(), "Implement", work_notes=notes)
    assert seen[0] is None and seen[1]["notes"][0]["text"] == "Step one found the entry point in app.py"


async def test_factory_persists_notes_per_task_and_injects_them_into_the_repair_attempt(build_factory):
    factory, repo, team, executor, *_ = build_factory(failures=1)
    original, received = team.run, []

    async def run(role, work, project, instruction, **kwargs):
        notes = kwargs.get("work_notes")
        if role == "supervisor":
            return AgentResult(accepted=True, summary="Plan", tasks=[Task(id="first", title="Fix calculation"),
                                                                     Task(id="second", title="Document it", depends_on=["first"])])
        if role == "developer":
            task_id = kwargs["task_context"]["task_id"]
            attempt = next(task.attempts for task in work.tasks if task.id == task_id)
            received.append((task_id, attempt, notes.scope, notes.brief()))
            if task_id == "first" and attempt == 1:
                await notes.record("app.py: calculation lives in total(); unittest covers it")
        return await original(role, work, project, instruction, **kwargs)

    team.run = run
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    assert [(task_id, attempt, scope) for task_id, attempt, scope, _ in received] == [
        ("first", 1, "task:first"), ("second", 1, "task:second"), ("second", 2, "task:second")]
    assert all(brief is None for *_, brief in received)
    saved = (await factory.graph.aget_state(factory.config(result.id))).values["work_notes"]
    assert set(saved["scopes"]) == {"task:first"} and saved["plan_revision"] == result.plan_revision
    assert saved["scopes"]["task:first"][0]["text"] == "app.py: calculation lives in total(); unittest covers it"


async def test_factory_repair_of_the_noted_task_receives_its_notes(build_factory):
    factory, repo, team, *_ = build_factory(failures=1)
    original, received = team.run, []

    async def run(role, work, project, instruction, **kwargs):
        notes = kwargs.get("work_notes")
        if role == "developer":
            received.append(notes.brief())
            if notes.brief() is None:
                await notes.record("python -m unittest fails until total() rounds half up")
        if role == "qa":
            assert notes.scope == "role:qa" and notes.brief() is None
        return await original(role, work, project, instruction, **kwargs)

    team.run = run
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED and len(received) == 2
    assert received[0] is None
    assert [note["text"] for note in received[1]["notes"]] == ["python -m unittest fails until total() rounds half up"]


async def test_audit_counts_accepted_notes_per_agent():
    service, _, saver, work, _ = audit_fixture()
    ai = AIMessage(id="turn", content="", tool_calls=[{"name": NOTE_TOOL, "id": "n1", "args": {"note": "a"}},
                                                     {"name": NOTE_TOOL, "id": "n2", "args": {"note": "b"}}])
    accepted = ToolMessage(tool_call_id="n1", content=json.dumps({"recorded": True, "note_id": "a" * 16}))
    rejected = ToolMessage(tool_call_id="n2", status="error", content=json.dumps({"error": {"code": "WORK_NOTES_FULL"}}))
    saver.aget_tuple.return_value = checkpoint([ai, accepted, rejected])
    report = await service.audit(work.id)
    assert report.agents[0].notes_recorded == 1
    assert [tool.name for tool in report.tools] == [NOTE_TOOL, NOTE_TOOL]

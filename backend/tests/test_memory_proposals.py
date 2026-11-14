"""What a run's own specialists may propose to memory while they work."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import PrivateAttr

from sabre.agents import AgentTeam
from sabre.memory import MAX_RUN_PROPOSALS, MAX_STEP_PROPOSALS, PROPOSE_GUIDANCE, PROPOSE_TOOL, MemoryService
from sabre.models import AgentResult, DomainError, MemoryCreate, ProposedBy
from sabre.security import SecretGuard
from tests.test_agents import Executor, Repository, setup
from tests.test_work_notes import audit_fixture, checkpoint

pytest_plugins = ["tests.test_factory_workflow"]

COMMIT, DIGEST = "a" * 40, "d" * 64
STATEMENT = {"statement": "Discounts are rounded half even in apply_discount().", "why": "A patch that rounds half up breaks invoices.",
             "citations": ["src/pricing/discount.py#L12"]}


def memory(work, *, indexed=True, count=0, create=None):
    async def created(item, embedding):
        return item

    repository = SimpleNamespace(work=AsyncMock(return_value=work), repository_index_digest=AsyncMock(return_value=DIGEST if indexed else None),
                                 create_memory=AsyncMock(side_effect=create or created), run_proposal_count=AsyncMock(return_value=count))
    return MemoryService(repository, SecretGuard()), repository


def running(evidence=None):
    return SimpleNamespace(id="run-1", project_id="project-one", status="running", evidence=evidence)


async def test_a_specialist_proposal_is_a_waiting_record_anchored_to_the_run_and_its_commit():
    work = running()
    service, repository = memory(work)
    result = await service.proposer(work, "analyst", COMMIT)(**STATEMENT)
    item = repository.create_memory.await_args.args[0]
    assert result == {"proposed": True, "memory_id": item.id, "state": "waiting for the owner's review",
                      "remaining_in_assignment": MAX_STEP_PROPOSALS - 1}
    assert not item.active and item.approved_at is None and item.kind == "fact" and item.scope == "project"
    assert item.content == "Discounts are rounded half even in apply_discount().\nWhy it matters: A patch that rounds half up breaks invoices."
    assert (item.source_work_id, item.source_commit, item.evidence_digest) == ("run-1", COMMIT, DIGEST)
    assert item.citations == ["src/pricing/discount.py#L12"]
    assert item.proposed_by == ProposedBy(channel="factory", role="analyst", work_id="run-1")
    # A statement over several lines still gets a one-line title.
    await service.proposer(work, "reviewer", COMMIT)(statement="The suite needs\n  REDIS_URL to be set.", why="Tests fail\nwithout it.",
                                                     citations=["tests/conftest.py"], kind="lesson")
    lesson = repository.create_memory.await_args.args[0]
    assert lesson.content == "The suite needs REDIS_URL to be set.\nWhy it matters: Tests fail without it." and lesson.kind == "lesson"


async def test_proposals_are_bounded_per_assignment_and_per_run_and_a_refusal_is_a_result():
    work = running()
    service, repository = memory(work)
    propose = service.proposer(work, "developer", COMMIT)
    for number in range(MAX_STEP_PROPOSALS):
        assert (await propose(**STATEMENT | {"statement": f"Statement number {number} about the pricing module."}))["proposed"]
    refused = await propose(**STATEMENT)
    assert refused["proposed"] is False and refused["code"] == "MEMORY_PROPOSAL_LIMIT" and "Continue with the task" in refused["reason"]
    assert repository.create_memory.await_count == MAX_STEP_PROPOSALS
    # Another assignment of the same run starts its own count but shares the run's.
    full, _ = memory(work, count=MAX_RUN_PROPOSALS)
    assert (await full.proposer(work, "analyst", COMMIT)(**STATEMENT))["code"] == "MEMORY_PROPOSAL_LIMIT"

    async def unknown(item, embedding):
        raise DomainError("MEMORY_CITATION_UNKNOWN", "Cited files must exist in the repository index at the source commit: src/new.py", 422)

    checked, _ = memory(work, create=unknown)
    result = await checked.proposer(work, "developer", COMMIT)(**STATEMENT | {"citations": ["src/new.py"]})
    assert result["proposed"] is False and result["code"] == "MEMORY_CITATION_UNKNOWN" and "as they were before any change" in result["reason"]
    assert (await checked.proposer(work, "developer", COMMIT)(**STATEMENT | {"citations": ["../outside.py"]}))["code"] == "INVALID_CITATION"
    missing, _ = memory(work, indexed=False)
    assert (await missing.proposer(work, "analyst", COMMIT)(**STATEMENT))["code"] == "MEMORY_PROVENANCE"

    # A fault that is not about the proposal still surfaces.
    async def broken(item, embedding):
        raise DomainError("MEMORY_STORE_UNAVAILABLE", "Synthetic store fault", 503)

    faulty, _ = memory(work, create=broken)
    with pytest.raises(DomainError) as error:
        await faulty.proposer(work, "analyst", COMMIT)(**STATEMENT)
    assert error.value.code == "MEMORY_STORE_UNAVAILABLE"


async def test_only_the_runs_own_specialists_may_anchor_a_memory_to_a_run_that_did_not_deliver():
    work = running()
    service, repository = memory(work)

    def request():
        return MemoryCreate(project_id="project-one", kind="fact", content="Prices are stored in cents", source_commit=COMMIT, source_work_id="run-1")

    accepted = await service.propose(request(), proposed_by=ProposedBy(channel="factory", role="reviewer", work_id="run-1"))
    assert not accepted.active and accepted.evidence_digest == DIGEST
    for proposer in (ProposedBy(channel="owner_console"), ProposedBy(channel="supervisor_chat", work_id="run-1"),
                     ProposedBy(channel="factory", role="repair", work_id="run-1"), ProposedBy(channel="factory", role="analyst", work_id="another-run"),
                     ProposedBy(channel="factory", role="qa", work_id="run-1"), None):
        with pytest.raises(DomainError) as error:
            await service.propose(request(), proposed_by=proposer)
        assert error.value.code == "MEMORY_PROVENANCE"
    foreign, _ = memory(SimpleNamespace(id="run-1", project_id="project-two", status="running", evidence=None))
    with pytest.raises(DomainError):
        await foreign.propose(request(), proposed_by=ProposedBy(channel="factory", role="analyst", work_id="run-1"))
    unindexed, _ = memory(work, indexed=False)
    with pytest.raises(DomainError):
        await unindexed.propose(request(), proposed_by=ProposedBy(channel="factory", role="analyst", work_id="run-1"))


class Scripted(BaseChatModel):
    _turns: list = PrivateAttr(default_factory=list)
    _seen: list = PrivateAttr(default_factory=list)

    @property
    def _llm_type(self):
        return "sabre-test-proposals"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._seen.append(messages)
        message = AIMessage(content="", tool_calls=self._turns.pop(0))
        message.usage_metadata = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
        return ChatResult(generations=[ChatGeneration(message=message)])


def scripted(*turns):
    model = Scripted()
    model._turns = list(turns)
    return model


def system_prompt(model):
    return next(message.content for message in model._seen[0] if message.type == "system")


RESULT = [{"name": "AgentResult", "args": AgentResult(accepted=True, summary="Requirements inspected").model_dump(mode="json"),
           "id": "structured-result", "type": "tool_call"}]


async def test_the_tool_reaches_a_specialist_only_when_the_workflow_supplies_it():
    work, project, config = setup()
    handler = AsyncMock(return_value={"proposed": True, "memory_id": "m1", "state": "waiting for the owner's review", "remaining_in_assignment": 2})
    model = scripted([{"name": PROPOSE_TOOL, "args": STATEMENT, "id": "propose-1", "type": "tool_call"}], RESULT)
    team = AgentTeam(config, Repository(), Executor(), SecretGuard(), model_factory=lambda: model)
    result = await team.run("analyst", work, project, "Inspect the requirements", memory_tools={PROPOSE_TOOL: handler})
    assert result.summary == "Requirements inspected"
    handler.assert_awaited_once_with(**STATEMENT)
    reply = next(message for message in model._seen[1] if isinstance(message, ToolMessage))
    assert json.loads(reply.content)["proposed"] is True
    assert PROPOSE_GUIDANCE in system_prompt(model)
    # Without the tool the prompt does not mention it, and a call to it is not dispatched.
    silent = scripted(RESULT)
    plain = AgentTeam(config, Repository(), Executor(), SecretGuard(), model_factory=lambda: silent)
    await plain.run("analyst", work, project, "Inspect the requirements")
    assert "propose_memory" not in system_prompt(silent)


async def test_the_workflow_offers_the_tool_to_the_analyst_developer_and_reviewer_only(build_factory):
    factory, repo, team, executor, *_ = build_factory()
    offered = {}

    async def run(role, work, project, instruction, **kwargs):
        offered[role] = kwargs["memory_tools"].get(PROPOSE_TOOL)
        return AgentResult(accepted=True, summary="Done")

    team.run = run
    project = await repo.project(repo.current.project_id)
    for role in ("analyst", "developer", "reviewer", "qa", "security", "supervisor", "architect"):
        await factory.role(role, repo.current, project, "Do the assignment")
    # The test memory has no proposer: a memory service without one offers nothing.
    assert offered == dict.fromkeys(offered, None)
    proposers = []

    def proposer(work, role, commit):
        proposers.append((work.id, role, commit))
        return AsyncMock()

    factory.memory.proposer = proposer
    for role in ("analyst", "developer", "reviewer", "qa", "security", "supervisor", "architect"):
        await factory.role(role, repo.current, project, "Do the assignment")
    snapshot = await executor.snapshot(repo.current.id)
    assert proposers == [(repo.current.id, role, snapshot["base_commit"]) for role in ("analyst", "developer", "reviewer")]
    assert {role for role, tool in offered.items() if tool is not None} == {"analyst", "developer", "reviewer"}


async def test_the_run_audit_counts_the_memories_each_agent_proposed():
    service, _, saver, work, _ = audit_fixture()
    ai = AIMessage(id="turn", content="", tool_calls=[{"name": PROPOSE_TOOL, "id": "p1", "args": STATEMENT},
                                                     {"name": PROPOSE_TOOL, "id": "p2", "args": STATEMENT}])
    accepted = ToolMessage(tool_call_id="p1", content=json.dumps({"proposed": True, "memory_id": "m1"}))
    refused = ToolMessage(tool_call_id="p2", content=json.dumps({"proposed": False, "code": "MEMORY_PROPOSAL_LIMIT"}))
    saver.aget_tuple.return_value = checkpoint([ai, accepted, refused])
    report = await service.audit(work.id)
    assert report.agents[0].memories_proposed == 1
    assert [tool.name for tool in report.tools] == [PROPOSE_TOOL, PROPOSE_TOOL]

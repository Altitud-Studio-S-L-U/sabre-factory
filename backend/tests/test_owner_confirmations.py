"""High-impact MCP requests stay proposals until the owner decides them in the console."""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from mcp import Client

from sabre.budget_contracts import BudgetAmendment, BudgetReconciliation, MetricBudget, legacy_policy
from sabre.mcp_server import build_mcp
from sabre.models import (
    Answer,
    Budget,
    CallBudgetIncrease,
    CliProgressLimitsChange,
    DomainError,
    HumanQuestion,
    SecurityExceptionCreate,
    Status,
    TokenBudgetIncrease,
    WorkOrder,
    new_id,
)
from sabre.owner_confirmations import (
    PENDING_HOURS,
    PENDING_LIMIT,
    ConfirmationDecision,
    OwnerConfirmations,
)
from sabre.repo_creation import RepoCreationProposal, RepoCreationRequest
from sabre.security import SecretGuard
from tests.test_panel_sessions import BEARER, ORIGIN, UI, WRITE, SessionRepository, application, exchange


class MemoryConfirmations:
    """In-memory stand-in with the rules of the PostgreSQL store."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self.clock = datetime.now(UTC)

    def _expire(self):
        for row in self.rows.values():
            if row["state"] == "pending" and row["expires_at"] <= self.clock:
                row["state"] = "expired"

    async def add(self, kind, work_id, source, request, request_digest, summary):
        self._expire()
        for row in self.rows.values():
            if row["state"] == "pending" and (row["kind"], row["work_id"], row["request_digest"]) == (kind, work_id, request_digest):
                return row, False
        if sum(row["state"] == "pending" for row in self.rows.values()) >= PENDING_LIMIT:
            raise DomainError("CONFIRMATION_QUEUE_FULL", "Too many requests are waiting for the owner; wait for a decision", 429)
        row = {"id": new_id(), "kind": kind, "work_id": work_id, "source": source, "request": json.loads(json.dumps(request)),
               "request_digest": request_digest, "summary": summary, "state": "pending", "error_code": None,
               "error_message": None, "created_at": self.clock, "expires_at": self.clock + timedelta(hours=PENDING_HOURS),
               "decided_at": None}
        self.rows[row["id"]] = row
        return row, True

    async def page(self):
        self._expire()
        pending = [row for row in self.rows.values() if row["state"] == "pending"]
        return [*pending, *[row for row in self.rows.values() if row["state"] != "pending"]], len(pending)

    async def get(self, identifier):
        return self.rows.get(identifier)

    async def claim(self, identifier, request_digest, state):
        row = self.rows.get(identifier)
        if not row or row["request_digest"] != request_digest or row["state"] != "pending" or row["expires_at"] <= self.clock:
            return None
        row["state"], row["decided_at"] = state, self.clock
        return row

    async def finish(self, identifier, state, code, message):
        row = self.rows[identifier]
        assert row["state"] == "applying"
        row["state"], row["error_code"], row["error_message"] = state, code, message
        return row


OPERATIONS = {
    "budget.tokens": ("increase_token_budget", TokenBudgetIncrease(expected_revision=1, expected_max_tokens=100000, max_tokens=250000),
                      "Raise the token limit from 100,000 to 250,000"),
    "budget.calls": ("increase_call_budget", CallBudgetIncrease(expected_revision=1, expected_max_calls=40, max_calls=80),
                     "Raise the model call limit from 40 to 80"),
    "budget.cli_progress": ("use_cli_progress_limits", CliProgressLimitsChange(expected_revision=1, expected_budget=Budget()),
                            "Replace the cumulative quotas with CLI progress controls"),
    "budget.amend": ("amend_budget", BudgetAmendment(version=1, expected_revision=2, metric="tokens",
                         policy=MetricBudget(primary=300000, reserve=50000, absolute=350000), reason="Verification needs more context", resume=True),
                     "Change the token budget to 300,000 plus a reserve of 50,000, then resume the run"),
    "budget.reconcile": ("reconcile_budget_usage", BudgetReconciliation(version=1, expected_revision=2, usage_ids=["usage-1"],
                             reason="The provider confirmed the call never ran"),
                         "Reconcile 1 uncertain usage record"),
    "security.exception": ("approve_security_exception", SecurityExceptionCreate(fingerprint="finding-1",
                               justification="Owner accepts temporary exposure while the fix is scheduled",
                               expires_at=datetime(2026, 12, 1, 9, 30, tzinfo=UTC), snapshot_digest="a" * 64,
                               rules_version="sabre-security-v1", plan_revision=1),
                           "Accept security finding finding-1 until 2026-12-01"),
}


def fixture(status=Status.BLOCKED):
    work = WorkOrder(project_id="fixture", mode="patch", objective="Correct empty input", acceptance=["Returns zero"],
                     budget=Budget(), idempotency_key=new_id(), status=status)
    applied, events = [], []
    store = MemoryConfirmations()

    async def get_work(work_id):
        if work_id != work.id:
            raise DomainError("WORK_NOT_FOUND", "Work order not found", 404)
        return work

    async def event(order, kind, message):
        events.append((order.id, kind, message))

    def operation(name):
        async def apply(work_id, request):
            applied.append((name, work_id, request))
            return work
        return apply

    service = SimpleNamespace(guard=SecretGuard(["synthetic-owner-panel-token-long-enough"]),
        repository=SimpleNamespace(work=get_work, event=event),
        **{name: operation(name) for name, _request, _summary in OPERATIONS.values()})
    service.owner_confirmations = lambda: OwnerConfirmations(service, store)
    return service, work, store, applied, events


def decision(confirmation):
    return ConfirmationDecision(version=1, request_digest=confirmation.request_digest)


@pytest.mark.parametrize("kind", list(OPERATIONS))
async def test_request_is_only_a_proposal_and_confirmation_applies_the_exact_request_once(kind):
    name, request, summary = OPERATIONS[kind]
    service, work, _store, applied, events = fixture()
    manager = service.owner_confirmations()
    pending = await manager.request(kind, work.id, request)
    assert pending.state == "pending" and pending.summary == summary and pending.source == "mcp"
    assert pending.request == request.model_dump(mode="json")
    assert applied == []
    assert [item[1] for item in events] == ["owner_confirmation_requested"]
    confirmed = await manager.confirm(pending.id, decision(pending))
    assert confirmed.state == "applied" and confirmed.decided_at is not None
    assert applied == [(name, work.id, request)]
    for repeat in (manager.confirm, manager.reject):
        with pytest.raises(DomainError) as error:
            await repeat(pending.id, decision(pending))
        assert error.value.code == "CONFIRMATION_CLOSED"
    assert len(applied) == 1


async def test_repeated_request_reuses_the_pending_proposal_and_notifies_once():
    service, work, store, _applied, events = fixture()
    manager = service.owner_confirmations()
    request = OPERATIONS["budget.tokens"][1]
    first = await manager.request("budget.tokens", work.id, request)
    second = await manager.request("budget.tokens", work.id, request)
    other = await manager.request("budget.tokens", work.id, request.model_copy(update={"max_tokens": 300000}))
    assert first.id == second.id != other.id
    assert len(store.rows) == 2 and len(events) == 2
    page = await manager.list()
    assert page.pending == 2 and {item.id for item in page.items} == {first.id, other.id}


async def test_rejection_never_runs_the_operation():
    service, work, _store, applied, _events = fixture()
    manager = service.owner_confirmations()
    pending = await manager.request("security.exception", work.id, OPERATIONS["security.exception"][1])
    rejected = await manager.reject(pending.id, decision(pending))
    assert rejected.state == "rejected" and applied == []
    with pytest.raises(DomainError) as error:
        await manager.confirm(pending.id, decision(pending))
    assert error.value.code == "CONFIRMATION_CLOSED" and applied == []


async def test_decision_must_name_the_displayed_request():
    service, work, _store, applied, _events = fixture()
    manager = service.owner_confirmations()
    pending = await manager.request("budget.calls", work.id, OPERATIONS["budget.calls"][1])
    with pytest.raises(DomainError) as error:
        await manager.confirm(pending.id, ConfirmationDecision(version=1, request_digest="0" * 64))
    assert error.value.code == "CONFIRMATION_CHANGED"
    with pytest.raises(DomainError) as missing:
        await manager.confirm("unknown", decision(pending))
    assert missing.value.code == "CONFIRMATION_NOT_FOUND" and missing.value.status_code == 404
    assert applied == [] and (await manager.get(pending.id)).state == "pending"


async def test_expired_proposal_cannot_be_confirmed_and_does_not_block_a_new_one():
    service, work, store, applied, _events = fixture()
    manager = service.owner_confirmations()
    request = OPERATIONS["budget.tokens"][1]
    stale = await manager.request("budget.tokens", work.id, request)
    store.clock += timedelta(hours=PENDING_HOURS)
    with pytest.raises(DomainError) as error:
        await manager.confirm(stale.id, decision(stale))
    assert error.value.code == "CONFIRMATION_CLOSED" and applied == []
    fresh = await manager.request("budget.tokens", work.id, request)
    assert fresh.id != stale.id and fresh.state == "pending"
    assert store.rows[stale.id]["state"] == "expired"


async def test_refused_operation_is_recorded_and_unknown_outcome_is_never_retried():
    service, work, store, _applied, _events = fixture()
    manager = service.owner_confirmations()

    async def stale_plan(work_id, request):
        raise DomainError("STALE_BUDGET", "The budget changed; refresh before increasing it")

    service.increase_token_budget = stale_plan
    refused = await manager.request("budget.tokens", work.id, OPERATIONS["budget.tokens"][1])
    result = await manager.confirm(refused.id, decision(refused))
    assert (result.state, result.error_code, result.error_message) == ("failed", "STALE_BUDGET", "The budget changed; refresh before increasing it")

    async def crash(work_id, request):
        raise RuntimeError("connection lost")

    service.increase_call_budget = crash
    uncertain = await manager.request("budget.calls", work.id, OPERATIONS["budget.calls"][1])
    with pytest.raises(RuntimeError):
        await manager.confirm(uncertain.id, decision(uncertain))
    assert store.rows[uncertain.id]["state"] == "applying"
    with pytest.raises(DomainError) as error:
        await manager.confirm(uncertain.id, decision(uncertain))
    assert error.value.code == "CONFIRMATION_CLOSED"


@pytest.mark.parametrize("kind", ["budget.tokens", "budget.calls", "budget.cli_progress"])
async def test_a_flat_limit_request_for_a_run_with_a_budget_policy_is_refused_when_filed(kind):
    service, work, store, applied, events = fixture()
    work.effective_budget_policy = legacy_policy(work.budget, 2)
    manager = service.owner_confirmations()
    with pytest.raises(DomainError) as error:
        await manager.request(kind, work.id, OPERATIONS[kind][1])
    assert error.value.code == "VERSIONED_BUDGET_REQUIRED" and "sabre_amend_budget" in error.value.message
    assert store.rows == {} and events == [] and applied == [], "nothing is left for the owner to confirm"
    amended = await manager.request("budget.amend", work.id, OPERATIONS["budget.amend"][1])
    assert amended.state == "pending"


async def test_request_refuses_finished_work_secrets_mismatched_input_and_a_full_queue():
    service, work, store, _applied, events = fixture(Status.CANCELLED)
    manager = service.owner_confirmations()
    with pytest.raises(DomainError) as error:
        await manager.request("budget.tokens", work.id, OPERATIONS["budget.tokens"][1])
    assert error.value.code == "WORK_TERMINAL"

    service, work, store, _applied, events = fixture()
    manager = service.owner_confirmations()
    leaking = OPERATIONS["budget.amend"][1].model_copy(update={"reason": "use synthetic-owner-panel-token-long-enough"})
    with pytest.raises(DomainError):
        await manager.request("budget.amend", work.id, leaking)
    with pytest.raises(DomainError) as mismatch:
        await manager.request("budget.tokens", work.id, OPERATIONS["budget.calls"][1])
    assert mismatch.value.code == "CONFIRMATION_INVALID"
    with pytest.raises(DomainError) as missing:
        await manager.request("budget.tokens", "unknown", OPERATIONS["budget.tokens"][1])
    assert missing.value.code == "WORK_NOT_FOUND"
    assert store.rows == {} and events == []
    for index in range(PENDING_LIMIT):
        await manager.request("budget.tokens", work.id, TokenBudgetIncrease(expected_revision=1, expected_max_tokens=100000, max_tokens=100001 + index))
    with pytest.raises(DomainError) as full:
        await manager.request("budget.tokens", work.id, TokenBudgetIncrease(expected_revision=1, expected_max_tokens=100000, max_tokens=900000))
    assert full.value.code == "CONFIRMATION_QUEUE_FULL" and len(store.rows) == PENDING_LIMIT


MCP_CALLS = {
    "sabre_increase_token_budget": ("budget.tokens", "change"),
    "sabre_increase_call_budget": ("budget.calls", "change"),
    "sabre_use_cli_progress_limits": ("budget.cli_progress", "change"),
    "sabre_amend_budget": ("budget.amend", "request"),
    "sabre_reconcile_budget": ("budget.reconcile", "request"),
    "sabre_approve_security_exception": ("security.exception", "request"),
}


@pytest.mark.parametrize("tool", list(MCP_CALLS))
async def test_mcp_high_impact_tools_only_file_a_request(tool):
    kind, argument = MCP_CALLS[tool]
    service, work, store, applied, _events = fixture()
    async with Client(build_mcp(lambda: service)) as client:
        response = await client.call_tool(tool, {"work_id": work.id, argument: OPERATIONS[kind][1].model_dump(mode="json")})
        assert not response.is_error
        filed = response.structured_content
        assert filed["state"] == "pending" and filed["kind"] == kind and filed["summary"] == OPERATIONS[kind][2]
        read = await client.call_tool("sabre_confirmation", {"confirmation_id": filed["id"]})
        assert read.structured_content == filed
        listed = await client.call_tool("sabre_confirmations", {})
        assert listed.structured_content["pending"] == 1
    assert applied == [] and list(store.rows) == [filed["id"]]


async def test_mcp_cannot_decide_a_request_or_change_a_budget_through_a_command():
    service, work, store, applied, _events = fixture()
    dispatched = []
    service.repository.begin_command = lambda *args: dispatched.append(args)
    async with Client(build_mcp(lambda: service)) as client:
        names = {tool.name for tool in (await client.list_tools()).tools}
        assert {name for name in names if "confirm" in name} == {"sabre_confirmations", "sabre_confirmation"}
        for payload in (
            {"type": "work.budget.amend", "work_id": work.id, "request": OPERATIONS["budget.amend"][1].model_dump(mode="json")},
            {"type": "work.budget.reconcile", "work_id": work.id, "request": OPERATIONS["budget.reconcile"][1].model_dump(mode="json")},
        ):
            response = await client.call_tool("sabre_command", {"command": {"version": 1, "idempotency_key": "budget-command-1",
                "correlation_id": "budget-command-1", "payload": payload}})
            assert response.is_error and response.content[0].text.startswith("OWNER_CONFIRMATION_REQUIRED: ")
    assert applied == [] and dispatched == [] and store.rows == {}


class ConsoleService:
    def __init__(self, service):
        self.repository = SessionRepository()
        self.inner = service

    def owner_confirmations(self):
        return self.inner.owner_confirmations()


async def test_only_a_paired_browser_decides_and_the_owner_credential_alone_is_refused():
    service, work, _store, applied, _events = fixture()
    pending = await service.owner_confirmations().request("budget.tokens", work.id, OPERATIONS["budget.tokens"][1])
    other = await service.owner_confirmations().request("budget.calls", work.id, OPERATIONS["budget.calls"][1])
    body = {"version": 1, "request_digest": pending.request_digest}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(application(ConsoleService(service))), base_url=ORIGIN) as client:
        listed = await client.get("/api/v1/confirmations", headers=BEARER)
        assert listed.status_code == 200 and listed.json()["pending"] == 2
        for action in ("confirm", "reject"):
            refused = await client.post(f"/api/v1/confirmations/{pending.id}/{action}", headers=BEARER, json=body)
            assert refused.status_code == 403 and refused.json()["code"] == "CONSOLE_CONFIRMATION_REQUIRED"
        assert applied == []
        _, session = await exchange(client)
        without_csrf = await client.post(f"/api/v1/confirmations/{pending.id}/confirm", headers=WRITE, json=body)
        assert without_csrf.status_code == 403 and applied == []
        headers = WRITE | {"X-CSRF-Token": session.json()["csrf_token"]}
        confirmed = await client.post(f"/api/v1/confirmations/{pending.id}/confirm", headers=headers, json=body)
        assert confirmed.status_code == 200 and confirmed.json()["state"] == "applied"
        assert [item[0] for item in applied] == ["increase_token_budget"]
        again = await client.post(f"/api/v1/confirmations/{pending.id}/confirm", headers=headers, json=body)
        assert again.status_code == 409 and again.json()["code"] == "CONFIRMATION_CLOSED"
        rejected = await client.post(f"/api/v1/confirmations/{other.id}/reject", headers=headers,
                                     json={"version": 1, "request_digest": other.request_digest})
        assert rejected.status_code == 200 and rejected.json()["state"] == "rejected"
        page = (await client.get("/api/v1/confirmations", headers=UI)).json()
        assert page["pending"] == 0 and {item["state"] for item in page["items"]} == {"applied", "rejected"}
    assert len(applied) == 1


def decision_fixture(kind="architecture"):
    service, work, store, applied, events = fixture(Status.WAITING_INPUT)
    question = HumanQuestion(work_id=work.id, plan_revision=work.plan_revision, kind=kind,
                             prompt="Approve the proposed architecture: one service, PostgreSQL, no queue?", options=["Approve", "Revise"])
    work.questions = [question]
    answered = []

    async def answer(work_id, request):
        answered.append((work_id, request))
        return work

    service.answer = answer
    return service, work, question, store, answered, events


async def test_an_answer_to_an_owner_decision_is_filed_with_its_question_and_applied_on_confirmation():
    service, work, question, _store, answered, events = decision_fixture()
    manager = service.owner_confirmations()
    answer = Answer(question_id=question.id, plan_revision=work.plan_revision, answer="Approve")
    pending = await manager.request_answer(work.id, answer)
    assert pending.kind == "question.answer" and pending.state == "pending" and answered == []
    assert pending.summary == 'Answer "Approve" to the architecture decision: Approve the proposed architecture: one service, PostgreSQL, no queue?'
    assert len(events) == 1
    confirmed = await manager.confirm(pending.id, decision(pending))
    assert confirmed.state == "applied" and answered == [(work.id, answer)]
    for stale in (answer.model_copy(update={"plan_revision": work.plan_revision + 1}), answer.model_copy(update={"question_id": "unknown"})):
        with pytest.raises(DomainError) as error:
            await manager.request_answer(work.id, stale)
        assert error.value.code == "QUESTION_CLOSED"
    question.kind = "clarification"
    with pytest.raises(DomainError) as error:
        await manager.request_answer(work.id, answer)
    assert error.value.code == "OWNER_DECISION_NOT_REQUIRED"
    assert len(answered) == 1


@pytest.mark.parametrize("kind", ["architecture", "permission", "scope", "exception"])
async def test_mcp_cannot_answer_an_owner_decision_directly_or_through_the_native_prompt(kind):
    service, work, question, store, answered, _events = decision_fixture(kind)
    arguments = {"work_id": work.id, "answer": {"question_id": question.id, "plan_revision": work.plan_revision, "answer": "Approve"}}

    async def unexpected(context, params):
        pytest.fail("An owner decision must not be asked through the MCP client")

    async with Client(build_mcp(lambda: service), elicitation_callback=unexpected) as client:
        direct = await client.call_tool("sabre_answer_question", arguments)
        assert direct.is_error and direct.content[0].text.startswith("OWNER_CONFIRMATION_REQUIRED: ")
        native = await client.call_tool("sabre_resolve_question_native", {"work_id": work.id, "question_id": question.id, "plan_revision": work.plan_revision})
        assert native.is_error and native.content[0].text.startswith("OWNER_CONFIRMATION_REQUIRED: ")
        assert answered == [] and store.rows == {}
        filed = await client.call_tool("sabre_propose_answer", arguments)
        assert not filed.is_error and filed.structured_content["state"] == "pending" and filed.structured_content["kind"] == "question.answer"
    assert answered == [] and len(store.rows) == 1


async def test_mcp_still_answers_a_clarification_directly():
    service, work, question, store, answered, _events = decision_fixture("clarification")
    arguments = {"work_id": work.id, "answer": {"question_id": question.id, "plan_revision": work.plan_revision, "answer": "It must return zero"}}
    async with Client(build_mcp(lambda: service)) as client:
        response = await client.call_tool("sabre_answer_question", arguments)
        assert not response.is_error
        refused = await client.call_tool("sabre_propose_answer", arguments)
        assert refused.is_error and refused.content[0].text.startswith("OWNER_DECISION_NOT_REQUIRED: ")
    assert len(answered) == 1 and store.rows == {}


REPOSITORY = {"owner_type": "org", "owner": "example", "name": "new-service", "visibility": "private",
              "description": "", "initialize": True, "idempotency_key": "repository-key-1"}


def repository_fixture():
    service, _work, store, _applied, events = fixture()
    decided = []
    proposal = RepoCreationProposal(id="proposal-1", request=RepoCreationRequest(**REPOSITORY), request_digest="b" * 64, status="proposed",
        revision=0, created_at=datetime.now(UTC), updated_at=datetime.now(UTC), approved_at=None, started_at=None, receipt=None,
        candidate=None, error_code=None)

    async def get(proposal_id):
        if proposal_id != proposal.id:
            raise DomainError("REPOSITORY_PROPOSAL_NOT_FOUND", "The proposal does not exist", 404)
        return proposal

    async def decide(proposal_id, request):
        decided.append((proposal_id, request))
        return proposal

    service.repository_proposals = lambda: SimpleNamespace(get=get, decide=decide)
    return service, store, decided, events


async def test_repository_creation_over_mcp_waits_for_the_owner_while_a_rejection_does_not(monkeypatch):
    service, store, decided, events = repository_fixture()
    launched = []

    async def launch(current, request):
        launched.append(request)

    monkeypatch.setattr("sabre.owner_confirmations.launch_create", launch)
    approve = {"expected_revision": 0, "request_digest": "b" * 64, "decision": "approve"}
    launch_request = {"version": 1, "authorize_repository_creation": True, "repository": REPOSITORY, "profile": "python",
                      "gate_commands": [["python", "-m", "unittest"]], "objective": "Create the billing service skeleton",
                      "acceptance": ["The registered tests pass"], "budget": Budget().model_dump(mode="json")}
    async with Client(build_mcp(lambda: service)) as client:
        refused = await client.call_tool("sabre_decide_repository", {"proposal_id": "proposal-1", "decision": approve})
        assert refused.is_error and refused.content[0].text.startswith("OWNER_CONFIRMATION_REQUIRED: ") and decided == []
        rejected = await client.call_tool("sabre_decide_repository", {"proposal_id": "proposal-1", "decision": approve | {"decision": "reject"}})
        assert not rejected.is_error and [item[1].decision for item in decided] == ["reject"]
        filed = await client.call_tool("sabre_propose_repository_approval", {"proposal_id": "proposal-1", "decision": approve})
        assert filed.structured_content["summary"] == "Approve creating the private repository example/new-service"
        assert filed.structured_content["work_id"] is None and filed.structured_content["kind"] == "repository.decide"
        only_approvals = await client.call_tool("sabre_propose_repository_approval", {"proposal_id": "proposal-1", "decision": approve | {"decision": "reject"}})
        assert only_approvals.is_error
        missing = await client.call_tool("sabre_propose_repository_approval", {"proposal_id": "unknown", "decision": approve})
        assert missing.is_error
        create = await client.call_tool("sabre_launch_create", {"request": launch_request})
        assert create.structured_content["state"] == "pending" and create.structured_content["kind"] == "repository.launch"
        assert create.structured_content["summary"] == "Create the private repository example/new-service and start a create run: Create the billing service skeleton"
    assert len(decided) == 1 and launched == [] and events == [] and len(store.rows) == 2
    manager = service.owner_confirmations()
    page = await manager.list()
    for item in page.items:
        assert (await manager.confirm(item.id, decision(item))).state == "applied"
    assert [item[1].decision for item in decided] == ["reject", "approve"] and decided[1][0] == "proposal-1"
    assert len(launched) == 1 and launched[0].repository.name == "new-service" and launched[0].authorize_repository_creation is True

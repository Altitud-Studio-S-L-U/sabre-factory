"""Operational log lines: what is written, with which identifiers, and that no payload travels in them."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import openai
import pytest

from sabre.agents import GuardedCalls
from sabre.executor import ExecutorClient
from sabre.logs import EVENTS, NUMBER_FIELDS, TEXT_FIELDS, log, owner_decision, record
from sabre.models import DomainError, Status
from sabre.security import SecretGuard
from sabre.telemetry import span, trace_identifiers
from tests.test_agents import Repository as AgentRepository
from tests.test_agents import setup as agent_fixture
from tests.test_error_boundaries import fixture_request
from tests.test_factory_workflow import build_factory as build_factory
from tests.test_provider_failures import sdk_error
from tests.test_trace_conventions import recorded as recorded

ALLOWED = {"ts", "event", "trace_id", "span_id"} | TEXT_FIELDS | NUMBER_FIELDS
SECRET = "synthetic-private-text-20261114"


def lines(capsys) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().err.splitlines() if line.startswith("{")]


def test_a_line_keeps_identifiers_codes_and_counts_and_nothing_else():
    line = record("stage.failed", work_id="run-1", phase="verification", error_code="CHECK_FAILED", duration_ms=1200,
                  message=f"the owner wrote {SECRET}", objective=SECRET, role="a role with spaces", attempt=True,
                  plan_revision=-1, kind=SECRET + " and more")
    assert line is not None
    assert {key: value for key, value in line.items() if key != "ts"} == {
        "event": "stage.failed", "work_id": "run-1", "phase": "verification", "error_code": "CHECK_FAILED", "duration_ms": 1200}
    assert set(line) <= ALLOWED and SECRET not in json.dumps(line)
    # An event the factory does not log produces no line at all.
    assert record("anything.else", work_id="run-1") is None


def test_a_line_names_the_trace_it_belongs_to(recorded, capsys):
    with span("workflow.stage", phase="analysis", work_id="run-1"):
        current = trace_identifiers()
        log("stage.started", work_id="run-1", phase="analysis")
    log("stage.completed", work_id="run-1", phase="analysis", duration_ms=5)
    inside, outside = lines(capsys)
    assert (inside["trace_id"], inside["span_id"]) == (current["trace_id"], current["span_id"])
    assert "trace_id" not in outside and outside["duration_ms"] == 5


def test_a_stream_that_cannot_be_written_changes_nothing(monkeypatch):
    monkeypatch.setattr("sabre.logs.sys.stderr", SimpleNamespace(write=lambda text: 1 / 0, flush=lambda: None))
    log("stage.started", work_id="run-1", phase="analysis")


async def test_a_run_logs_each_stage_change_without_its_content(build_factory, capsys):
    factory, repo, *_ = build_factory()
    capsys.readouterr()
    result = await factory.drive(repo.current.id)
    assert result.status == Status.COMPLETED
    written = lines(capsys)
    stages = [line for line in written if line["event"].startswith("stage.")]
    assert stages and all(line["work_id"] == repo.current.id and line["phase"] for line in stages)
    started = [line["phase"] for line in stages if line["event"] == "stage.started"]
    completed = [line["phase"] for line in stages if line["event"] == "stage.completed"]
    # Every stage that started is seen to end, in order, with how long it took.
    assert started == completed and len(started) >= 5
    assert all(type(line["duration_ms"]) is int for line in stages if line["event"] == "stage.completed")
    assert all(set(line) <= ALLOWED and line["event"] in EVENTS for line in written)
    assert repo.current.objective not in json.dumps(written)


async def test_a_failed_model_call_is_logged_by_its_class_and_never_by_the_providers_text(capsys):
    work, _, config = agent_fixture()
    middleware = GuardedCalls(AgentRepository(), config, work, SecretGuard([SECRET]), role="analyst", child_id=f"{work.id}/r1/analyst/{'a' * 64}")
    middleware.sleep = AsyncMock()
    capsys.readouterr()
    with pytest.raises(DomainError):
        await middleware.awrap_model_call(fixture_request(), AsyncMock(side_effect=[sdk_error(openai.RateLimitError, 429) for _ in range(3)]))
    failures = [line for line in lines(capsys) if line["event"] == "model.failed"]
    assert [(line["failure_class"], line["error_code"], line["role"], line["work_id"]) for line in failures] == [
        ("rate_limit", "MODEL_RATE_LIMITED", "analyst", work.id)] * 3
    assert all(len(line["agent_id"]) == 64 and set(line) <= ALLOWED for line in failures)


async def test_only_a_broker_that_could_not_do_its_work_is_an_executor_failure(capsys):
    answers = iter([httpx.Response(409, json={"code": "STALE_SNAPSHOT", "message": SECRET}),
                    httpx.Response(503, json={"code": "DOCKER_UNAVAILABLE", "message": SECRET}),
                    httpx.ConnectError(SECRET)])

    async def handle(request):
        outcome = next(answers)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    client = ExecutorClient("http://executor", "synthetic-broker-token", httpx.AsyncClient(transport=httpx.MockTransport(handle)))
    capsys.readouterr()
    for expected in ("STALE_SNAPSHOT", "DOCKER_UNAVAILABLE", "EXECUTOR_UNAVAILABLE"):
        with pytest.raises(DomainError) as error:
            await client.execute("work-1", ["python", "-V"])
        assert error.value.code == expected
    await client.aclose()
    written = lines(capsys)
    # A refused request is an answer; the unavailable broker and the lost connection are failures.
    assert [(line["event"], line["work_id"], line["error_code"]) for line in written] == [
        ("executor.failed", "work-1", "DOCKER_UNAVAILABLE"), ("executor.failed", "work-1", "EXECUTOR_UNAVAILABLE")]
    assert SECRET not in json.dumps(written)


class Decisions:
    """An object with the service's shape: the run first, then what the owner asked."""

    def __init__(self):
        self.calls = []

    @owner_decision("owner.control")
    async def control(self, work_id, command):
        if command == "explode":
            raise DomainError("INVALID_COMMAND", "Use pause, resume or cancel", 422)
        self.calls.append((work_id, command))
        return "done"

    @owner_decision("owner.answer", "answer")
    async def answer(self, work_id, request):
        return request


async def test_an_owner_decision_is_logged_once_it_was_applied_and_never_with_what_was_said(capsys):
    service = Decisions()
    capsys.readouterr()
    assert await service.control("run-1", "pause") == "done"
    assert await service.control("run-1", command="cancel") == "done"
    with pytest.raises(DomainError):
        await service.control("run-1", "explode")
    assert await service.answer("run-1", {"answer": SECRET}) == {"answer": SECRET}
    written = lines(capsys)
    assert [(line["event"], line["work_id"], line.get("decision")) for line in written] == [
        ("owner.control", "run-1", "pause"), ("owner.control", "run-1", "cancel"), ("owner.answer", "run-1", "answer")]
    assert SECRET not in json.dumps(written)


def test_the_service_logs_admission_and_every_owner_decision_it_accepts():
    from sabre.service import FactoryService

    decided = {name for name in dir(FactoryService) if getattr(getattr(FactoryService, name), "__wrapped__", None) is not None}
    assert decided == {"amend_budget", "reconcile_budget_usage", "answer", "control", "change_scope", "increase_token_budget",
                       "increase_call_budget", "use_cli_progress_limits", "approve_security_exception", "revoke_security_exception"}

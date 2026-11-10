from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from sabre.commands import CommandEnvelope, dispatch
from sabre.models import Budget, DomainError, WorkOrder
from sabre.repository import digest
from sabre.security import SecretGuard


def fixture():
    work = WorkOrder(project_id="project", mode="patch", objective="Correct the example",
        acceptance=["Checks pass"], budget=Budget(), idempotency_key="synthetic-original")
    command = CommandEnvelope(version=1, idempotency_key="synthetic-command", correlation_id="synthetic-correlation",
        payload={"type": "work.control", "work_id": work.id, "expected_revision": 1, "action": "pause"})
    repo = SimpleNamespace(begin_command=AsyncMock(return_value=None), work=AsyncMock(return_value=work), finish_effect=AsyncMock())
    return command, SimpleNamespace(repository=repo, guard=SecretGuard(), control=AsyncMock(return_value=work))


@pytest.mark.parametrize("change", [{"version": 2}, {"version": "1"}, {"version": True}, {"unknown": 1}])
def test_unsupported_commands_cannot_reach_the_service(change):
    command, _ = fixture()
    with pytest.raises(ValidationError):
        CommandEnvelope.model_validate({**command.model_dump(), **change})


async def test_repeated_command_returns_original_receipt_without_repeating_effect():
    command, service = fixture()
    first = await dispatch(service, command)
    service.repository.begin_command.return_value = {"state": "completed", "request_hash": digest(command.model_dump(mode="json")), "result": first.model_dump(mode="json")}
    repeated = await dispatch(service, command)
    assert repeated == first
    service.control.assert_awaited_once()
    assert repeated.correlation_id == command.correlation_id


async def test_uncertain_control_is_not_replayed_blindly():
    command, service = fixture()
    service.repository.begin_command.return_value = {"state": "pending", "request_hash": digest(command.model_dump(mode="json")), "result": None}
    with pytest.raises(DomainError) as error:
        await dispatch(service, command)
    assert error.value.code == "COMMAND_OUTCOME_UNCERTAIN"
    service.control.assert_not_awaited()


async def test_stale_revision_cannot_control_current_work():
    command, service = fixture()
    service.repository.work.return_value.plan_revision = 2
    with pytest.raises(DomainError) as error:
        await dispatch(service, command)
    assert error.value.code == "STALE_PLAN"
    service.control.assert_not_awaited()


async def test_reusing_a_key_for_changed_input_is_rejected():
    command, service = fixture()
    service.repository.begin_command.return_value = {"state": "completed", "request_hash": "different", "result": {}}
    with pytest.raises(DomainError) as error:
        await dispatch(service, command)
    assert error.value.code == "IDEMPOTENCY_CONFLICT"
    service.control.assert_not_awaited()

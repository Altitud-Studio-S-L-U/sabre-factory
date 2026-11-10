"""Versioned channel commands and durable receipts; execution remains in LangGraph."""

import json
from typing import Annotated, Literal

from pydantic import Field

from sabre.contracts import StrictContract
from sabre.models import Answer, DomainError, WorkOrder, WorkOrderCreate
from sabre.repository import digest


class Submit(StrictContract):
    type: Literal["work.submit"]
    request: WorkOrderCreate


class Control(StrictContract):
    type: Literal["work.control"]
    work_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=1)
    action: Literal["pause", "resume", "cancel"]


class Respond(StrictContract):
    type: Literal["work.answer"]
    work_id: str = Field(min_length=1, max_length=128)
    answer: Answer


class CommandEnvelope(StrictContract):
    version: Literal[1]
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9:._-]+$")
    correlation_id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9:._-]+$")
    payload: Annotated[Submit | Control | Respond, Field(discriminator="type")]


class CommandResult(StrictContract):
    version: Literal[1] = 1
    command_id: str
    correlation_id: str
    work_id: str
    phase: str
    work: WorkOrder


async def dispatch(service, command: CommandEnvelope) -> CommandResult:
    # Validate again at the shared boundary: adapters must not bypass strictness
    # by constructing a model without validation.
    command = CommandEnvelope.model_validate(command.model_dump(), strict=True)
    data = command.model_dump(mode="json")
    service.guard.check(data)
    repository = service.repository
    key = "command-v1:" + command.idempotency_key
    prior = await repository.begin_command(key, data)
    if prior:
        if prior["request_hash"] != digest(data):
            raise DomainError("IDEMPOTENCY_CONFLICT", "This command key belongs to different input", 409)
        if prior["state"] == "completed":
            return CommandResult.model_validate_json(json.dumps(prior["result"]))
        # A crash can separate a committed effect from its receipt. Do not
        # repeat a control or answer whose outcome cannot be established.
        if not isinstance(command.payload, Submit):
            raise DomainError("COMMAND_OUTCOME_UNCERTAIN", "Inspect current work state before issuing a new command", 409)
    operation = command.payload
    if isinstance(operation, Submit):
        work = await service.submit(operation.request.model_copy(update={"idempotency_key": command.idempotency_key}))
    elif isinstance(operation, Control):
        current = await repository.work(operation.work_id)
        if current.plan_revision != operation.expected_revision:
            raise DomainError("STALE_PLAN", "The plan changed; refresh before issuing this command", 409)
        work = await service.control(operation.work_id, operation.action)
    else:
        work = await service.answer(operation.work_id, operation.answer)
    result = CommandResult(command_id=command.idempotency_key, correlation_id=command.correlation_id,
                           work_id=work.id, phase=work.phase, work=work)
    await repository.finish_effect(key, result.model_dump(mode="json"))
    return result

"""Content-free execution events, shared by the panel and notification adapters."""

from datetime import datetime
from typing import Literal

from pydantic import Field

from sabre.contracts import StrictContract


class ExecutionEvent(StrictContract):
    version: Literal[1] = 1
    id: str
    work_id: str
    plan_revision: int = Field(ge=1)
    phase: str
    correlation_id: str
    parent_id: str | None = None
    agent_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$", exclude_if=lambda value: value is None)
    # "model" marks one failed model call: its name is the failure class and it has no "started" record.
    kind: Literal["stage", "agent", "tool", "status", "model"]
    state: Literal["started", "completed", "failed", "interrupted"]
    name: str = Field(min_length=1, max_length=200)
    timestamp: datetime
    duration_ms: int | None = Field(default=None, ge=0)
    # Size of a tool result handed back to the model; never its content.
    output_bytes: int | None = Field(default=None, ge=0, exclude_if=lambda value: value is None)
    error_code: str | None = Field(default=None, max_length=100)
    provider: str | None = None
    model: str | None = None
    trace_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    span_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{16}$")


class SequencedEvent(StrictContract):
    sequence: int = Field(ge=1)
    event: ExecutionEvent


class EventPage(StrictContract):
    items: list[SequencedEvent]
    next_cursor: int = Field(ge=0)
    has_more: bool

"""Owner conversation contracts; identity comes from transport authentication."""

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from sabre.contracts import StrictContract

OperatorAction = Literal["register_project", "submit_work", "answer_question", "control_work", "change_scope", "propose_memory", "resolve_memory"]


class OperatorMessageRequest(StrictContract):
    version: Literal[1]
    text: str = Field(min_length=1, max_length=12000)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9:._-]+$")
    work_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    allowed_actions: list[OperatorAction] = Field(default_factory=list, max_length=7)

    @field_validator("text")
    @classmethod
    def meaningful_text(cls, value):
        if not value.strip():
            raise ValueError("Write a non-empty message")
        return value

    @model_validator(mode="after")
    def distinct_grants(self):
        if len(set(self.allowed_actions)) != len(self.allowed_actions):
            raise ValueError("Action grants must be distinct")
        if self.work_id and set(self.allowed_actions) - {"answer_question", "control_work", "change_scope"}:
            raise ValueError("Run conversations may only authorize actions for that run")
        return self


class OperatorContext(OperatorMessageRequest):
    id: str
    source: Literal["web", "mcp"] = "web"

    @property
    def event_id(self):
        return self.id

    @property
    def binding(self):
        return f"operator:owner:run:{self.work_id}" if self.work_id else "operator:owner:factory"

    @property
    def conversation_id(self):
        return self.binding


class OperatorMessageView(StrictContract):
    version: Literal[1] = 1
    id: str
    source: Literal["web", "mcp"] = "web"
    work_id: str | None
    text: str
    allowed_actions: list[OperatorAction]
    state: Literal["queued", "running", "completed", "blocked"]
    reply: str | None
    error_code: str | None
    created_at: datetime


class OperatorMessagePage(StrictContract):
    items: list[OperatorMessageView]
    truncated: bool


class OperatorMessageResume(StrictContract):
    version: Literal[1]
    expected_error_code: str | None = Field(max_length=100)

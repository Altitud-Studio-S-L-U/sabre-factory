"""Provider-facing results. Internal legacy results are adapted only after validation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from pydantic import Field, model_validator

from sabre.contracts import StrictContract

if TYPE_CHECKING:
    from sabre.models import AgentResult


class PhaseResult(StrictContract):
    version: Literal[1]
    status: Literal["completed", "needs_input", "rejected"]
    summary: str = Field(min_length=1, max_length=8000)
    questions: list[str] = Field(max_length=10)
    evidence: list[str] = Field(max_length=30)

    @model_validator(mode="after")
    def questions_match_status(self):
        if bool(self.questions) != (self.status == "needs_input"):
            raise ValueError("Only needs_input results must contain questions")
        return self

    def legacy(self) -> AgentResult:
        from sabre.models import AgentResult
        return AgentResult(summary=self.summary, accepted=self.status == "completed", questions=self.questions,
                           decisions=getattr(self, "decisions", []), tasks=getattr(self, "tasks", []))


class AnalysisResult(PhaseResult):
    decisions: list[str] = Field(max_length=20)


class PlannedTask(StrictContract):
    id: str = Field(min_length=1, max_length=128)
    title: str = Field(min_length=1, max_length=300)
    role: Literal["developer"]
    specialty: Literal["general", "backend", "frontend", "infrastructure", "documentation"]
    depends_on: list[str] = Field(max_length=50)
    scope: list[str] = Field(min_length=1, max_length=30)
    acceptance: list[str] = Field(min_length=1, max_length=30)
    verification_commands: list[list[str]] = Field(min_length=1, max_length=12)


class PlanningResult(PhaseResult):
    tasks: list[PlannedTask] = Field(max_length=50)

    @model_validator(mode="after")
    def executable_plan(self):
        if self.status == "completed" and not self.tasks:
            raise ValueError("Completed plans require executable tasks")
        return self

    def legacy(self) -> AgentResult:
        from sabre.models import AgentResult, Task
        return AgentResult(summary=self.summary, accepted=self.status == "completed", questions=self.questions,
                           tasks=[Task(**task.model_dump()) for task in self.tasks])


class ImplementationResult(PhaseResult):
    changed_paths: list[str] = Field(max_length=200)


class ReviewResult(PhaseResult):
    findings: list[str] = Field(max_length=50)


RESULT_SCHEMAS: dict[str, type[PhaseResult]] = {"analyst": AnalysisResult, "architect": AnalysisResult, "supervisor": PlanningResult,
                  "developer": ImplementationResult, "qa": ReviewResult, "reviewer": ReviewResult,
                  "security": ReviewResult}

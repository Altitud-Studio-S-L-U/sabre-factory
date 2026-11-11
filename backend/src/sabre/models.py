"""Shared application contracts; OpenAPI is the source for the web client."""

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import uuid4

from pydantic import AwareDatetime, ConfigDict, Field, SecretStr, field_validator, model_validator

from sabre.browser_contracts import BrowserPreview
from sabre.budget_contracts import BudgetDenial, BudgetPolicy
from sabre.contracts import Contract
from sabre.flow_contracts import FlowConfiguration, ResolvedFlow

AwareTimestamp = Annotated[datetime, AwareDatetime()]


def new_id() -> str:
    return str(uuid4())


def now() -> datetime:
    return datetime.now(UTC)


SECRET_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"  # noqa: S105 - public ID validation pattern, not a credential


class SecretTarget(Contract):
    model_config = ConfigDict(hide_input_in_errors=True)
    id: str = Field(pattern=SECRET_ID_PATTERN)
    label: str = Field(min_length=1, max_length=200)


class SecretMetadata(Contract):
    model_config = ConfigDict(hide_input_in_errors=True)
    id: str = Field(pattern=SECRET_ID_PATTERN)
    version: int = Field(ge=1, strict=True)
    configured: bool
    updated_at: AwareTimestamp


class SecretUpsert(Contract):
    model_config = ConfigDict(hide_input_in_errors=True)
    value: SecretStr = Field(min_length=1, max_length=65536)
    expected_version: int | None = Field(default=None, ge=1, strict=True)

    @field_validator("value")
    @classmethod
    def nonempty_secret(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("The secret value cannot be empty")
        return value


class SecretDeactivate(Contract):
    model_config = ConfigDict(hide_input_in_errors=True)
    expected_version: int = Field(ge=1, strict=True)


class Status(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_INPUT = "waiting_input"
    PAUSED = "paused"
    BLOCKED = "blocked"
    FAILED = "failed"
    CANCELLED = "cancelled"
    COMPLETED = "completed"


class Budget(Contract):
    model_config = ConfigDict(strict=True, hide_input_in_errors=True)
    max_calls: int | None = Field(default=40, ge=1, le=500, description="Maximum model-adapter invocations; null uses CLI progress controls with no cumulative quota")
    max_tokens: int | None = Field(default=100000, ge=1, le=10000000)
    max_cost_usd: float = Field(default=0, ge=0, le=1000, description="API spend authorization; zero permits only invocations with no API charge recorded by SABRE")
    active_seconds: int | None = Field(default=3600, ge=60, le=86400)
    policy: BudgetPolicy | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def cumulative_limits_are_coherent(self):
        if self.policy is not None:
            return self
        caps = (self.max_calls, self.max_tokens, self.active_seconds)
        if any(cap is None for cap in caps) and (any(cap is not None for cap in caps) or self.max_cost_usd != 0):
            raise ValueError("CLI progress controls require all cumulative caps null and no API spend")
        return self

    @property
    def progress_limits(self) -> bool:
        return self.policy is None and self.max_calls is None and self.max_tokens is None and self.active_seconds is None


class ProjectCreate(Contract):
    name: str = Field(min_length=1, max_length=100)
    repository: str = Field(min_length=1, max_length=2048)
    profile: Literal["python", "node"]
    default_branch: str = Field(default="main", pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
    gate_commands: list[list[str]] = Field(min_length=1, max_length=12)
    allowed_mcp_servers: list[str] = Field(default_factory=list)
    approved_baseline: list[str] = Field(default_factory=list)
    browser_preview: BrowserPreview | None = None

    @model_validator(mode="after")
    def commands_are_argv(self):
        if any(token in self.default_branch for token in ("..", "//", "@{")) or self.default_branch.endswith(("/", ".", ".lock")) or any(part.startswith(".") for part in self.default_branch.split("/")):
            raise ValueError("Invalid Git branch name")
        if any(not cmd or any(not arg or "\x00" in arg for arg in cmd) for cmd in self.gate_commands):
            raise ValueError("Gate commands must be non-empty argv arrays")
        return self


class Project(ProjectCreate):
    id: str = Field(default_factory=new_id)
    created_at: datetime = Field(default_factory=now)


class WorkOrderCreate(Contract):
    project_id: str
    mode: Literal["create", "maintain", "patch", "audit"]
    objective: str = Field(min_length=5, max_length=12000)
    acceptance: list[str] = Field(min_length=1, max_length=30)
    constraints: list[str] = Field(default_factory=list, max_length=30)
    budget: Budget
    idempotency_key: str = Field(min_length=8, max_length=128)
    channel: Literal["web", "mcp", "slack", "api"] = "api"
    channel_thread: str | None = None
    flow_config: FlowConfiguration = Field(default_factory=FlowConfiguration)


class Task(Contract):
    id: str = Field(default_factory=new_id)
    title: str = Field(min_length=1, max_length=300)
    role: Literal["analyst", "architect", "developer", "qa", "reviewer"] = "developer"
    specialty: Literal["general", "backend", "frontend", "infrastructure", "documentation"] = "general"
    depends_on: list[str] = Field(default_factory=list)
    status: Status = Status.QUEUED
    attempts: int = 0
    result: str | None = None
    scope: list[str] = Field(default_factory=list, max_length=30)
    acceptance: list[str] = Field(default_factory=list, max_length=30)
    verification_commands: list[list[str]] = Field(default_factory=list, max_length=12)


class HumanQuestion(Contract):
    id: str = Field(default_factory=new_id)
    work_id: str
    plan_revision: int
    prompt: str
    kind: Literal["clarification", "architecture", "scope", "permission", "exception", "blocked"]
    options: list[str] = Field(default_factory=list)
    subject_digest: str | None = None
    answer: str | None = None
    answered_at: datetime | None = None


class AgentResult(Contract):
    summary: str
    tasks: list[Task] = Field(default_factory=list, max_length=50)
    questions: list[str] = Field(default_factory=list, max_length=10)
    decisions: list[str] = Field(default_factory=list, max_length=20)
    accepted: bool = Field(strict=True)


class ToolRequest(Contract):
    work_id: str
    task_id: str
    name: str
    arguments: dict[str, Any]
    operation_key: str


class SecurityFinding(Contract):
    fingerprint: str
    scanner: str
    category: Literal["secret", "vulnerability", "code", "configuration", "scanner_error"]
    severity: Literal["info", "low", "medium", "high", "critical"]
    title: str
    path: str | None = None
    reference: str | None = None
    line: int | None = Field(default=None, ge=1)
    remediation: str | None = Field(default=None, max_length=4000)
    baseline: bool = False
    exception_id: str | None = None


class SecurityExceptionScope(Contract):
    fingerprint: str = Field(min_length=1, max_length=128)
    justification: str = Field(min_length=10, max_length=4000)
    expires_at: AwareTimestamp
    snapshot_digest: str = Field(pattern=r"^[0-9a-f]{64}$")
    rules_version: str = Field(min_length=1, max_length=128)
    plan_revision: int = Field(ge=1)

    @field_validator("justification")
    @classmethod
    def meaningful_justification(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 10:
            raise ValueError("An exception needs a meaningful justification")
        return value


class SecurityExceptionCreate(SecurityExceptionScope):
    """Owner command; validity dates are checked against server time on grant."""


class SecurityException(SecurityExceptionScope):
    id: str = Field(default_factory=new_id)
    work_id: str
    project_id: str
    approved_by: Literal["owner"] = "owner"
    approved_at: AwareTimestamp = Field(default_factory=now)
    revoked_at: AwareTimestamp | None = None


class GateResult(Contract):
    command: list[str]
    exit_code: int
    output_digest: str
    snapshot_digest: str


class DeliveryEvidence(Contract):
    commit: str
    snapshot_digest: str
    profile_digest: str
    rules_version: str
    gates: list[GateResult]
    findings: list[SecurityFinding]
    review: str
    security_policy_digest: str = ""
    security_exception_ids: list[str] = Field(default_factory=list)
    source_digest: str | None = None
    branch: str | None = None
    pr_url: str | None = None


class WorkOrder(WorkOrderCreate):
    id: str = Field(default_factory=new_id)
    status: Status = Status.QUEUED
    phase: str = "intake"
    graph_version: str = "sabre-v1"
    resolved_flow: ResolvedFlow | None = None
    configuration_snapshot: dict[str, Any] | None = None
    admission_request_digest: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    effective_budget_policy: BudgetPolicy | None = None
    budget_revision: int = Field(default=0, ge=0)
    limiting_metric: str | None = None
    budget_denial: BudgetDenial | None = None
    repair_cycles_used: int = Field(default=0, ge=0)
    last_failure_fingerprint: str | None = None
    identical_failure_count: int = Field(default=0, ge=0)
    last_failure_cycle: int = Field(default=-1, ge=-1)
    plan_revision: int = 1
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)
    tasks: list[Task] = Field(default_factory=list)
    questions: list[HumanQuestion] = Field(default_factory=list)
    findings: list[SecurityFinding] = Field(default_factory=list)
    security_snapshot_digest: str | None = None
    security_rules_version: str | None = None
    evidence: DeliveryEvidence | None = None
    summary: str = "Queued"
    error_code: str | None = None
    calls_used: int = 0
    tokens_used: int = 0
    cost_usd: float = 0
    active_seconds_used: float = 0
    control: Literal["pause", "cancel"] | None = None

    @model_validator(mode="after")
    def initialize_budget_policy(self):
        if self.effective_budget_policy is None and self.budget.policy is not None:
            self.effective_budget_policy = self.budget.policy.model_copy(deep=True)
        return self


class Answer(Contract):
    question_id: str
    plan_revision: int = Field(strict=True)
    answer: str = Field(min_length=1, max_length=12000)


class ScopeChange(Contract):
    expected_revision: int
    objective: str = Field(min_length=5, max_length=12000)
    acceptance: list[str] = Field(min_length=1)


class CliProgressLimitsChange(Contract):
    expected_revision: int = Field(ge=1, strict=True)
    expected_budget: Budget


class TokenBudgetIncrease(Contract):
    expected_revision: int = Field(ge=1, strict=True)
    expected_max_tokens: int = Field(ge=1, le=10000000, strict=True)
    max_tokens: int = Field(ge=1, le=10000000, strict=True)

    @model_validator(mode="after")
    def increase_only(self):
        if self.max_tokens <= self.expected_max_tokens:
            raise ValueError("The token limit must increase")
        return self


class CallBudgetIncrease(Contract):
    expected_revision: int = Field(ge=1, strict=True)
    expected_max_calls: int = Field(ge=1, le=500, strict=True)
    max_calls: int = Field(ge=1, le=500, strict=True)

    @model_validator(mode="after")
    def increase_only(self):
        if self.max_calls <= self.expected_max_calls:
            raise ValueError("The invocation limit must increase")
        return self


class MemoryCreate(Contract):
    project_id: str
    kind: Literal["fact", "lesson"]
    content: str = Field(min_length=1, max_length=8000)
    source_commit: str
    source_work_id: str
    evidence_digest: str | None = None


class MemoryItem(MemoryCreate):
    id: str = Field(default_factory=new_id)
    active: bool = False
    created_at: datetime = Field(default_factory=now)
    approved_at: datetime | None = None
    invalidated_at: datetime | None = None


class DomainError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 409, *, budget_denial: BudgetDenial | None = None):
        self.code = code
        self.message = message
        self.status_code = status_code
        self.budget_denial = budget_denial
        super().__init__(message)

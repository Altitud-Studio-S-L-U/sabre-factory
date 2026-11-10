"""Content-free receipts bound to model reservations and their authorized child scope."""

import re
from typing import Annotated, Literal

from pydantic import ConfigDict, Field, ValidationError, model_validator

from sabre.models import Contract, DomainError

Count = Annotated[int, Field(ge=0, le=10**12, strict=True)]
ByteCount = Annotated[int, Field(ge=0, le=67_108_864, strict=True)]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$", strict=True)]
ScopeId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,128}$", strict=True)]
Role = Literal["supervisor", "analyst", "architect", "developer", "qa", "reviewer", "security"]
ModelProvider = Literal["openai", "local", "anthropic", "google", "codex_cli", "claude_cli"]


class ContextReference(Contract):
    model_config = ConfigDict(hide_input_in_errors=True, revalidate_instances="always")

    tool_call_id: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_.:-]+$", strict=True)
    tool: Literal["read_file", "read_file_range", "search_source", "list_files"]
    response_digest: Digest
    original_bytes: ByteCount
    reason: Literal["old_read", "duplicate"]


class ContextReceipt(Contract):
    model_config = ConfigDict(hide_input_in_errors=True, revalidate_instances="always")

    version: Literal[1] = 1
    policy: Literal["bounded_reads_v1"] = "bounded_reads_v1"
    child_id: str = Field(min_length=1, max_length=320, strict=True)
    work_id: ScopeId
    project_id: ScopeId
    role: Role
    plan_revision: int = Field(ge=1, le=999_999_999, strict=True)
    original_digest: Digest
    sent_digest: Digest
    original_bytes: ByteCount
    sent_bytes: ByteCount
    input_limit_bytes: int = Field(ge=1, le=67_108_864, strict=True)
    compacted_results: Count
    references: list[ContextReference] = Field(default_factory=list, max_length=128)
    references_truncated: bool = Field(default=False, strict=True)
    # Delta since the preceding reservation; None means retrieval was not measured.
    restored_pages: Count | None = None
    model_provider: ModelProvider | None = None
    model_name: str | None = Field(default=None, max_length=128, pattern=r"^[A-Za-z0-9._:/-]*$", strict=True)
    model_configuration_revision: Count | None = None

    @model_validator(mode="after")
    def consistent(self):
        expected = re.escape(f"{self.work_id}/r{self.plan_revision}/{self.role}/") + r"[a-f0-9]{64}"
        if not re.fullmatch(expected, self.child_id):
            raise ValueError("Child scope does not match the receipt")
        if self.sent_bytes > self.original_bytes or self.sent_bytes > self.input_limit_bytes:
            raise ValueError("The projected request exceeds its declared bounds")
        if self.references_truncated != (self.compacted_results > len(self.references)) or self.compacted_results < len(self.references):
            raise ValueError("Reference coverage does not match the compacted result count")
        if len({reference.tool_call_id for reference in self.references}) != len(self.references):
            raise ValueError("Reference tool calls must be unique")
        return self


class ContextPolicySummary(Contract):
    version: int
    policy: str
    input_limit_bytes: int


class ContextUsageSummary(Contract):
    requests_with_context: int
    requests_without_context: int
    original_bytes: int
    sent_bytes: int
    compacted_results: int
    restored_pages: int | None
    requests_with_restored_pages: int
    references_truncated: bool
    policies: list[ContextPolicySummary]


def checked_receipt(value, work=None) -> ContextReceipt:
    try:
        receipt = ContextReceipt.model_validate(value)
    except (ValidationError, ValueError, TypeError):
        raise DomainError("CONTEXT_RECEIPT_INVALID", "The context reference violates its contract", 422) from None
    if work is not None and (receipt.work_id != work.id or receipt.project_id != work.project_id or receipt.plan_revision != work.plan_revision):
        raise DomainError("CONTEXT_RECEIPT_SCOPE", "The context reference does not match the authorized work order and revision", 409)
    return receipt


def aggregate_receipts(values: list[dict | None], work_id: str) -> ContextUsageSummary | None:
    receipts = [checked_receipt(value) for value in values if value is not None]
    if not receipts:
        return None
    if any(receipt.work_id != work_id for receipt in receipts):
        raise DomainError("CONTEXT_RECEIPT_SCOPE", "The context record does not belong to the work order", 409)
    measured = [receipt.restored_pages for receipt in receipts if receipt.restored_pages is not None]
    policies = sorted({(receipt.version, receipt.policy, receipt.input_limit_bytes) for receipt in receipts})
    return ContextUsageSummary(requests_with_context=len(receipts), requests_without_context=len(values) - len(receipts),
        original_bytes=sum(receipt.original_bytes for receipt in receipts), sent_bytes=sum(receipt.sent_bytes for receipt in receipts),
        compacted_results=sum(receipt.compacted_results for receipt in receipts), restored_pages=sum(measured) if measured else None,
        requests_with_restored_pages=len(measured), references_truncated=any(receipt.references_truncated for receipt in receipts),
        policies=[ContextPolicySummary(version=version, policy=policy, input_limit_bytes=limit) for version, policy, limit in policies])

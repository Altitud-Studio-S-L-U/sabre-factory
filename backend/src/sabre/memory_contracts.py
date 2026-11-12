"""Owner-facing memory contracts: approval decisions, commit validity, links and recall records."""

from datetime import datetime
from typing import Literal

from pydantic import Field

from sabre.contracts import Contract

COMMIT_PATTERN = r"^[a-f0-9]{40,64}$"
ValidityBasis = Literal["source_commit", "no_citations", "citations_unchanged", "citations_changed", "owner"]


class MemoryApproval(Contract):
    """Optional owner decisions recorded with an approval; an empty body approves as proposed."""

    scope: Literal["commit", "project"] | None = Field(default=None, description="Replace the proposed scope")


class MemoryCarryForward(Contract):
    commit: str = Field(pattern=COMMIT_PATTERN, description="Indexed commit at which the owner judges the memory still valid")


class ChangedPath(Contract):
    path: str
    change: Literal["changed", "deleted"]


class MemoryValidityRecord(Contract):
    """One durable evaluation of a project memory at a commit."""

    commit: str
    state: Literal["valid", "stale"]
    basis: ValidityBasis
    changed_paths: list[ChangedPath]
    checked_at: datetime

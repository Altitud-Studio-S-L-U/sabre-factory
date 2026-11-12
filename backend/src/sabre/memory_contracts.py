"""Owner-facing memory contracts: approval decisions, commit validity, links and recall records."""

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from sabre.contracts import Contract
from sabre.models import MEMORY_ID_PATTERN

COMMIT_PATTERN = r"^[a-f0-9]{40,64}$"
ValidityBasis = Literal["source_commit", "no_citations", "citations_unchanged", "citations_changed", "owner"]


class MemoryApproval(Contract):
    """Optional owner decisions recorded with an approval; an empty body approves as proposed."""

    scope: Literal["commit", "project"] | None = Field(default=None, description="Replace the proposed scope")
    supersedes: str | None = Field(default=None, pattern=MEMORY_ID_PATTERN, description="Memory of the same project to invalidate as replaced by this one")
    related: list[str] = Field(default_factory=list, max_length=20, description="Memories of the same project to link as related")

    @field_validator("related")
    @classmethod
    def memory_ids(cls, values: list[str]) -> list[str]:
        if any(not re.fullmatch(MEMORY_ID_PATTERN, value) for value in values):
            raise ValueError("Related memories must be memory identifiers")
        return list(dict.fromkeys(values))


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


class GraphNode(Contract):
    id: str = Field(description="Typed identifier: memory:<id>, run:<work id>, commit:<sha>, file:<path> or agent:<channel>[:<role>]")
    type: Literal["memory", "run", "commit", "file", "agent"]
    label: str
    attrs: dict[str, Any]


class GraphEdge(Contract):
    source: str
    target: str
    kind: Literal["cites", "supersedes", "related", "overlaps", "from_run", "at_commit", "proposed_by"]
    attrs: dict[str, Any]


class MemoryGraph(Contract):
    """A bounded neighbourhood of project memories; edges only join nodes that are present."""

    focus: str | None
    depth: int
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    truncated: bool

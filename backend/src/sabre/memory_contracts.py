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


class RecallSelection(Contract):
    memory_id: str
    lexical_rank: int | None = Field(description="Position in the lexical (ts_rank) list, 1-based; null when not matched lexically")
    vector_rank: int | None = Field(description="Position in the pgvector list, 1-based; null without embeddings or match")
    fused_score: float | None = Field(description="Reciprocal rank fusion score: sum of 1/(60+rank) over both lists")
    bytes: int = Field(description="UTF-8 size of the excerpt placed in context")
    truncated: bool = Field(description="True when the excerpt is shorter than the memory")


class MemoryRecall(Contract):
    """What one role call retrieved from memory and why, or which saved memories the validator refused."""

    id: str
    project_id: str
    work_id: str | None
    role: str | None
    stage: str | None
    commit: str
    outcome: Literal["recalled", "refused"]
    error_code: str | None
    query_terms: list[str] = Field(description="Bounded lexical terms (at most 32) derived from the instruction and objective")
    candidates: int = Field(description="Memories retrieved before selection (at most 8)")
    selected: list[RecallSelection]
    omitted: int = Field(description="Retrieved memories left out by the four-item context limit")
    refused_memory_ids: list[str]
    bytes: int = Field(description="UTF-8 size of the memory context placed in the prompt")
    created_at: datetime


class MemoryRecallPage(Contract):
    items: list[MemoryRecall]
    next_cursor: str | None = Field(description="Pass as cursor to read older recalls; null on the last page")

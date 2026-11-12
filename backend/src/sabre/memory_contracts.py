"""Owner-facing memory contracts: approval decisions, commit validity, links and recall records."""

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from sabre.contracts import Contract
from sabre.models import MEMORY_ID_PATTERN, MemoryItem, ProposedBy

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


class MemoryValidityAt(Contract):
    """Whether a memory would be recalled at ``commit`` (the project's newest indexed commit in listings)."""

    commit: str | None
    state: Literal["valid", "stale", "unavailable"]
    reason: Literal["source_commit", "no_citations", "citations_unchanged", "citations_changed", "owner",
                    "commit_scope", "not_active", "index_missing", "not_evaluated"]
    changed_paths: list[ChangedPath]
    checked_at: datetime | None


class MemoryLinkCounts(Contract):
    """Links of each kind in either direction."""

    cites: int = 0
    supersedes: int = 0
    related: int = 0
    overlaps: int = 0


class MemoryListItem(MemoryItem):
    state: Literal["active", "pending", "invalidated"]
    validity: MemoryValidityAt
    recall_count: int
    last_recalled_at: datetime | None
    link_counts: MemoryLinkCounts


class MemoryItemPage(Contract):
    commit: str | None = Field(description="Newest indexed commit used for validity; null when the project has no index")
    items: list[MemoryListItem]
    next_cursor: str | None


class MemoryLink(Contract):
    source_id: str
    kind: Literal["cites", "supersedes", "related", "overlaps"]
    target_type: Literal["file", "memory"]
    target_id: str
    attrs: dict[str, Any]
    created_at: datetime


class MemoryProvenance(Contract):
    work_id: str
    work_objective: str | None
    work_status: str | None
    commit: str
    evidence_digest: str | None
    proposed_by: ProposedBy | None
    approved_at: datetime | None
    invalidated_at: datetime | None


class MemoryRecallStats(Contract):
    recall_count: int
    last_recalled_at: datetime | None
    refused_count: int


class MemoryDetail(Contract):
    item: MemoryListItem
    provenance: MemoryProvenance
    links: list[MemoryLink] = Field(description="Links recorded by this memory")
    backlinks: list[MemoryLink] = Field(description="Links from other memories to this one")
    validity_history: list[MemoryValidityRecord] = Field(description="Newest first, at most 50")
    recalls: MemoryRecallStats


class OverlapEntry(Contract):
    memory_id: str
    state: Literal["active", "pending", "invalidated"]
    content: str = Field(description="First 240 characters of the other memory")
    score: float
    lexical: float
    cosine: float | None
    only_this: list[str] = Field(description="Normalized terms only in the memory under review")
    only_other: list[str] = Field(description="Normalized terms only in the overlapping memory")


class PendingReview(Contract):
    item: MemoryListItem
    overlaps: list[OverlapEntry]


class StaleReview(Contract):
    item: MemoryListItem
    changed_paths: list[ChangedPath]


class MemoryReview(Contract):
    commit: str | None
    pending: list[PendingReview]
    stale: list[StaleReview]
    truncated: bool = Field(description="True when more than 100 pending or 100 stale memories exist")
